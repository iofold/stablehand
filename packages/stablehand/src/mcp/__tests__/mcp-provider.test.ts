import { afterEach, describe, expect, it } from 'vitest';
import type { McpServerDefinition } from '@stablehand/contracts';
import type { ToolContext } from '@stablehand/sandbox-daemon';

import type { EgressPolicy } from '../../util/egress.js';
import { agentToolName, humanizeMcpToolName, mcpToolRequiresApproval } from '../config.js';
import { checkMcpServerUrl } from '../egress.js';
import { formatMcpToolResult, McpServerToolProvider, stripDisallowedNulls } from '../provider.js';
import { startTestMcpServer, type TestMcpServerHandle } from './support/test-mcp-server.js';

const LOOPBACK_ALLOWED: EgressPolicy = {
  enforce: true,
  allowlist: ['127.0.0.1'],
  allowlistOnly: false,
  maxRedirects: 5,
};

const CTX: ToolContext = { agentId: 'agent-a', conversationId: 'c1', workspaceDir: '/workspace' };

describe('MCP config helpers', () => {
  it('builds agent tool names that every model API accepts', () => {
    expect(agentToolName('granola', 'list_meetings')).toBe('granola__list_meetings');
    expect(agentToolName('apify', 'apify/rag-web-browser')).toBe('apify__apify_rag-web-browser');
    const long = agentToolName('apify', 'harvestapi/linkedin-profile-posts-and-reactions-with-comments');
    expect(long.length).toBeLessThanOrEqual(47);
    expect(long).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(long).not.toBe(agentToolName('apify', 'harvestapi/linkedin-profile-posts-and-reactions-with-comment'));
  });

  it('writes plain display names', () => {
    expect(humanizeMcpToolName('list_meetings')).toBe('List meetings');
    expect(humanizeMcpToolName('apify/rag-web-browser')).toBe('Rag web browser');
    expect(humanizeMcpToolName('getMeetingTranscript')).toBe('Get meeting transcript');
  });

  it('lets the operator list win over server annotations', () => {
    const server = (requireApproval?: McpServerDefinition['requireApproval']): McpServerDefinition => ({
      name: 'notes',
      url: 'https://notes.example.com/mcp',
      ...(requireApproval !== undefined ? { requireApproval } : {}),
    });
    expect(mcpToolRequiresApproval(server(), 'delete_note', { destructiveHint: true })).toBe(true);
    expect(mcpToolRequiresApproval(server(), 'list_notes', { readOnlyHint: true })).toBe(false);
    expect(mcpToolRequiresApproval(server(false), 'delete_note', { destructiveHint: true })).toBe(false);
    expect(mcpToolRequiresApproval(server(true), 'list_notes', { readOnlyHint: true })).toBe(true);
    expect(mcpToolRequiresApproval(server(['call-*']), 'call-actor', undefined)).toBe(true);
    expect(mcpToolRequiresApproval(server(['call-*']), 'delete_note', { destructiveHint: true })).toBe(false);
  });

  it('checks declared URLs against the egress policy with an actionable message', () => {
    const strict: EgressPolicy = { enforce: true, allowlist: [], allowlistOnly: false, maxRedirects: 5 };
    expect(checkMcpServerUrl('https://mcp.granola.ai/mcp', strict)).toBeNull();
    expect(checkMcpServerUrl('http://notes-mcp:8787/mcp', strict)).toMatch(/STABLEHAND_EGRESS_ALLOWLIST/);
    expect(checkMcpServerUrl('http://notes-mcp:8787/mcp', { ...strict, allowlist: ['notes-mcp'] })).toBeNull();
    expect(checkMcpServerUrl('https://mcp.apify.com', { ...strict, allowlistOnly: true })).toMatch(/only reaches allowlisted/);
    expect(checkMcpServerUrl('https://user:pw@mcp.example.com', strict)).toMatch(/credentials/);
  });

  it('drops nulls the server schema does not allow, keeping the rest', () => {
    const schema = {
      type: 'object',
      properties: {
        text: { type: 'string' },
        limit: { type: 'number' },
        cursor: { type: ['string', 'null'] },
        nested: { type: 'object', properties: { flag: { type: 'boolean' } } },
      },
    };
    expect(stripDisallowedNulls({ text: 'hi', limit: null, cursor: null, nested: { flag: null } }, schema))
      .toEqual({ text: 'hi', cursor: null, nested: {} });
  });

  it('formats results: text joined, media described, errors thrown, long output truncated', () => {
    expect(formatMcpToolResult({ content: [{ type: 'text', text: 'a' }, { type: 'image', mimeType: 'image/png', data: 'x' }] }))
      .toBe('a\n[image image/png not shown]');
    expect(formatMcpToolResult({ content: [], structuredContent: { ok: true } })).toBe('{"ok":true}');
    expect(() => formatMcpToolResult({ isError: true, content: [{ type: 'text', text: 'nope' }] })).toThrow('nope');
    expect(formatMcpToolResult({ content: [{ type: 'text', text: 'x'.repeat(50) }] }, 10))
      .toMatch(/^x{10}\n\[Result truncated: 40 more characters/);
  });
});

describe('McpServerToolProvider against a real Streamable HTTP server', () => {
  let server: TestMcpServerHandle | undefined;
  const providers: McpServerToolProvider[] = [];

  afterEach(async () => {
    await Promise.all(providers.splice(0).map((provider) => provider.close()));
    await server?.close();
    server = undefined;
  });

  function provider(definition: Omit<McpServerDefinition, 'url'>, secrets: Record<string, string> = {}, policy = LOOPBACK_ALLOWED) {
    if (!server) throw new Error('server not started');
    const created = new McpServerToolProvider({
      agentId: 'agent-a',
      server: { url: server.url, ...definition },
      readSecret: async (name) => secrets[name] ?? null,
      egressPolicy: policy,
      discoveryTimeoutMs: 5_000,
    });
    providers.push(created);
    return created;
  }

  it('lists allowed tools under the server prefix and calls them', async () => {
    server = await startTestMcpServer();
    const notes = provider({ name: 'notes', tools: ['list_*', 'get_note', 'delete_note', 'echo_args', 'broken', 'apify/*'] });

    expect(await notes.listTools()).toEqual([]);
    const status = await notes.discover();
    expect(status.state).toBe('ready');
    expect(status.tools.map((tool) => tool.name)).toEqual([
      'notes__list_notes',
      'notes__get_note',
      'notes__delete_note',
      'notes__echo_args',
      'notes__broken',
      'notes__apify_rag-web-browser',
    ]);
    expect(status.tools.find((tool) => tool.mcpName === 'list_notes')?.displayName).toBe('List notes');
    expect(status.tools.find((tool) => tool.mcpName === 'delete_note')?.requiresApproval).toBe(true);
    expect(status.tools.find((tool) => tool.mcpName === 'get_note')?.requiresApproval).toBe(false);

    const tools = await notes.listTools();
    expect(tools.every((tool) => tool.location === 'orchestrator')).toBe(true);
    expect(notes.catalogInfo(tools[0]!)).toEqual({ displayName: 'List notes', server: 'notes' });

    const getNote = tools.find((tool) => tool.name === 'notes__get_note')!;
    expect(await getNote.handler({ id: 'n1' }, CTX)).toBe('Pricing review: We will drop the annual discount from 20% to 15%.');
    await expect(getNote.handler({ id: 'missing' }, CTX)).rejects.toThrow('No note missing');
    await expect(notes.execute('notes__broken', {}, CTX)).rejects.toThrow('boom: upstream refused');
    expect(await notes.execute('notes__echo_args', { text: 'hi', limit: null }, CTX)).toBe('{"text":"hi"}');
    expect(await notes.execute('notes__apify_rag-web-browser', { query: 'mcp' }, CTX))
      .toBe('results for mcp\n[image image/png not shown]');
    expect(server.calls.map((call) => call.name)).toEqual([
      'get_note', 'get_note', 'broken', 'echo_args', 'apify/rag-web-browser',
    ]);
  });

  it('honours the allowlist and the operator approval list', async () => {
    server = await startTestMcpServer();
    const notes = provider({ name: 'notes', tools: ['list_notes', 'get_note'], requireApproval: ['get_*'] });
    const status = await notes.discover();
    expect(status.tools.map((tool) => [tool.mcpName, tool.requiresApproval])).toEqual([
      ['list_notes', false],
      ['get_note', true],
    ]);
    const tools = await notes.listTools();
    expect(tools.find((tool) => tool.name === 'notes__get_note')?.requiresApproval).toBe(true);
  });

  it('sends a bearer token read from the agent tools secrets and reports a missing one', async () => {
    server = await startTestMcpServer({ type: 'bearer', token: 'apify-secret-token' });
    const missing = provider({ name: 'apify', auth: { type: 'bearer', token: '$secret:APIFY_TOKEN' } });
    const missingStatus = await missing.discover();
    expect(missingStatus.state).toBe('needs_auth');
    expect(missingStatus.message).toContain('APIFY_TOKEN');
    expect(missingStatus.message).not.toContain('apify-secret-token');

    const wrong = provider({ name: 'apify', auth: { type: 'bearer', token: '$secret:APIFY_TOKEN' } }, { APIFY_TOKEN: 'stale' });
    expect((await wrong.discover()).state).not.toBe('ready');

    const configured = provider(
      { name: 'apify', auth: { type: 'bearer', token: '$secret:APIFY_TOKEN' } },
      { APIFY_TOKEN: 'apify-secret-token' },
    );
    expect((await configured.discover()).state).toBe('ready');
    await configured.execute('apify__list_notes', {}, CTX);
    expect(server.calls.at(-1)?.authorization).toBe('Bearer apify-secret-token');
    // Nothing about the token leaks into what the sandbox receives.
    const definitions = JSON.stringify(await configured.listTools());
    expect(definitions).not.toContain('apify-secret-token');
  });

  it('sends a custom header for header auth', async () => {
    server = await startTestMcpServer();
    const notes = provider(
      { name: 'notes', auth: { type: 'header', name: 'x-api-key', value: '$secret:NOTES_KEY' } },
      { NOTES_KEY: 'k-123' },
    );
    expect((await notes.discover()).state).toBe('ready');
  });

  it('is blocked by the egress guard unless the host is allowlisted', async () => {
    server = await startTestMcpServer();
    const blocked = provider(
      { name: 'notes' },
      {},
      { enforce: true, allowlist: [], allowlistOnly: false, maxRedirects: 5 },
    );
    const status = await blocked.discover();
    expect(status.state).toBe('error');
    expect(status.message).toMatch(/blocked/);
    expect(server.calls).toHaveLength(0);
  });

  it('keeps the agent usable when the server is down', async () => {
    server = await startTestMcpServer();
    const url = server.url;
    await server.close();
    server = undefined;
    const down = new McpServerToolProvider({
      agentId: 'agent-a',
      server: { name: 'notes', url },
      readSecret: async () => null,
      egressPolicy: LOOPBACK_ALLOWED,
      discoveryTimeoutMs: 2_000,
    });
    providers.push(down);
    const status = await down.discover();
    expect(status.state).toBe('error');
    expect(await down.listTools()).toEqual([]);
  });
});
