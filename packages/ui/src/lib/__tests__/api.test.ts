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
const mockFetch = vi.fn<() => Promise<{ ok: boolean; json: () => Promise<unknown> }>>();

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

    expect(mockFetch).toHaveBeenCalledWith('/api/agents');
    expect(result).toEqual(agents);
  });
});

describe('fetchAgent', () => {
  it('calls GET /api/agents/:id', async () => {
    const agent = { id: 'a1', name: 'Agent 1' };
    mockJson.mockResolvedValue(agent);

    const result = await fetchAgent('a1');

    expect(mockFetch).toHaveBeenCalledWith('/api/agents/a1');
    expect(result).toEqual(agent);
  });
});

describe('fetchRuns', () => {
  it('calls GET /api/agents/:id/runs', async () => {
    await fetchRuns('a1');
    expect(mockFetch).toHaveBeenCalledWith('/api/agents/a1/runs');
  });
});

describe('fetchAllActiveRuns', () => {
  it('calls GET /api/runs', async () => {
    await fetchAllActiveRuns();
    expect(mockFetch).toHaveBeenCalledWith('/api/runs');
  });
});

describe('fetchTraces', () => {
  it('calls GET /api/agents/:id/traces', async () => {
    await fetchTraces('a1');
    expect(mockFetch).toHaveBeenCalledWith('/api/agents/a1/traces');
  });

  it('returns empty array on failure', async () => {
    mockFetch.mockResolvedValue({ ok: false, json: mockJson });
    const result = await fetchTraces('a1');
    expect(result).toEqual([]);
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
    });
  });
});

// ── Endpoints with error handling (return defaults on !ok) ─────────

describe('fetchConversations', () => {
  it('returns data on success', async () => {
    const convos = [{ id: 'c1' }];
    mockJson.mockResolvedValue(convos);

    const result = await fetchConversations('a1');
    expect(result).toEqual(convos);
    expect(mockFetch).toHaveBeenCalledWith('/api/agents/a1/conversations');
  });

  it('returns empty array on failure', async () => {
    mockFetch.mockResolvedValue({ ok: false, json: mockJson });
    const result = await fetchConversations('a1');
    expect(result).toEqual([]);
  });
});

describe('fetchMessages', () => {
  it('returns data on success', async () => {
    const msgs = [{ id: 'm1', content: 'hi' }];
    mockJson.mockResolvedValue(msgs);

    const result = await fetchMessages('a1', 'c1');
    expect(result).toEqual(msgs);
    expect(mockFetch).toHaveBeenCalledWith('/api/agents/a1/conversations/c1/messages');
  });

  it('returns empty array on failure', async () => {
    mockFetch.mockResolvedValue({ ok: false, json: mockJson });
    const result = await fetchMessages('a1', 'c1');
    expect(result).toEqual([]);
  });
});

describe('fetchKnowledge', () => {
  it('calls with search and category params', async () => {
    // fetchKnowledge uses window.location.origin for URL construction
    await fetchKnowledge('a1', { search: 'test', category: 'faq' });

    const calledUrl = (mockFetch.mock.calls[0] as string[])[0];
    expect(calledUrl).toContain('/api/agents/a1/knowledge');
    expect(calledUrl).toContain('search=test');
    expect(calledUrl).toContain('category=faq');
  });

  it('returns empty array on failure', async () => {
    mockFetch.mockResolvedValue({ ok: false, json: mockJson });
    const result = await fetchKnowledge('a1');
    expect(result).toEqual([]);
  });
});

describe('fetchKnowledgeStats', () => {
  it('returns default stats on failure', async () => {
    mockFetch.mockResolvedValue({ ok: false, json: mockJson });
    const result = await fetchKnowledgeStats('a1');
    expect(result).toEqual({ total: 0, categories: {}, recentItems: 0 });
  });
});

describe('fetchTraceStats', () => {
  it('returns default stats on failure', async () => {
    mockFetch.mockResolvedValue({ ok: false, json: mockJson });
    const result = await fetchTraceStats('a1');
    expect(result).toEqual({ total: 0, outcomes: {}, avgSteps: 0, recent24h: 0 });
  });
});

describe('fetchFeedbackStats', () => {
  it('returns default stats on failure', async () => {
    mockFetch.mockResolvedValue({ ok: false, json: mockJson });
    const result = await fetchFeedbackStats('a1');
    expect(result).toEqual({ total: 0, types: {}, recent24h: 0 });
  });
});

// ── Endpoints that throw on failure ────────────────────────────────

describe('deleteKnowledgeItem', () => {
  it('calls DELETE and returns data', async () => {
    mockJson.mockResolvedValue({ deleted: true });
    const result = await deleteKnowledgeItem('a1', 'k1');

    expect(mockFetch).toHaveBeenCalledWith('/api/agents/a1/knowledge/k1', {
      method: 'DELETE',
    });
    expect(result).toEqual({ deleted: true });
  });

  it('throws on failure', async () => {
    mockFetch.mockResolvedValue({ ok: false, json: mockJson });
    await expect(deleteKnowledgeItem('a1', 'k1')).rejects.toThrow(
      'Failed to delete knowledge item',
    );
  });
});

describe('listFiles', () => {
  it('calls with encoded path param', async () => {
    await listFiles('a1', '/some/path');
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/agents/a1/files?path=%2Fsome%2Fpath',
    );
  });

  it('throws on failure', async () => {
    mockFetch.mockResolvedValue({ ok: false, json: mockJson });
    await expect(listFiles('a1', '/')).rejects.toThrow('Failed to list files');
  });
});

describe('readFile', () => {
  it('calls with encoded path param', async () => {
    await readFile('a1', '/file.txt');
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/agents/a1/files/read?path=%2Ffile.txt',
    );
  });

  it('throws on failure', async () => {
    mockFetch.mockResolvedValue({ ok: false, json: mockJson });
    await expect(readFile('a1', '/file.txt')).rejects.toThrow('Failed to read file');
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
