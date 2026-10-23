import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  fetchAgents,
  fetchAgent,
  sendMessage,
  sendInterrupt,
  createSSEConnection,
  startBackgroundRun,
  cancelTurn,
  fetchAgentTurns,
  fetchActiveConversations,
  fetchActiveSandboxSessions,
  fetchConversations,
  fetchConversationSummaries,
  fetchConversationSnapshot,
  fetchEvents,
  fetchAllArtifacts,
  downloadArtifact,
  listFiles,
  readFile,
  createFile,
  updateFile,
  deleteFile,
  fetchInterrupts,
  createAgent,
  updateAgent,
  uploadWorkspaceTarball,
  fetchSecretKeys,
  setSecret,
  requestArtifactUploadUrl,
  uploadArtifactDirect,
  uploadArtifactToSignedUrl,
  fetchAnalyticsOverview,
  fetchApiKeys,
  createApiKey,
  fetchConfig,
} from '../api';
import { useApiAuthStore } from '../auth';

const mockJson = vi.fn();
type MockFetchResult = {
  ok: boolean;
  status?: number;
  json: () => Promise<unknown>;
  blob?: () => Promise<Blob>;
};
type MockFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<MockFetchResult>;
const mockFetch = vi.fn<MockFetch>();

const validAgent = {
  id: 'a1',
  name: 'Agent 1',
  harness: 'langgraph',
  harnessConfig: { provider: 'openai', model: 'gpt-5.4-mini' },
  systemPrompt: 'Be useful.',
  tools: [],
  description: null,
  workspaceDir: '/workspace',
  status: 'idle',
  manifest: null,
  metadata: null,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  builtinToolPolicy: null,
  nativeToolPolicy: null,
  httpTools: [],
  workspaceContent: null,
  mode: null,
  resourceLimits: null,
  egress: null,
};

beforeEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  useApiAuthStore.setState({ token: '', authRequired: false });
  mockJson.mockResolvedValue({});
  mockFetch.mockResolvedValue({ ok: true, json: mockJson });
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

// ── GET endpoints ──────────────────────────────────────────────────

describe('fetchAgents', () => {
  it('calls GET /api/agents and returns data', async () => {
    const agents = [validAgent];
    mockJson.mockResolvedValue(agents);

    const result = await fetchAgents();

    expect(mockFetch).toHaveBeenCalledWith('/api/agents', undefined);
    expect(result).toEqual(agents);
  });

  it('attaches the stored bearer token when present', async () => {
    useApiAuthStore.getState().setToken('secret-token');
    mockJson.mockResolvedValue([validAgent]);

    await fetchAgents();

    expect(mockFetch).toHaveBeenCalledWith('/api/agents', {
      headers: { Authorization: 'Bearer secret-token' },
    });
  });

  it('marks auth required on 401 responses', async () => {
    useApiAuthStore.getState().setToken('stale-token');
    mockJson.mockResolvedValue({ error: 'Unauthorized: missing or invalid API token' });
    mockFetch.mockResolvedValue({ ok: false, status: 401, json: mockJson });

    await expect(fetchAgents()).rejects.toThrow('Unauthorized');
    expect(useApiAuthStore.getState().authRequired).toBe(true);
    expect(useApiAuthStore.getState().token).toBe('');
    expect(window.localStorage.getItem('stablehand.apiToken')).toBeNull();
  });

  it('rejects stale agent response shapes at the UI boundary', async () => {
    mockJson.mockResolvedValue([{ id: 'a1', name: 'Legacy Agent', version: 3 }]);

    await expect(fetchAgents()).rejects.toThrow();
  });
});

describe('fetchAgent', () => {
  it('calls GET /api/agents/:id', async () => {
    const agent = validAgent;
    mockJson.mockResolvedValue(agent);

    const result = await fetchAgent('a1');

    expect(mockFetch).toHaveBeenCalledWith('/api/agents/a1', undefined);
    expect(result).toEqual(agent);
  });

  it('rejects a non-canonical agent response', async () => {
    mockJson.mockResolvedValue({ id: 'a1', name: 'Incomplete Agent' });

    await expect(fetchAgent('a1')).rejects.toThrow();
  });
});

describe('access key contracts', () => {
  const key = {
    id: 'key_1',
    name: 'artifact-gallery',
    capabilities: ['artifacts:read'],
    note: null,
    agentId: null,
    status: 'active',
    createdAt: 1,
    createdBy: 'master',
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
  };

  it('strictly parses list responses', async () => {
    mockJson.mockResolvedValue({ keys: [key] });
    await expect(fetchApiKeys()).resolves.toEqual({ keys: [key] });

    mockJson.mockResolvedValue({ keys: [{ ...key, status: undefined }] });
    await expect(fetchApiKeys()).rejects.toThrow();
  });

  it('validates create input before posting and parses the one-time response', async () => {
    const token = `cmk_${'a'.repeat(43)}`;
    mockJson.mockResolvedValue({ ...key, token });

    await expect(createApiKey({
      name: 'artifact-gallery',
      capabilities: ['artifacts:read'],
      expiresAt: null,
    })).resolves.toMatchObject({ token });
    expect(mockFetch).toHaveBeenCalledWith('/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'artifact-gallery',
        capabilities: ['artifacts:read'],
        expiresAt: null,
      }),
    });

    mockFetch.mockClear();
    await expect(createApiKey({
      name: 'artifact-gallery',
      capabilities: ['artifacts:read', 'artifacts:read'],
    })).rejects.toThrow();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('requires the authentication mode in config responses', async () => {
    const config = {
      system: { version: 'test', uptimeMs: 1, dbPath: '.stablehand' },
      agentDefaults: { harness: 'langgraph', temperature: 0.7, maxTokens: 4096 },
      authentication: { mode: 'enforced' },
    };
    mockJson.mockResolvedValue(config);
    await expect(fetchConfig()).resolves.toEqual(config);

    mockJson.mockResolvedValue({
      system: config.system,
      agentDefaults: config.agentDefaults,
    });
    await expect(fetchConfig()).rejects.toThrow();
  });
});

describe('fetchAnalyticsOverview', () => {
  it('calls the canonical windowed endpoint and validates its response', async () => {
    const emptyMetrics = {
      turns: 0,
      completedTurns: 0,
      errorTurns: 0,
      cancelledTurns: 0,
      activeTurns: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      tokenReportedTurns: 0,
      knownCostUsd: 0,
      costCoverage: {
        complete: 0,
        partial: 0,
        pending: 0,
        unpriced: 0,
      },
    };
    const overview = {
      window: '30d',
      from: 1,
      to: 2,
      bucketSizeMs: 1,
      totals: {
        agents: 0,
        activeAgents: 0,
        ...emptyMetrics,
      },
      activity: [{ from: 1, to: 2, ...emptyMetrics }],
      agents: [],
    };
    mockJson.mockResolvedValue(overview);

    await expect(fetchAnalyticsOverview('30d')).resolves.toEqual(overview);
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/analytics/overview?window=30d',
      undefined,
    );
  });
});

describe('fetchAgentTurns', () => {
  it('calls and unwraps GET /api/agents/:id/turns', async () => {
    mockJson.mockResolvedValue({ turns: [] });
    await fetchAgentTurns('a1');
    expect(mockFetch).toHaveBeenCalledWith('/api/agents/a1/turns', undefined);
  });

  it('rejects a stale turn response at the UI boundary', async () => {
    mockJson.mockResolvedValue({ turns: [{ id: 'legacy-turn', status: 'running' }] });

    await expect(fetchAgentTurns('a1')).rejects.toThrow();
  });
});

describe('fetchConversationSummaries', () => {
  const summary = {
    id: 'conversation-1',
    agentId: 'a1',
    status: 'COMPLETED',
    mode: 'interactive',
    turnCount: 2,
    messageCount: 4,
    taskDescription: null,
    startedAt: 1_700_000_000_000,
    completedAt: null,
    updatedAt: 1_700_000_001_000,
    latestTurnId: null,
    sandboxSessionId: null,
    totalTokens: null,
    knownCostUsd: null,
    incompleteCostTurnCount: 0,
  };

  it('accepts the canonical nullable summary fields', async () => {
    mockJson.mockResolvedValue({ conversations: [summary] });

    await expect(fetchConversationSummaries('a1')).resolves.toEqual({ conversations: [summary] });
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/agents/a1/conversations/summary',
      undefined,
    );
  });

  it('rejects the stale optional-field summary shape', async () => {
    const staleSummary: Partial<typeof summary> = { ...summary };
    delete staleSummary.taskDescription;
    mockJson.mockResolvedValue({ conversations: [staleSummary] });

    await expect(fetchConversationSummaries('a1')).rejects.toThrow();
  });
});

describe('fetchActiveSandboxSessions', () => {
  it('calls the explicit active sandbox-session endpoint', async () => {
    mockJson.mockResolvedValue([]);
    await fetchActiveSandboxSessions();
    expect(mockFetch).toHaveBeenCalledWith('/api/sandbox-sessions?status=active', undefined);
  });

  it('rejects a non-canonical sandbox-session response', async () => {
    mockJson.mockResolvedValue({ sessions: [] });

    await expect(fetchActiveSandboxSessions()).rejects.toThrow();
  });
});

describe('fetchActiveConversations', () => {
  it('rejects a non-canonical active-conversation response', async () => {
    mockJson.mockResolvedValue([{ id: 'incomplete-conversation' }]);

    await expect(fetchActiveConversations()).rejects.toThrow();
  });
});

// ── POST endpoints ─────────────────────────────────────────────────

describe('sendMessage', () => {
  it('sends the canonical turn request including its stable requestedTurnId', async () => {
    mockJson.mockResolvedValue({ ok: true });

    await sendMessage('a1', {
      content: 'hello',
      conversationId: 'conversation-1',
      requestedTurnId: 'turn-request-1',
    });

    expect(mockFetch).toHaveBeenCalledWith('/api/agents/a1/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'hello',
        conversationId: 'conversation-1',
        requestedTurnId: 'turn-request-1',
      }),
    });
  });
});

describe('sendInterrupt', () => {
  it('sends the canonical required interrupt identity and action', async () => {
    await sendInterrupt('a1', {
      interruptId: 'interrupt-1',
      action: 'approve',
      data: { reason: 'ok' },
    });

    expect(mockFetch).toHaveBeenCalledWith('/api/agents/a1/interrupt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        interruptId: 'interrupt-1',
        action: 'approve',
        data: { reason: 'ok' },
      }),
    });
  });
});

describe('fetchInterrupts', () => {
  it('unwraps GET /api/agents/:id/interrupts response', async () => {
    const interrupts = [{
      interruptId: 'interrupt-1',
      turnId: 'turn-1',
      sandboxSessionId: 'sandbox-1',
      agentId: 'a1',
      toolCallId: 'tc-1',
      toolName: 'approve',
      args: { ok: true },
      status: 'pending',
      createdAt: 1,
    }];
    mockJson.mockResolvedValue({ interrupts });

    const result = await fetchInterrupts('a1');

    expect(mockFetch).toHaveBeenCalledWith('/api/agents/a1/interrupts', undefined);
    expect(result).toEqual(interrupts);
  });
});

describe('setSecret', () => {
  it('normalizes only the key boundary and preserves the exact value', async () => {
    mockJson.mockResolvedValue({ key: 'mixed.Case-Key' });
    await setSecret('a1', ' mixed.Case-Key ', '  first line\nsecond line  ');

    expect(mockFetch).toHaveBeenCalledWith('/api/agents/a1/secrets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: 'mixed.Case-Key',
        value: '  first line\nsecond line  ',
      }),
    });
  });

  it('rejects non-canonical secret responses', async () => {
    mockJson.mockResolvedValue({ key: '' });

    await expect(setSecret('a1', 'VALID_KEY', 'value')).rejects.toThrow();
  });
});

describe('fetchSecretKeys', () => {
  it('parses the canonical secret-key list response', async () => {
    mockJson.mockResolvedValue({ keys: ['OPENAI_API_KEY'] });

    await expect(fetchSecretKeys('a1')).resolves.toEqual({ keys: ['OPENAI_API_KEY'] });
  });

  it('rejects empty keys from the server', async () => {
    mockJson.mockResolvedValue({ keys: [''] });

    await expect(fetchSecretKeys('a1')).rejects.toThrow();
  });
});

describe('agent mutation contracts', () => {
  const createInput = {
    name: 'Canonical Agent',
    harness: 'test',
    harnessConfig: {},
    systemPrompt: 'Be useful.',
    tools: [],
  };

  it('rejects patch-only null clears on create before making a request', async () => {
    await expect(createAgent({
      ...createInput,
      description: null,
    } as never)).rejects.toThrow();

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('preserves explicit nullable fields on patch', async () => {
    mockJson.mockResolvedValue(validAgent);
    await updateAgent('a1', {
      description: null,
      builtinToolPolicy: null,
      nativeToolPolicy: null,
    });

    const [url, init] = mockFetch.mock.calls[0] ?? [];
    expect(url).toBe('/api/agents/a1');
    expect(init).toMatchObject({
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      description: null,
      builtinToolPolicy: null,
      nativeToolPolicy: null,
    });
  });

  it('rejects a non-canonical create response', async () => {
    mockJson.mockResolvedValue({ id: 'a1', name: 'Incomplete Agent' });

    await expect(createAgent(createInput)).rejects.toThrow();
  });

  it('rejects a non-canonical update response', async () => {
    mockJson.mockResolvedValue({ id: 'a1', name: 'Incomplete Agent' });

    await expect(updateAgent('a1', { description: 'Updated' })).rejects.toThrow();
  });
});

describe('startBackgroundRun', () => {
  it('calls POST with a task', async () => {
    await startBackgroundRun('a1', 'do stuff');

    expect(mockFetch).toHaveBeenCalledWith('/api/agents/a1/turns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: 'do stuff' }),
    });
  });
});

describe('cancelTurn', () => {
  it('calls POST /api/agents/:id/turns/:turnId/cancel', async () => {
    await cancelTurn('a1', 'r1');

    expect(mockFetch).toHaveBeenCalledWith('/api/agents/a1/turns/r1/cancel', {
      method: 'POST',
      headers: undefined,
      body: undefined,
    });
  });
});

// ── Query endpoints that throw on failure ───────────────────────────

describe('fetchConversations', () => {
  it('returns data on success', async () => {
    const convos = [{
      id: 'c1',
      agentId: 'a1',
      tags: null,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_001_000,
    }];
    mockJson.mockResolvedValue(convos);

    const result = await fetchConversations('a1');
    expect(result).toEqual(convos);
    expect(mockFetch).toHaveBeenCalledWith('/api/agents/a1/conversations', undefined);
  });

  it('throws on failure', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, json: mockJson });
    await expect(fetchConversations('a1')).rejects.toThrow('API GET /api/agents/a1/conversations failed: 500');
  });

  it('rejects a stale conversation response', async () => {
    mockJson.mockResolvedValue([{ id: 'c1' }]);

    await expect(fetchConversations('a1')).rejects.toThrow();
  });
});

describe('fetchConversationSnapshot', () => {
  it('returns data on success', async () => {
    const snapshot = {
      conversationId: 'c1',
      eventCursor: '000000000042',
      messages: [{
        id: 'm1',
        messageRevision: 0,
        role: 'assistant',
        content: 'hi',
        createdAt: 1_700_000_000_000,
      }],
    };
    mockJson.mockResolvedValue(snapshot);

    const result = await fetchConversationSnapshot('a1', 'c1');
    expect(result).toEqual(snapshot);
    expect(mockFetch).toHaveBeenCalledWith('/api/agents/a1/conversations/c1/snapshot', undefined);
  });

  it('throws on failure', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404, json: mockJson });
    await expect(fetchConversationSnapshot('a1', 'c1')).rejects.toThrow('API GET /api/agents/a1/conversations/c1/snapshot failed: 404');
  });

  it('rejects a stale snapshot response', async () => {
    mockJson.mockResolvedValue({ conversationId: 'c1', messages: [] });

    await expect(fetchConversationSnapshot('a1', 'c1')).rejects.toThrow();
  });
});

describe('query serialization', () => {
  it('keeps zero-valued query parameters and omits empty strings', async () => {
    await fetchEvents({ cursor: 0, limit: 0, type: '', since: 0 });

    expect(mockFetch).toHaveBeenCalledWith('/api/events?cursor=0&limit=0&since=0', undefined);
  });

  it('omits the query marker when every optional value is empty', async () => {
    await fetchAllArtifacts({ search: '' });

    expect(mockFetch).toHaveBeenCalledWith('/api/artifacts', undefined);
  });
});

// ── Endpoints that throw on failure ────────────────────────────────

describe('listFiles', () => {
  it('calls with encoded path param', async () => {
    mockJson.mockResolvedValue({ entries: [] });
    await listFiles('a1', '/some/path');
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/agents/a1/files?path=%2Fsome%2Fpath',
      undefined,
    );
  });

  it('calls correct URL with path param and returns entries', async () => {
    const entries = [
      { name: 'readme.md', type: 'file', sizeBytes: 12 },
      { name: 'src', type: 'directory', sizeBytes: 0 },
    ];
    mockJson.mockResolvedValue({ entries });

    const result = await listFiles('a1', 'data');

    const calledUrl = (mockFetch.mock.calls[0] as string[])[0];
    expect(calledUrl).toContain('/files?path=data');
    expect(result).toEqual({ entries });
  });

  it('includes conversationId when provided', async () => {
    mockJson.mockResolvedValue({ entries: [] });
    await listFiles('a1', 'data', 'xyz');

    const calledUrl = (mockFetch.mock.calls[0] as string[])[0];
    expect(calledUrl).toContain('path=data');
    expect(calledUrl).toContain('&conversationId=xyz');
  });

  it('throws on non-200 response', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, json: mockJson });
    await expect(listFiles('a1', '/')).rejects.toThrow('API GET /api/agents/a1/files');
  });

  it('rejects malformed file entries', async () => {
    mockJson.mockResolvedValue({ entries: [{ name: 'bad.txt', type: 'file', sizeBytes: -1 }] });

    await expect(listFiles('a1', '/')).rejects.toThrow();
  });
});

describe('readFile', () => {
  it('calls with encoded path param', async () => {
    mockJson.mockResolvedValue({ path: '/file.txt', content: '', sizeBytes: 0 });
    await readFile('a1', '/file.txt');
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/agents/a1/files/read?path=%2Ffile.txt',
      undefined,
    );
  });

  it('calls correct URL with path param and returns file data', async () => {
    const fileData = { path: '/data/report.csv', content: 'col1,col2\n1,2', sizeBytes: 14 };
    mockJson.mockResolvedValue(fileData);

    const result = await readFile('a1', '/data/report.csv');

    const calledUrl = (mockFetch.mock.calls[0] as string[])[0];
    expect(calledUrl).toContain('/files/read?path=');
    expect(result).toEqual(fileData);
  });

  it('includes conversationId when provided', async () => {
    mockJson.mockResolvedValue({ path: '/file.txt', content: '', sizeBytes: 0 });
    await readFile('a1', '/file.txt', 'xyz');

    const calledUrl = (mockFetch.mock.calls[0] as string[])[0];
    expect(calledUrl).toContain('path=%2Ffile.txt');
    expect(calledUrl).toContain('&conversationId=xyz');
  });

  it('throws on 403 response (blocked file)', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 403, json: mockJson });
    await expect(readFile('a1', '/secret.env')).rejects.toThrow(
      'API GET /api/agents/a1/files/read?path=%2Fsecret.env failed: 403',
    );
  });

  it('throws on 400 response (oversized file)', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 400, json: mockJson });
    await expect(readFile('a1', '/huge.bin')).rejects.toThrow(
      'API GET /api/agents/a1/files/read?path=%2Fhuge.bin failed: 400',
    );
  });

  it('rejects responses missing the canonical path', async () => {
    mockJson.mockResolvedValue({ content: 'hello', sizeBytes: 5 });

    await expect(readFile('a1', '/file.txt')).rejects.toThrow();
  });
});

// ── SSE connection ─────────────────────────────────────────────────

describe('createSSEConnection', () => {
  it('creates EventSource with correct URL', () => {
    const MockEventSource = vi.fn();
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;

    createSSEConnection('a1');

    expect(MockEventSource).toHaveBeenCalledWith('/api/agents/a1/stream');
  });

  it('uses query-token auth for EventSource when a token is stored', () => {
    const MockEventSource = vi.fn();
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    useApiAuthStore.getState().setToken('secret token');

    createSSEConnection('a1');

    expect(MockEventSource).toHaveBeenCalledWith('/api/agents/a1/stream?access_token=secret+token');
  });

  it('starts replay strictly after a conversation snapshot cursor', () => {
    const MockEventSource = vi.fn();
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    useApiAuthStore.getState().setToken('secret token');

    createSSEConnection('a1', '000000000042');

    expect(MockEventSource).toHaveBeenCalledWith(
      '/api/agents/a1/stream?cursor=000000000042&access_token=secret+token',
    );
  });
});


describe('uploadWorkspaceTarball', () => {
  it('posts a gzip tarball to the workspace upload endpoint', async () => {
    const file = new File(['bytes'], 'workspace.tar.gz', { type: 'application/gzip' });
    const revision = {
      revision: 3,
      sha256: 'abc123',
      fileCount: 2,
      totalBytes: 5,
      appliedAt: 1234,
    };
    mockJson.mockResolvedValue(revision);

    const result = await uploadWorkspaceTarball('a1', file);

    expect(mockFetch).toHaveBeenCalledWith('/api/agents/a1/workspace', {
      method: 'POST',
      headers: { 'Content-Type': 'application/gzip' },
      body: file,
    });
    expect(result).toEqual(revision);
  });

  it('uses the explicit force flag rather than artifact upload routes', async () => {
    const file = new File(['bytes'], 'workspace.tgz', { type: 'application/octet-stream' });
    mockJson.mockResolvedValue({
      revision: 1,
      sha256: 'abc123',
      fileCount: 1,
      totalBytes: 5,
      appliedAt: 1234,
    });

    await uploadWorkspaceTarball('a1', file, { force: true });

    expect(mockFetch).toHaveBeenCalledWith('/api/agents/a1/workspace?force=true', expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/gzip' },
      body: file,
    }));
  });
});

describe('file mutations', () => {
  it('builds update and delete queries through the shared query encoder', async () => {
    mockJson.mockResolvedValue({ path: 'notes/a file.txt', sizeBytes: 7 });
    await updateFile('a1', 'notes/a file.txt', 'updated', 'conversation 1');
    expect(mockFetch).toHaveBeenCalledWith('/api/agents/a1/files?conversationId=conversation+1', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ path: 'notes/a file.txt', content: 'updated' }),
    }));

    await deleteFile('a1', 'notes/a file.txt', 'conversation 1');
    expect(mockFetch).toHaveBeenCalledWith('/api/agents/a1/files?path=notes%2Fa+file.txt&conversationId=conversation+1', {
      method: 'DELETE',
    });
  });

  it('parses canonical create and update responses', async () => {
    mockJson.mockResolvedValueOnce({ path: 'notes/new.txt', sizeBytes: 3 });
    await expect(createFile('a1', 'notes/new.txt', 'new')).resolves.toEqual({
      path: 'notes/new.txt',
      sizeBytes: 3,
    });

    mockJson.mockResolvedValueOnce({ path: 'notes/new.txt', sizeBytes: 7 });
    await expect(updateFile('a1', 'notes/new.txt', 'updated')).resolves.toEqual({
      path: 'notes/new.txt',
      sizeBytes: 7,
    });
  });

  it('rejects malformed write responses', async () => {
    mockJson.mockResolvedValue({ path: 'notes/new.txt', sizeBytes: -1 });

    await expect(createFile('a1', 'notes/new.txt', 'new')).rejects.toThrow();
    await expect(updateFile('a1', 'notes/new.txt', 'updated')).rejects.toThrow();
  });
});

describe('artifact uploads', () => {
  it('authenticates orchestrator upload URL requests', async () => {
    useApiAuthStore.getState().setToken('secret-token');
    mockJson.mockResolvedValue({ artifactId: 'art-1', uploadUrl: 'https://s3/upload', storageKey: 'k', expiresInSec: 60 });

    await requestArtifactUploadUrl('a1', 'report.txt', 'text/plain', 10);

    expect(mockFetch).toHaveBeenCalledWith('/api/artifacts/upload-url', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer secret-token',
      },
      body: JSON.stringify({ agentId: 'a1', name: 'report.txt', mimeType: 'text/plain', sizeBytes: 10 }),
    });
  });

  it('surfaces orchestrator upload URL error details through the shared mutation path', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: 'invalid artifact request' }),
    });

    await expect(requestArtifactUploadUrl('a1', 'report.txt', 'text/plain', 10))
      .rejects.toThrow('API POST /api/artifacts/upload-url failed: 400 - invalid artifact request');
  });

  it('authenticates direct multipart uploads to the orchestrator', async () => {
    useApiAuthStore.getState().setToken('secret-token');
    mockJson.mockResolvedValue({ id: 'art-1' });
    const file = new File(['bytes'], 'report.txt', { type: 'text/plain' });

    await uploadArtifactDirect(file, 'a1', 'report.txt');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('/api/artifacts/upload');
    expect(init).toBeDefined();
    if (!init) throw new Error('Expected upload init');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ Authorization: 'Bearer secret-token' });
    expect(init.body).toBeInstanceOf(FormData);
  });

  it('does not add Stablehand auth headers to presigned S3 uploads', async () => {
    useApiAuthStore.getState().setToken('secret-token');
    const file = new File(['bytes'], 'report.txt', { type: 'text/plain' });

    await uploadArtifactToSignedUrl('https://s3/upload', file);

    expect(mockFetch).toHaveBeenCalledWith('https://s3/upload', {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: file,
    });
  });
});

describe('artifact downloads', () => {
  it('downloads through the authenticated orchestrator proxy instead of navigating to it', async () => {
    useApiAuthStore.getState().setToken('secret-token');
    const blob = new Blob(['artifact bytes'], { type: 'text/plain' });
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: mockJson,
      blob: async () => blob,
    });
    const createObjectURL = vi.fn(() => 'blob:artifact-download');
    const revokeObjectURL = vi.fn();
    Object.defineProperties(URL, {
      createObjectURL: { configurable: true, value: createObjectURL },
      revokeObjectURL: { configurable: true, value: revokeObjectURL },
    });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);

    await downloadArtifact('art-1', 'report.txt');

    expect(mockFetch).toHaveBeenCalledWith('/api/artifacts/art-1/download', {
      headers: { Authorization: 'Bearer secret-token' },
    });
    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(click).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:artifact-download');
    expect(document.querySelector('a[download="report.txt"]')).toBeNull();
  });
});
