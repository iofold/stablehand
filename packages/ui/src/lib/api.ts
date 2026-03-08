const API_BASE = '/api';

export async function fetchAgents() {
  const res = await fetch(`${API_BASE}/agents`);
  return res.json();
}

export async function fetchAgent(id: string) {
  const res = await fetch(`${API_BASE}/agents/${id}`);
  return res.json();
}

export async function sendMessage(agentId: string, content: string) {
  const res = await fetch(`${API_BASE}/agents/${agentId}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  return res.json();
}

export async function sendInterrupt(agentId: string, action: string, data?: unknown) {
  const res = await fetch(`${API_BASE}/agents/${agentId}/interrupt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, data }),
  });
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
  return res.json();
}

export async function cancelRun(agentId: string, runId: string) {
  const res = await fetch(`${API_BASE}/agents/${agentId}/runs/${runId}/cancel`, {
    method: 'POST',
  });
  return res.json();
}

export async function fetchRuns(agentId: string) {
  const res = await fetch(`${API_BASE}/agents/${agentId}/runs`);
  return res.json();
}

export async function fetchAllActiveRuns() {
  const res = await fetch(`${API_BASE}/runs`);
  return res.json();
}

export async function fetchConversations(agentId: string) {
  const res = await fetch(`${API_BASE}/agents/${agentId}/conversations`);
  if (!res.ok) return [];
  return res.json();
}

export async function fetchMessages(agentId: string, conversationId: string) {
  const res = await fetch(`${API_BASE}/agents/${agentId}/conversations/${conversationId}/messages`);
  if (!res.ok) return [];
  return res.json();
}

export async function fetchKnowledge(agentId: string, params?: { search?: string; category?: string }) {
  const url = new URL(`${API_BASE}/agents/${agentId}/knowledge`, window.location.origin);
  if (params?.search) url.searchParams.set('search', params.search);
  if (params?.category) url.searchParams.set('category', params.category);
  const res = await fetch(url.toString());
  if (!res.ok) return [];
  return res.json();
}

export async function fetchKnowledgeStats(agentId: string) {
  const res = await fetch(`${API_BASE}/agents/${agentId}/knowledge/stats`);
  if (!res.ok) return { total: 0, categories: {} };
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
