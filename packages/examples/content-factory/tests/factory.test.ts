import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { loadManifestProject } from '@stablehand/manifest/node';
import { afterEach, describe, expect, it } from 'vitest';

import { McpServerToolProvider } from '../../../stablehand/src/mcp/provider.js';
import { startNotesServer, type NotesServerHandle } from '../notes-mcp/server.ts';

interface DeslopReport {
  ok: boolean;
  issues: Array<{ rule: string; match?: string; line?: number }>;
}

const AGENTS_DIR = fileURLToPath(new URL('../agents/', import.meta.url));

async function loadAgent(dir: string) {
  return loadManifestProject(fileURLToPath(new URL(`../agents/${dir}/agent.yaml`, import.meta.url)));
}

async function deslop(text: string): Promise<DeslopReport> {
  const module = await import('../agents/writer/deslop/check.mjs') as { checkDraft: (input: string) => DeslopReport };
  return module.checkDraft(text);
}

describe('content factory manifests', () => {
  it('compiles every stage into an agent under the campaign tag', async () => {
    const dirs = (await readdir(AGENTS_DIR, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(dirs).toEqual(['editor', 'measure', 'notes-miner', 'publisher', 'scout', 'writer']);

    for (const dir of dirs) {
      const project = await loadAgent(dir);
      const input = project.agentCreateInput;
      expect(input.name, dir).toBe(`factory-${dir}`);
      expect(input.mode, dir).toBe('background');
      expect(input.metadata, dir).toMatchObject({ defaultTags: { campaign: 'content-factory' } });
      expect((input.harnessConfig as { limits?: { maxCostUsd?: number } }).limits?.maxCostUsd, dir).toBeLessThanOrEqual(0.6);
    }
  });

  it('wires each stage to the tools it needs and nothing that holds a literal token', async () => {
    const scout = (await loadAgent('scout')).agentCreateInput;
    expect(scout.mcpServers?.[0]).toMatchObject({
      name: 'apify',
      auth: { type: 'bearer', token: '$secret:APIFY_TOKEN' },
      requireApproval: false,
    });
    expect(scout.mcpServers?.[0]?.url).toContain('harvestapi/linkedin-post-search');

    const notes = (await loadAgent('notes-miner')).agentCreateInput;
    expect(notes.mcpServers?.[0]).toMatchObject({ name: 'notes', url: 'https://mcp.granola.ai/mcp', auth: { type: 'oauth' } });

    const writer = await loadAgent('writer');
    const workspaceFiles = writer.workspace.files.map((file) => file.destinationPath).sort();
    expect(workspaceFiles).toEqual([
      'deslop/LICENSE',
      'deslop/RULES.md',
      'deslop/check.mjs',
      'voice/samples.md',
    ]);

    const editor = (await loadAgent('editor')).agentCreateInput;
    expect(editor.tools).toEqual(['edit_document', 'artifact_upload']);

    for (const dir of ['scout', 'notes-miner', 'writer', 'editor', 'publisher', 'measure']) {
      const raw = await readFile(new URL(`../agents/${dir}/agent.yaml`, import.meta.url), 'utf8');
      expect(raw, dir).not.toMatch(/apify_api_|Bearer [A-Za-z0-9]{12,}/);
    }
  });
});

describe('deslop check', () => {
  it('passes the shipped voice samples', async () => {
    const samples = await readFile(new URL('../agents/writer/voice/samples.md', import.meta.url), 'utf8');
    expect(await deslop(samples)).toEqual({ ok: true, issues: [] });
  });

  it('flags the mechanical tells', async () => {
    const report = await deslop([
      "Here's the thing — agents are not just chatbots.",
      'The result? Chaos.',
      'We really leverage a robust ecosystem.',
      "It's not about speed, it's about trust.",
      '- **Bold** lead',
      '#ai #agents #llm #startups',
    ].join('\n'));
    expect(report.ok).toBe(false);
    const rules = new Set(report.issues.map((issue) => issue.rule));
    for (const rule of ['em-dash', 'phrase', 'adverb', 'not-just', 'self-answered-question', 'binary-contrast', 'bold-first-bullet', 'hashtags']) {
      expect(rules, rule).toContain(rule);
    }
  });
});

describe('notes MCP stand-in', () => {
  let server: NotesServerHandle | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('serves Granola\'s tool names to the orchestrator MCP client', async () => {
    server = await startNotesServer({ port: 0, host: '127.0.0.1' });
    const provider = new McpServerToolProvider({
      agentId: 'notes-miner',
      server: { name: 'notes', url: server.url, tools: ['list_meetings', 'get_meetings', 'get_meeting_transcript'] },
      readSecret: async () => null,
      egressPolicy: { enforce: true, allowlist: ['127.0.0.1'], allowlistOnly: false, maxRedirects: 5 },
    });
    try {
      const status = await provider.discover();
      expect(status.state).toBe('ready');
      expect(status.tools.map((tool) => [tool.name, tool.requiresApproval])).toEqual([
        ['notes__list_meetings', false],
        ['notes__get_meetings', false],
        ['notes__get_meeting_transcript', false],
      ]);
      const ctx = { agentId: 'notes-miner', conversationId: 'c', workspaceDir: '/workspace' };
      const week = JSON.parse(await provider.execute('notes__list_meetings', { time_range: 'this_week' }, ctx)) as {
        notice: string;
        meetings: Array<{ id: string; date: string }>;
      };
      expect(week.notice).toContain('Synthetic');
      expect(week.meetings.map((meeting) => meeting.id)).toEqual([
        'mtg-pricing-review',
        'mtg-agent-postmortem',
        'mtg-customer-call-northwind',
        'mtg-hiring-sync',
      ]);
      const lastWeek = JSON.parse(await provider.execute('notes__list_meetings', { time_range: 'last_week' }, ctx)) as {
        meetings: Array<{ id: string }>;
      };
      expect(lastWeek.meetings.map((meeting) => meeting.id)).toEqual(['mtg-roadmap-q1']);
      expect(await provider.execute('notes__get_meetings', { meeting_ids: ['mtg-agent-postmortem'] }, ctx)).toContain('$212');
      expect(await provider.execute('notes__get_meeting_transcript', { meeting_id: 'mtg-hiring-sync' }, ctx)).toContain('free time');
      await expect(provider.execute('notes__get_meeting_transcript', { meeting_id: 'nope' }, ctx)).rejects.toThrow('No meeting nope');
    } finally {
      await provider.close();
    }
  });

  it('can require a bearer token', async () => {
    server = await startNotesServer({ port: 0, host: '127.0.0.1', token: 'stand-in-token' });
    const unauthenticated = await fetch(server.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(unauthenticated.status).toBe(401);
    const provider = new McpServerToolProvider({
      agentId: 'notes-miner',
      server: { name: 'notes', url: server.url, auth: { type: 'bearer', token: '$secret:NOTES_MCP_TOKEN' } },
      readSecret: async (name) => (name === 'NOTES_MCP_TOKEN' ? 'stand-in-token' : null),
      egressPolicy: { enforce: true, allowlist: ['127.0.0.1'], allowlistOnly: false, maxRedirects: 5 },
    });
    try {
      expect((await provider.discover()).state).toBe('ready');
    } finally {
      await provider.close();
    }
  });
});
