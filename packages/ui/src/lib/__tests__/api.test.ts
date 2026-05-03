import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  fetchAgents,
  fetchAgent,
  sendMessage,
  sendInterrupt,
  createSSEConnection,
  startBackgroundRun,
  cancelRun,
  fetchSessions,
  fetchAllActiveSessions,
  fetchConversations,
  fetchMessages,
  fetchEvents,
  fetchAllArtifacts,
  listFiles,
  readFile,
  fetchInterrupts,
  uploadWorkspaceTarball,
} from '../api';

const mockJson = vi.fn();
const mockFetch = vi.fn<() => Promise<{ ok: boolean; status?: number; json: () => Promise<unknown> }>>();

beforeEach(() => {
  vi.restoreAllMocks();
  mockJson.mockResolvedValue({});
  mockFetch.mockResolvedValue({ ok: true, json: mockJson });
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

// ── GET endpoints ──────────────────────────────────────────────────

describe('fetchAgents', () => {
  it('calls GET /api/agents and returns data', async () => {
    const agents = [{ id: 'a1', name: 'Agent 1' }];
    mockJson.mockResolvedValue(agents);

    const result = await fetchAgents();

    expect(mockFetch).toHaveBeenCalledWith('/api/agents', undefined);
    expect(result).toEqual(agents);
  });
});

describe('fetchAgent', () => {
  it('calls GET /api/agents/:id', async () => {
    const agent = { id: 'a1', name: 'Agent 1' };
    mockJson.mockResolvedValue(agent);

    const result = await fetchAgent('a1');

    expect(mockFetch).toHaveBeenCalledWith('/api/agents/a1', undefined);
    expect(result).toEqual(agent);
  });
});

describe('fetchSessions', () => {
  it('calls GET /api/agents/:id/sessions', async () => {
    await fetchSessions('a1');
    expect(mockFetch).toHaveBeenCalledWith('/api/agents/a1/sessions', undefined);
  });
});

describe('fetchAllActiveSessions', () => {
  it('calls GET /api/sessions with sandbox format', async () => {
    await fetchAllActiveSessions();
    expect(mockFetch).toHaveBeenCalledWith('/api/sessions?format=sandbox', undefined);
  });
});

// ── POST endpoints ─────────────────────────────────────────────────

describe('sendMessage', () => {
  it('calls POST /api/agents/:id/message with content', async () => {
    mockJson.mockResolvedValue({ ok: true });

    await sendMessage('a1', 'hello');

    expect(mockFetch).toHaveBeenCalledWith('/api/agents/a1/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hello' }),
    });
  });
});

describe('sendInterrupt', () => {
  it('calls POST /api/agents/:id/interrupt with action and data', async () => {
    await sendInterrupt('a1', 'approve', { reason: 'ok' });

    expect(mockFetch).toHaveBeenCalledWith('/api/agents/a1/interrupt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'approve', data: { reason: 'ok' } }),
    });
  });
});

describe('fetchInterrupts', () => {
  it('unwraps GET /api/agents/:id/interrupts response', async () => {
    const interrupts = [{
      id: 'turn-1',
      sessionId: 'turn-1',
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

describe('startBackgroundRun', () => {
  it('calls POST with task and background mode', async () => {
    await startBackgroundRun('a1', 'do stuff');

    expect(mockFetch).toHaveBeenCalledWith('/api/agents/a1/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: 'do stuff', mode: 'background' }),
    });
  });
});

describe('cancelRun', () => {
  it('calls POST /api/agents/:id/sessions/:sessionId/cancel', async () => {
    await cancelRun('a1', 'r1');

    expect(mockFetch).toHaveBeenCalledWith('/api/agents/a1/sessions/r1/cancel', {
      method: 'POST',
      headers: undefined,
      body: undefined,
    });
  });
});

// ── Query endpoints that throw on failure ───────────────────────────

describe('fetchConversations', () => {
  it('returns data on success', async () => {
    const convos = [{ id: 'c1' }];
    mockJson.mockResolvedValue(convos);

    const result = await fetchConversations('a1');
    expect(result).toEqual(convos);
    expect(mockFetch).toHaveBeenCalledWith('/api/agents/a1/conversations', undefined);
  });

  it('throws on failure', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, json: mockJson });
    await expect(fetchConversations('a1')).rejects.toThrow('API GET /api/agents/a1/conversations failed: 500');
  });
});

describe('fetchMessages', () => {
  it('returns data on success', async () => {
    const msgs = [{ id: 'm1', content: 'hi' }];
    mockJson.mockResolvedValue(msgs);

    const result = await fetchMessages('a1', 'c1');
    expect(result).toEqual(msgs);
    expect(mockFetch).toHaveBeenCalledWith('/api/agents/a1/conversations/c1/messages', undefined);
  });

  it('throws on failure', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404, json: mockJson });
    await expect(fetchMessages('a1', 'c1')).rejects.toThrow('API GET /api/agents/a1/conversations/c1/messages failed: 404');
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
    await listFiles('a1', '/some/path');
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/agents/a1/files?path=%2Fsome%2Fpath',
      undefined,
    );
  });

  it('calls correct URL with path param and returns entries', async () => {
    const entries = [{ name: 'readme.md', type: 'file' }, { name: 'src', type: 'directory' }];
    mockJson.mockResolvedValue({ entries });

    const result = await listFiles('a1', 'data');

    const calledUrl = (mockFetch.mock.calls[0] as string[])[0];
    expect(calledUrl).toContain('/files?path=data');
    expect(result).toEqual({ entries });
  });

  it('includes sessionId when provided', async () => {
    await listFiles('a1', 'data', 'xyz');

    const calledUrl = (mockFetch.mock.calls[0] as string[])[0];
    expect(calledUrl).toContain('path=data');
    expect(calledUrl).toContain('&sessionId=xyz');
  });

  it('throws on non-200 response', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, json: mockJson });
    await expect(listFiles('a1', '/')).rejects.toThrow('API GET /api/agents/a1/files');
  });
});

describe('readFile', () => {
  it('calls with encoded path param', async () => {
    await readFile('a1', '/file.txt');
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/agents/a1/files/read?path=%2Ffile.txt',
      undefined,
    );
  });

  it('calls correct URL with path param and returns file data', async () => {
    const fileData = { path: '/data/report.csv', content: 'col1,col2\n1,2', size: 14 };
    mockJson.mockResolvedValue(fileData);

    const result = await readFile('a1', '/data/report.csv');

    const calledUrl = (mockFetch.mock.calls[0] as string[])[0];
    expect(calledUrl).toContain('/files/read?path=');
    expect(result).toEqual(fileData);
  });

  it('includes sessionId when provided', async () => {
    await readFile('a1', '/file.txt', 'xyz');

    const calledUrl = (mockFetch.mock.calls[0] as string[])[0];
    expect(calledUrl).toContain('path=%2Ffile.txt');
    expect(calledUrl).toContain('&sessionId=xyz');
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
});

// ── SSE connection ─────────────────────────────────────────────────

describe('createSSEConnection', () => {
  it('creates EventSource with correct URL', () => {
    const MockEventSource = vi.fn();
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;

    createSSEConnection('a1');

    expect(MockEventSource).toHaveBeenCalledWith('/api/agents/a1/stream');
  });
});


describe('uploadWorkspaceTarball', () => {
  it('posts a gzip tarball to the workspace upload endpoint', async () => {
    const file = new File(['bytes'], 'workspace.tar.gz', { type: 'application/gzip' });
    mockJson.mockResolvedValue({ files: 2, totalBytes: 5 });

    const result = await uploadWorkspaceTarball('a1', file);

    expect(mockFetch).toHaveBeenCalledWith('/api/agents/a1/workspace', {
      method: 'POST',
      headers: { 'Content-Type': 'application/gzip' },
      body: file,
    });
    expect(result).toEqual({ files: 2, totalBytes: 5 });
  });

  it('uses the explicit force flag rather than artifact upload routes', async () => {
    const file = new File(['bytes'], 'workspace.tgz', { type: 'application/x-gzip' });

    await uploadWorkspaceTarball('a1', file, { force: true });

    expect(mockFetch).toHaveBeenCalledWith('/api/agents/a1/workspace?force=true', expect.objectContaining({
      method: 'POST',
      body: file,
    }));
  });
});
