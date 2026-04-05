const API_BASE = '/api';

// ── Session types ────────────────────────────────────────────────────

export interface HttpToolDefinition {
  name: string;
  description: string;
  endpoint: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  inputSchema?: Record<string, unknown>;
  headers?: Record<string, string>;
  timeout?: number;
  authentication?: {
    type: 'bearer' | 'api-key' | 'none';
    token?: string;
    apiKey?: string;
  };
}

// ── Internal fetch helpers ───────────────────────────────────────────

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    throw new Error(`API ${init?.method ?? 'GET'} ${url} failed: ${res.status}`);
  }
  // 204 No Content — nothing to parse
  if (res.status === 204) return undefined as unknown as T;
  return res.json();
}

async function apiMutate<T>(url: string, method: string, body?: unknown): Promise<T> {
  return apiFetch<T>(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

// ── Query operations (throw on failure) ─────────────────────────────

export async function fetchAgents() {
  return apiFetch(`${API_BASE}/agents`);
}

export async function fetchAgent(id: string) {
  return apiFetch(`${API_BASE}/agents/${id}`);
}

export async function fetchSessions(agentId: string) {
  return apiFetch(`${API_BASE}/agents/${agentId}/sessions`);
}

export async function fetchTurns(agentId: string) {
  return apiFetch(`${API_BASE}/agents/${agentId}/turns`);
}

export async function fetchAllActiveSessions() {
  return apiFetch(`${API_BASE}/sessions?format=sandbox`);
}

export async function fetchActiveConversations() {
  return apiFetch(`${API_BASE}/sessions`);
}

export async function fetchConversations(agentId: string) {
  return apiFetch(`${API_BASE}/agents/${agentId}/conversations`);
}

export async function fetchConversationSummaries(agentId: string) {
  return apiFetch(`${API_BASE}/agents/${agentId}/conversations/summary`);
}

export async function fetchMessages(agentId: string, conversationId: string) {
  return apiFetch(`${API_BASE}/agents/${agentId}/conversations/${conversationId}/messages`);
}

export async function fetchKnowledge(agentId: string, params?: { q?: string; category?: string }) {
  const url = new URL(`${API_BASE}/agents/${agentId}/knowledge`, window.location.origin);
  if (params?.q) url.searchParams.set('q', params.q);
  if (params?.category) url.searchParams.set('category', params.category);
  return apiFetch(url.toString());
}

export async function fetchKnowledgeStats(agentId: string) {
  return apiFetch(`${API_BASE}/agents/${agentId}/knowledge/stats`);
}

// ── Shared knowledge operations ─────────────────────────────────────

export async function fetchSharedKnowledge(params?: { q?: string; category?: string }) {
  const url = new URL(`${API_BASE}/knowledge/shared`, window.location.origin);
  if (params?.q) url.searchParams.set('q', params.q);
  if (params?.category) url.searchParams.set('category', params.category);
  return apiFetch(url.toString());
}

export async function fetchSharedKnowledgeStats() {
  return apiFetch(`${API_BASE}/knowledge/shared/stats`);
}

export async function addSharedKnowledge(data: { content: string; category?: string; source?: string }) {
  return apiMutate(`${API_BASE}/knowledge/shared`, 'POST', data);
}

export async function deleteSharedKnowledge(itemId: string) {
  return apiMutate(`${API_BASE}/knowledge/shared/${itemId}`, 'DELETE');
}

export async function searchAllKnowledge(params?: { q?: string; category?: string; limit?: number }) {
  const url = new URL(`${API_BASE}/knowledge/search`, window.location.origin);
  if (params?.q) url.searchParams.set('q', params.q);
  if (params?.category) url.searchParams.set('category', params.category);
  if (params?.limit) url.searchParams.set('limit', String(params.limit));
  return apiFetch(url.toString());
}

export async function fetchTraceStats(agentId: string) {
  return apiFetch(`${API_BASE}/agents/${agentId}/traces/stats`);
}

export async function fetchTraces(agentId: string) {
  return apiFetch(`${API_BASE}/agents/${agentId}/traces`);
}

export async function fetchFeedbackStats(agentId: string) {
  return apiFetch(`${API_BASE}/agents/${agentId}/feedback/stats`);
}

export async function submitFeedback(
  agentId: string,
  data: { conversationId: string; messageId: string; type: 'thumbs_up' | 'thumbs_down' },
): Promise<void> {
  await apiMutate(`${API_BASE}/agents/${agentId}/feedback`, 'POST', data);
}

// ── Mutation operations (throw on !res.ok) ─────────────────────────

export async function sendMessage(
  agentId: string,
  content: string,
  conversationId?: string,
): Promise<{ messageId: string; conversationId: string }> {
  return apiMutate<{ messageId: string; conversationId: string }>(
    `${API_BASE}/agents/${agentId}/message`,
    'POST',
    { content, conversationId },
  );
}

export async function sendInterrupt(agentId: string, action: string, data?: unknown, sessionId?: string) {
  return apiMutate(`${API_BASE}/agents/${agentId}/interrupt`, 'POST', { action, data, sessionId });
}

export async function fetchInterrupts(agentId: string): Promise<Array<{
  id: string;
  sessionId: string;
  agentId: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  status: string;
}>> {
  return apiFetch(`${API_BASE}/agents/${agentId}/interrupts`);
}

export function createSSEConnection(agentId: string): EventSource {
  return new EventSource(`${API_BASE}/agents/${agentId}/stream`);
}

export async function startBackgroundRun(agentId: string, task: string) {
  return apiMutate(`${API_BASE}/agents/${agentId}/session`, 'POST', { task, mode: 'background' });
}

export async function cancelRun(agentId: string, sessionId: string) {
  return apiMutate(`${API_BASE}/agents/${agentId}/sessions/${sessionId}/cancel`, 'POST');
}

export async function deleteKnowledgeItem(agentId: string, itemId: string) {
  return apiMutate(`${API_BASE}/agents/${agentId}/knowledge/${itemId}`, 'DELETE');
}

export interface ListFilesResponse {
  entries: Array<{ name: string; type: 'file' | 'directory'; size: number }>;
}

export interface ReadFileResponse {
  content: string;
  size: number;
}

export async function listFiles(agentId: string, path: string, sessionId?: string): Promise<ListFilesResponse> {
  const params = new URLSearchParams({ path });
  if (sessionId) params.set('sessionId', sessionId);
  return apiFetch<ListFilesResponse>(`${API_BASE}/agents/${agentId}/files?${params}`);
}

export async function readFile(agentId: string, path: string, sessionId?: string): Promise<ReadFileResponse> {
  const params = new URLSearchParams({ path });
  if (sessionId) params.set('sessionId', sessionId);
  return apiFetch<ReadFileResponse>(`${API_BASE}/agents/${agentId}/files/read?${params}`);
}

export async function createFile(agentId: string, path: string, content: string, sessionId?: string) {
  const params = new URLSearchParams();
  if (sessionId) params.set('sessionId', sessionId);
  const url = `${API_BASE}/agents/${agentId}/files${params.size > 0 ? `?${params}` : ''}`;
  return apiMutate<{ path: string; size: number }>(url, 'POST', { path, content });
}

export async function updateFile(agentId: string, path: string, content: string, sessionId?: string) {
  const params = new URLSearchParams();
  if (sessionId) params.set('sessionId', sessionId);
  const url = `${API_BASE}/agents/${agentId}/files${params.size > 0 ? `?${params}` : ''}`;
  return apiMutate<{ path: string; size: number }>(url, 'PUT', { path, content });
}

export async function deleteFile(agentId: string, path: string, sessionId?: string): Promise<void> {
  const params = new URLSearchParams({ path });
  if (sessionId) params.set('sessionId', sessionId);
  await apiFetch(`${API_BASE}/agents/${agentId}/files?${params}`, { method: 'DELETE' });
}

export async function createAgent(data: {
  name: string;
  harness: string;
  harnessConfig: Record<string, unknown>;
  systemPrompt: string;
  tools: string[];
  description?: string;
  metadata?: Record<string, unknown>;
  httpTools?: HttpToolDefinition[];
}) {
  return apiMutate(`${API_BASE}/agents`, 'POST', data);
}

export async function updateAgent(id: string, data: Partial<{
  name: string;
  harness: string;
  harnessConfig: Record<string, unknown>;
  systemPrompt: string;
  tools: string[];
  description?: string;
  metadata?: Record<string, unknown>;
  httpTools?: HttpToolDefinition[];
}>) {
  return apiMutate(`${API_BASE}/agents/${id}`, 'PUT', data);
}

// ── Agent Secrets operations ──────────────────────────────────────────

export async function fetchSecretKeys(agentId: string): Promise<{ keys: string[] }> {
  return apiFetch<{ keys: string[] }>(`${API_BASE}/agents/${agentId}/secrets`);
}

export async function setSecret(agentId: string, key: string, value: string): Promise<{ key: string }> {
  return apiMutate<{ key: string }>(`${API_BASE}/agents/${agentId}/secrets`, 'POST', { key, value });
}

export async function deleteSecret(agentId: string, key: string): Promise<void> {
  await apiFetch(`${API_BASE}/agents/${agentId}/secrets/${encodeURIComponent(key)}`, { method: 'DELETE' });
}

export async function deleteAgent(id: string): Promise<void> {
  await apiFetch(`${API_BASE}/agents/${id}`, { method: 'DELETE' });
}

// ── Trigger operations ──────────────────────────────────────────────

export interface Trigger {
  id: string;
  agentId: string;
  eventType: string;
  selector?: Record<string, unknown>;
  taskTemplate: string;
  enabled: boolean;
  createdAt?: number;
}

export async function fetchTriggers(agentId?: string): Promise<Trigger[]> {
  const params = agentId ? `?agentId=${agentId}` : '';
  return apiFetch<Trigger[]>(`${API_BASE}/triggers${params}`);
}

export async function createTrigger(data: {
  agentId: string;
  eventType: string;
  selector?: Record<string, unknown>;
  taskTemplate: string;
  enabled?: boolean;
}): Promise<Trigger> {
  return apiMutate<Trigger>(`${API_BASE}/triggers`, 'POST', data);
}

export async function updateTrigger(id: string, data: Partial<{
  eventType: string;
  selector: Record<string, unknown>;
  taskTemplate: string;
  enabled: boolean;
}>): Promise<Trigger> {
  return apiMutate<Trigger>(`${API_BASE}/triggers/${id}`, 'PUT', data);
}

export async function deleteTrigger(id: string): Promise<void> {
  await apiFetch(`${API_BASE}/triggers/${id}`, { method: 'DELETE' });
}

// ── Catalog operations ──────────────────────────────────────────────

export interface CatalogTool {
  name: string;
  description?: string;
  source: 'local' | 'mcp' | 'composio';
  inputSchema?: Record<string, unknown>;
  requiresApproval?: boolean;
  secrets?: string[];
  builtin?: boolean;
  location?: 'sandbox' | 'orchestrator' | 'daemon';
}

export async function fetchCatalogTools(): Promise<CatalogTool[]> {
  return apiFetch<CatalogTool[]>(`${API_BASE}/catalogs/tools`);
}

export async function testTool(toolName: string, input?: Record<string, unknown>): Promise<{
  success: boolean;
  result?: string;
  error?: string;
  durationMs: number;
}> {
  return apiMutate(`${API_BASE}/catalogs/tools/test`, 'POST', { toolName, input });
}

// ── Config operations ───────────────────────────────────────────────

export interface AppConfig {
  llm?: {
    provider?: string;
    model?: string;
    baseUrl?: string;
  };
  system?: {
    version?: string;
    uptime?: number;
    dbPath?: string;
  };
  agentDefaults?: {
    harness?: string;
    model?: string;
    temperature?: number;
    maxTokens?: number;
  };
  [key: string]: unknown;
}

export async function fetchConfig(): Promise<AppConfig> {
  return apiFetch<AppConfig>(`${API_BASE}/config`);
}

// ── Workspace Size Limit Settings ───────────────────────────

export interface SystemSettings {
  maxWorkspaceTarBytes:        number;
  maxCheckpointBytes:          number;
  maxTarUploadBytes:           number;
  idleTimeoutMs:               number;
  turnTimeoutMs:               number;
  reconciliationIntervalMs:    number;
  maxGlobalContainers:         number;
  queueTimeoutMs:              number;
  maxConcurrentSessionsPerAgent: number;
  maxTriggerDepth:             number;
  defaultCpus:                 number;
  defaultMemoryMb:             number;
  defaultPidsLimit:            number;
  defaultTimeoutSec:           number;
}

export async function fetchSettings(): Promise<SystemSettings> {
  return apiFetch<SystemSettings>(`${API_BASE}/settings`);
}

export async function updateSettings(
  partial: Partial<SystemSettings>,
): Promise<SystemSettings> {
  return apiMutate<SystemSettings>(`${API_BASE}/settings`, 'PUT', partial);
}

// ── Event Log operations ────────────────────────────────────────────

export interface EventRecord {
  seq: number;
  type: string;
  agentId: string;
  payload: string;
  createdAt: number;
}

export interface EventsResponse {
  events: EventRecord[];
  nextCursor?: number;
}

export interface EventStats {
  total: number;
  byType: Record<string, number>;
  topAgents: Array<{ agentId: string; count: number }>;
  recentRate: number;
}

export async function fetchEvents(params?: {
  cursor?: number;
  limit?: number;
  type?: string;
  agentId?: string;
  since?: number;
}): Promise<EventsResponse> {
  const url = new URL(`${API_BASE}/events`, window.location.origin);
  if (params?.cursor) url.searchParams.set('cursor', String(params.cursor));
  if (params?.limit) url.searchParams.set('limit', String(params.limit));
  if (params?.type) url.searchParams.set('type', params.type);
  if (params?.agentId) url.searchParams.set('agentId', params.agentId);
  if (params?.since) url.searchParams.set('since', String(params.since));
  return apiFetch<EventsResponse>(url.toString());
}

export async function fetchEventStats(range?: string): Promise<EventStats> {
  const url = new URL(`${API_BASE}/events/stats`, window.location.origin);
  if (range) url.searchParams.set('range', range);
  return apiFetch<EventStats>(url.toString());
}

export async function fetchEventTypes(): Promise<{ types: string[] }> {
  return apiFetch<{ types: string[] }>(`${API_BASE}/events/types`);
}

// ── Artifact operations ─────────────────────────────────────────────

export interface Artifact {
  id: string;
  agentId: string;
  sessionId?: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  storageKey: string;
  bucket: string;
  status: string;
  metadata?: Record<string, unknown>;
  createdAt?: number;
}

export async function fetchArtifacts(agentId: string, sessionId?: string): Promise<{ artifacts: Artifact[] }> {
  const params = new URLSearchParams({ agentId });
  if (sessionId) params.set('sessionId', sessionId);
  return apiFetch<{ artifacts: Artifact[] }>(`${API_BASE}/artifacts?${params}`);
}

export async function fetchAllArtifacts(options?: {
  limit?: number;
  offset?: number;
  search?: string;
}): Promise<{ artifacts: Artifact[]; total: number }> {
  const params = new URLSearchParams();
  if (options?.limit) params.set('limit', String(options.limit));
  if (options?.offset) params.set('offset', String(options.offset));
  if (options?.search) params.set('search', options.search);
  return apiFetch<{ artifacts: Artifact[]; total: number }>(`${API_BASE}/artifacts?${params}`);
}

export async function fetchArtifact(id: string): Promise<Artifact> {
  return apiFetch<Artifact>(`${API_BASE}/artifacts/${id}`);
}

export async function fetchArtifactDownloadUrl(id: string): Promise<{ url: string; expiresIn: number; name: string; mimeType: string; sizeBytes: number }> {
  return apiFetch(`${API_BASE}/artifacts/${id}/download-url`);
}

export async function deleteArtifact(id: string): Promise<void> {
  await apiFetch(`${API_BASE}/artifacts/${id}`, { method: 'DELETE' });
}

export async function requestArtifactUploadUrl(agentId: string, name: string, mimeType: string, sizeBytes: number): Promise<{ artifactId: string; uploadUrl: string; storageKey: string; expiresIn: number }> {
  const res = await fetch(`${API_BASE}/artifacts/upload-url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId, name, mimeType, sizeBytes }),
  });
  if (!res.ok) throw new Error(`Upload URL request failed: ${res.status}`);
  return res.json();
}

export async function uploadArtifactToSignedUrl(uploadUrl: string, file: File): Promise<void> {
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  });
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
}

export async function uploadArtifactDirect(
  file: File,
  agentId: string,
  name?: string,
): Promise<Artifact> {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('agentId', agentId);
  if (name) {
    formData.append('name', name);
  }

  const response = await fetch(`${API_BASE}/artifacts/upload`, {
    method: 'POST',
    body: formData,
    // Do NOT set Content-Type header — browser sets it with boundary automatically
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Upload failed' }));
    throw new Error(error.error || `Upload failed: ${response.status}`);
  }

  return response.json();
}
