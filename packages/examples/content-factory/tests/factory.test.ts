import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { loadManifestProject } from '@stablehand/manifest/node';
import { afterEach, describe, expect, it } from 'vitest';

import { McpServerToolProvider } from '../../../stablehand/src/mcp/provider.js';
import {
  APIFY_CHARGE_CAP_USD,
  APIFY_RUN_TIMEOUT_SECS,
  MEASURE_APIFY_TOOLS,
  SCOUT_APIFY_TOOLS,
} from '../apify-tools.ts';
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
    // Apify comes in as capped HTTP tools from the seed, never through its
    // MCP server, whose actor tools run without a charge cap.
    for (const dir of ['scout', 'measure']) {
      const input = (await loadAgent(dir)).agentCreateInput;
      expect(input.mcpServers ?? [], dir).toEqual([]);
    }

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

describe('Apify tools', () => {
  const ALL_TOOLS = [...new Set([...SCOUT_APIFY_TOOLS, ...MEASURE_APIFY_TOOLS])];

  it('caps the charge of every call in a URL the model cannot edit', () => {
    expect(ALL_TOOLS.map((tool) => tool.name).sort()).toEqual([
      'apify_linkedin_profile_posts',
      'apify_linkedin_search',
      'apify_x_posts',
    ]);
    const capByActor: Record<string, number> = {
      'harvestapi~linkedin-post-search': APIFY_CHARGE_CAP_USD.linkedin,
      'harvestapi~linkedin-profile-posts': APIFY_CHARGE_CAP_USD.linkedin,
      'apidojo~tweet-scraper': APIFY_CHARGE_CAP_USD.x,
    };
    for (const tool of ALL_TOOLS) {
      const url = new URL(tool.endpoint);
      const actor = /^\/v2\/acts\/([^/]+)\/run-sync-get-dataset-items$/.exec(url.pathname)?.[1];
      expect(url.origin, tool.name).toBe('https://api.apify.com');
      expect(actor, tool.name).toBeDefined();
      const cap = Number(url.searchParams.get('maxTotalChargeUsd'));
      expect(cap, tool.name).toBe(capByActor[actor!]);
      // harvestapi/linkedin-post-search refuses caps under $0.01.
      expect(cap, tool.name).toBeGreaterThanOrEqual(0.01);
      expect(cap, tool.name).toBeLessThanOrEqual(0.05);
      expect(url.searchParams.get('timeout'), tool.name).toBe(String(APIFY_RUN_TIMEOUT_SECS));
      expect(Number(url.searchParams.get('limit')), tool.name).toBeLessThanOrEqual(20);
      expect(url.searchParams.get('clean'), tool.name).toBe('true');
      expect(url.searchParams.get('fields'), tool.name).toBeTruthy();
      expect(tool.method).toBe('POST');
      expect(tool.authentication).toEqual({ type: 'bearer', secretName: 'APIFY_TOKEN' });
      expect(tool.timeoutMs, tool.name).toBeGreaterThan(APIFY_RUN_TIMEOUT_SECS * 1000);
      expect(tool.description, tool.name).toContain(`stops this call at $${cap}`);
      // The cap lives only in the URL: the model's input cannot carry run options.
      expect(Object.keys((tool.inputSchema.properties ?? {}) as object), tool.name).not.toContain('maxTotalChargeUsd');
    }
  });

  it('gives the scout and measure agents exactly the Apify tools their instructions call', async () => {
    for (const [dir, tools] of [['scout', SCOUT_APIFY_TOOLS], ['measure', MEASURE_APIFY_TOOLS]] as const) {
      const instructions = (await loadAgent(dir)).agentCreateInput.systemPrompt ?? '';
      const called = [...new Set(instructions.match(/\bapify_[a-z_]+\b/g) ?? [])].sort();
      expect(called, dir).toEqual(tools.map((tool) => tool.name).sort());
      expect(instructions, dir).not.toMatch(/apify__/);
    }
  });

  it('states the weekly Apify ceiling the caps and the shipped schedule give', async () => {
    const config = JSON.parse(await readFile(new URL('../factory.config.json', import.meta.url), 'utf8')) as {
      niche: { keywords: string[] };
    };
    const { linkedin, x } = APIFY_CHARGE_CAP_USD;
    const keywords = Math.min(config.niche.keywords.length, 2);
    // The scout searches LinkedIn and X once per keyword (up to 2 keywords).
    const shipped = keywords * (linkedin + x);
    // Own accounts and watched X accounts add one X handles search and the
    // measure agent's LinkedIn and X calls.
    const withAccounts = shipped + x + linkedin + x;
    const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
    expect(readme).toContain(`at most $${shipped.toFixed(2)} a week`);
    expect(readme).toContain(`at most $${withAccounts.toFixed(2)} a week`);
    expect(readme).toContain(`$${linkedin} per LinkedIn call and $${x} per X call`);
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
