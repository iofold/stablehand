import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  fetchAgents,
  fetchAgent,
  sendMessage,
  sendInterrupt,
  createSSEConnection,
  startBackgroundRun,
  cancelRun,
  fetchRuns,
  fetchAllActiveRuns,
  fetchConversations,
  fetchMessages,
  fetchKnowledge,
  fetchKnowledgeStats,
  deleteKnowledgeItem,
  listFiles,
  readFile,
  fetchTraceStats,
  fetchTraces,
  fetchFeedbackStats,
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

describe('fetchRuns', () => {
  it('calls GET /api/agents/:id/runs', async () => {
    await fetchRuns('a1');
    expect(mockFetch).toHaveBeenCalledWith('/api/agents/a1/runs', undefined);
  });
});

describe('fetchAllActiveRuns', () => {
  it('calls GET /api/runs', async () => {
    await fetchAllActiveRuns();
    expect(mockFetch).toHaveBeenCalledWith('/api/runs', undefined);
  });
});

describe('fetchTraces', () => {
  it('calls GET /api/agents/:id/traces', async () => {
    await fetchTraces('a1');
    expect(mockFetch).toHaveBeenCalledWith('/api/agents/a1/traces', undefined);
  });

  it('throws on failure', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, json: mockJson });
    await expect(fetchTraces('a1')).rejects.toThrow('API GET /api/agents/a1/traces failed: 500');
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

describe('startBackgroundRun', () => {
  it('calls POST with task and background mode', async () => {
    await startBackgroundRun('a1', 'do stuff');

    expect(mockFetch).toHaveBeenCalledWith('/api/agents/a1/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: 'do stuff', mode: 'background' }),
    });
  });
});

describe('cancelRun', () => {
  it('calls POST /api/agents/:id/runs/:runId/cancel', async () => {
    await cancelRun('a1', 'r1');

    expect(mockFetch).toHaveBeenCalledWith('/api/agents/a1/runs/r1/cancel', {
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

describe('fetchKnowledge', () => {
  it('calls with q and category params', async () => {
    // fetchKnowledge uses window.location.origin for URL construction
    await fetchKnowledge('a1', { q: 'test', category: 'faq' });

    const calledUrl = (mockFetch.mock.calls[0] as string[])[0];
    expect(calledUrl).toContain('/api/agents/a1/knowledge');
    expect(calledUrl).toContain('q=test');
    expect(calledUrl).toContain('category=faq');
  });

  it('throws on failure', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, json: mockJson });
    await expect(fetchKnowledge('a1')).rejects.toThrow('failed: 500');
  });
});

describe('fetchKnowledgeStats', () => {
  it('throws on failure', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503, json: mockJson });
    await expect(fetchKnowledgeStats('a1')).rejects.toThrow('API GET /api/agents/a1/knowledge/stats failed: 503');
  });
});

describe('fetchTraceStats', () => {
  it('throws on failure', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, json: mockJson });
    await expect(fetchTraceStats('a1')).rejects.toThrow('API GET /api/agents/a1/traces/stats failed: 500');
  });
});

describe('fetchFeedbackStats', () => {
  it('throws on failure', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 502, json: mockJson });
    await expect(fetchFeedbackStats('a1')).rejects.toThrow('API GET /api/agents/a1/feedback/stats failed: 502');
  });
});

// ── Endpoints that throw on failure ────────────────────────────────

describe('deleteKnowledgeItem', () => {
  it('calls DELETE and returns data', async () => {
    mockJson.mockResolvedValue({ deleted: true });
    const result = await deleteKnowledgeItem('a1', 'k1');

    expect(mockFetch).toHaveBeenCalledWith('/api/agents/a1/knowledge/k1', {
      method: 'DELETE',
      headers: undefined,
      body: undefined,
    });
    expect(result).toEqual({ deleted: true });
  });

  it('throws on failure', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, json: mockJson });
    await expect(deleteKnowledgeItem('a1', 'k1')).rejects.toThrow(
      'API DELETE /api/agents/a1/knowledge/k1 failed: 500',
    );
  });
});

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

  it('includes runId when provided', async () => {
    await listFiles('a1', 'data', 'xyz');

    const calledUrl = (mockFetch.mock.calls[0] as string[])[0];
    expect(calledUrl).toContain('path=data');
    expect(calledUrl).toContain('&runId=xyz');
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

  it('includes runId when provided', async () => {
    await readFile('a1', '/file.txt', 'xyz');

    const calledUrl = (mockFetch.mock.calls[0] as string[])[0];
    expect(calledUrl).toContain('path=%2Ffile.txt');
    expect(calledUrl).toContain('&runId=xyz');
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
