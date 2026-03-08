const API_BASE = '/api';

// ── Query operations (return typed defaults on error) ──────────────

export async function fetchAgents() {
  try {
    const res = await fetch(`${API_BASE}/agents`);
    if (!res.ok) return [];
    return res.json();
  } catch (err) {
    console.warn('[api] fetchAgents failed:', err);
    return [];
  }
}

export async function fetchAgent(id: string) {
  try {
    const res = await fetch(`${API_BASE}/agents/${id}`);
    if (!res.ok) return null;
    return res.json();
  } catch (err) {
    console.warn('[api] fetchAgent failed:', err);
    return null;
  }
}

export async function fetchRuns(agentId: string) {
  try {
    const res = await fetch(`${API_BASE}/agents/${agentId}/runs`);
    if (!res.ok) return [];
    return res.json();
  } catch (err) {
    console.warn('[api] fetchRuns failed:', err);
    return [];
  }
}

export async function fetchAllActiveRuns() {
  try {
    const res = await fetch(`${API_BASE}/runs`);
    if (!res.ok) return [];
    return res.json();
  } catch (err) {
    console.warn('[api] fetchAllActiveRuns failed:', err);
    return [];
  }
}

export async function fetchConversations(agentId: string) {
  try {
    const res = await fetch(`${API_BASE}/agents/${agentId}/conversations`);
    if (!res.ok) return [];
    return res.json();
  } catch (err) {
    console.warn('[api] fetchConversations failed:', err);
    return [];
  }
}

export async function fetchMessages(agentId: string, conversationId: string) {
  try {
    const res = await fetch(`${API_BASE}/agents/${agentId}/conversations/${conversationId}/messages`);
    if (!res.ok) return [];
    return res.json();
  } catch (err) {
    console.warn('[api] fetchMessages failed:', err);
    return [];
  }
}

export async function fetchKnowledge(agentId: string, params?: { search?: string; category?: string }) {
  try {
    const url = new URL(`${API_BASE}/agents/${agentId}/knowledge`, window.location.origin);
    if (params?.search) url.searchParams.set('search', params.search);
    if (params?.category) url.searchParams.set('category', params.category);
    const res = await fetch(url.toString());
    if (!res.ok) return [];
    return res.json();
  } catch (err) {
    console.warn('[api] fetchKnowledge failed:', err);
    return [];
  }
}

export async function fetchKnowledgeStats(agentId: string) {
  try {
    const res = await fetch(`${API_BASE}/agents/${agentId}/knowledge/stats`);
    if (!res.ok) return { total: 0, categories: {}, recentItems: 0 };
    return res.json();
  } catch (err) {
    console.warn('[api] fetchKnowledgeStats failed:', err);
    return { total: 0, categories: {}, recentItems: 0 };
  }
}

export async function fetchTraceStats(agentId: string) {
  try {
    const res = await fetch(`${API_BASE}/agents/${agentId}/traces/stats`);
    if (!res.ok) return { total: 0, outcomes: {}, avgSteps: 0, recent24h: 0 };
    return res.json();
  } catch (err) {
    console.warn('[api] fetchTraceStats failed:', err);
    return { total: 0, outcomes: {}, avgSteps: 0, recent24h: 0 };
  }
}

export async function fetchTraces(agentId: string) {
  try {
    const res = await fetch(`${API_BASE}/agents/${agentId}/traces`);
    if (!res.ok) return [];
    return res.json();
  } catch (err) {
    console.warn('[api] fetchTraces failed:', err);
    return [];
  }
}

export async function fetchFeedbackStats(agentId: string) {
  try {
    const res = await fetch(`${API_BASE}/agents/${agentId}/feedback/stats`);
    if (!res.ok) return { total: 0, types: {}, recent24h: 0 };
    return res.json();
  } catch (err) {
    console.warn('[api] fetchFeedbackStats failed:', err);
    return { total: 0, types: {}, recent24h: 0 };
  }
}

// ── Mutation operations (throw on !res.ok) ─────────────────────────

export async function sendMessage(agentId: string, content: string) {
  const res = await fetch(`${API_BASE}/agents/${agentId}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new Error(`sendMessage failed: ${res.status} ${res.statusText}`);
  return res.json();
}

export async function sendInterrupt(agentId: string, action: string, data?: unknown) {
  const res = await fetch(`${API_BASE}/agents/${agentId}/interrupt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, data }),
  });
  if (!res.ok) throw new Error(`sendInterrupt failed: ${res.status} ${res.statusText}`);
  return res.json();
}

export function createSSEConnection(agentId: string): EventSource {
  return new EventSource(`${API_BASE}/agents/${agentId}/stream`);
}

export async function startBackgroundRun(agentId: string, task: string) {
  const res = await fetch(`${API_BASE}/agents/${agentId}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task, mode: 'background' }),
  });
  if (!res.ok) throw new Error(`startBackgroundRun failed: ${res.status} ${res.statusText}`);
  return res.json();
}

export async function cancelRun(agentId: string, runId: string) {
  const res = await fetch(`${API_BASE}/agents/${agentId}/runs/${runId}/cancel`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error(`cancelRun failed: ${res.status} ${res.statusText}`);
  return res.json();
}

export async function deleteKnowledgeItem(agentId: string, itemId: string) {
  const res = await fetch(`${API_BASE}/agents/${agentId}/knowledge/${itemId}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error('Failed to delete knowledge item');
  return res.json();
}

export async function listFiles(agentId: string, path: string) {
  const res = await fetch(
    `${API_BASE}/agents/${agentId}/files?path=${encodeURIComponent(path)}`,
  );
  if (!res.ok) throw new Error('Failed to list files');
  return res.json();
}

export async function readFile(agentId: string, path: string) {
  const res = await fetch(
    `${API_BASE}/agents/${agentId}/files/read?path=${encodeURIComponent(path)}`,
  );
  if (!res.ok) throw new Error('Failed to read file');
  return res.json();
}
