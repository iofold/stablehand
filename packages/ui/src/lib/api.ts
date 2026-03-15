const API_BASE = '/api';

// ── Session types ────────────────────────────────────────────────────

export interface FileDiff {
  path: string;
  type: 'added' | 'modified' | 'deleted';
}

export interface PromoteResult {
  added: number;
  modified: number;
  deleted: number;
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

export async function fetchRuns(agentId: string) {
  return apiFetch(`${API_BASE}/agents/${agentId}/runs`);
}

export async function fetchAllActiveRuns() {
  return apiFetch(`${API_BASE}/runs`);
}

export async function fetchConversations(agentId: string) {
  return apiFetch(`${API_BASE}/agents/${agentId}/conversations`);
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

export async function sendMessage(agentId: string, content: string, conversationId?: string) {
  return apiMutate(`${API_BASE}/agents/${agentId}/message`, 'POST', { content, conversationId });
}

export async function sendInterrupt(agentId: string, action: string, data?: unknown, runId?: string) {
  return apiMutate(`${API_BASE}/agents/${agentId}/interrupt`, 'POST', { action, data, runId });
}

export function createSSEConnection(agentId: string): EventSource {
  return new EventSource(`${API_BASE}/agents/${agentId}/stream`);
}

export async function startBackgroundRun(agentId: string, task: string) {
  return apiMutate(`${API_BASE}/agents/${agentId}/run`, 'POST', { task, mode: 'background' });
}

export async function cancelRun(agentId: string, runId: string) {
  return apiMutate(`${API_BASE}/agents/${agentId}/runs/${runId}/cancel`, 'POST');
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

export async function listFiles(agentId: string, path: string, runId?: string): Promise<ListFilesResponse> {
  const params = new URLSearchParams({ path });
  if (runId) params.set('runId', runId);
  return apiFetch<ListFilesResponse>(`${API_BASE}/agents/${agentId}/files?${params}`);
}

export async function readFile(agentId: string, path: string, runId?: string): Promise<ReadFileResponse> {
  const params = new URLSearchParams({ path });
  if (runId) params.set('runId', runId);
  return apiFetch<ReadFileResponse>(`${API_BASE}/agents/${agentId}/files/read?${params}`);
}

export async function createFile(agentId: string, path: string, content: string) {
  return apiMutate<{ path: string; size: number }>(`${API_BASE}/agents/${agentId}/files`, 'POST', { path, content });
}

export async function updateFile(agentId: string, path: string, content: string) {
  return apiMutate<{ path: string; size: number }>(`${API_BASE}/agents/${agentId}/files`, 'PUT', { path, content });
}

export async function deleteFile(agentId: string, path: string): Promise<void> {
  const params = new URLSearchParams({ path });
  await apiFetch(`${API_BASE}/agents/${agentId}/files?${params}`, { method: 'DELETE' });
}

export async function createAgent(data: {
  name: string;
  model: string;
  systemPrompt: string;
  tools: string[];
  description?: string;
  metadata?: Record<string, unknown>;
}) {
  return apiMutate(`${API_BASE}/agents`, 'POST', data);
}

export async function updateAgent(id: string, data: Partial<{
  name: string;
  model: string;
  systemPrompt: string;
  tools: string[];
  description?: string;
  metadata?: Record<string, unknown>;
}>) {
  return apiMutate(`${API_BASE}/agents/${id}`, 'PUT', data);
}

// ── Skill types (Agent Skills Standard / SKILL.md format) ───────────

export interface SkillFrontmatter {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, unknown>;
  'allowed-tools'?: string;
}

export interface LoadedSkill {
  name: string;
  description: string;
  path: string;
  source: 'project' | 'personal' | 'plugin' | 'marketplace';
  frontmatter: SkillFrontmatter;
  instructions: string;
  scripts: string[];
  references: string[];
  assets: string[];
}

export interface LegacySkill {
  name: string;
  filename: string;
  content: string;
}

/** @deprecated Use LoadedSkill instead — kept for backward compatibility */
export type SkillFile = LegacySkill;

export async function fetchSkills(agentId: string): Promise<{ skills: LoadedSkill[]; legacySkills: LegacySkill[] }> {
  return apiFetch<{ skills: LoadedSkill[]; legacySkills: LegacySkill[] }>(
    `${API_BASE}/agents/${agentId}/skills`,
  );
}

export async function createSkill(
  agentId: string,
  data: { name: string; description: string; instructions: string; scripts?: Record<string, string> },
): Promise<LoadedSkill> {
  return apiMutate<LoadedSkill>(`${API_BASE}/agents/${agentId}/skills`, 'POST', data);
}

export async function updateSkill(
  agentId: string,
  skillName: string,
  data: { description?: string; instructions?: string },
): Promise<LoadedSkill> {
  return apiMutate<LoadedSkill>(
    `${API_BASE}/agents/${agentId}/skills/${encodeURIComponent(skillName)}`,
    'PUT',
    data,
  );
}

export async function deleteSkill(agentId: string, skillName: string): Promise<void> {
  await apiFetch(`${API_BASE}/agents/${agentId}/skills/${encodeURIComponent(skillName)}`, { method: 'DELETE' });
}

export async function deleteAgent(id: string): Promise<void> {
  await apiFetch(`${API_BASE}/agents/${id}`, { method: 'DELETE' });
}

// ── Session lifecycle operations ─────────────────────────────────────

export async function fetchSessionDiff(agentId: string, runId: string): Promise<FileDiff[]> {
  const data = await apiFetch<{ changes?: FileDiff[] }>(`${API_BASE}/agents/${agentId}/runs/${runId}/diff`);
  return data.changes ?? [];
}

export async function promoteSession(agentId: string, runId: string): Promise<PromoteResult> {
  return apiMutate<PromoteResult>(`${API_BASE}/agents/${agentId}/runs/${runId}/promote`, 'POST');
}

export async function forkSession(agentId: string, runId: string, newAgentName: string): Promise<{ agentId: string }> {
  return apiMutate<{ agentId: string }>(`${API_BASE}/agents/${agentId}/runs/${runId}/fork`, 'POST', { name: newAgentName });
}

export async function discardSession(agentId: string, runId: string): Promise<void> {
  await apiFetch(`${API_BASE}/agents/${agentId}/runs/${runId}/session`, { method: 'DELETE' });
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
}

export async function fetchCatalogTools(): Promise<CatalogTool[]> {
  return apiFetch<CatalogTool[]>(`${API_BASE}/catalogs/tools`);
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
