import { getApiToken, markAuthRequired, withApiAuth } from './auth';
import type { ApiAgent, ApiConversationSummary, ApiFeedbackRequest, ApiSandboxRestoreSuccess } from '@ctxmill/shared';

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

function extractErrorDetail(body: unknown): string {
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    for (const key of ['error', 'message', 'detail']) {
      const value = record[key];
      if (typeof value === 'string' && value.trim().length > 0) {
        return value;
      }
    }

    if (Object.keys(record).length === 0) {
      return '';
    }
  }

  if (typeof body === 'string') {
    return body;
  }

  if (body == null) {
    return '';
  }

  return JSON.stringify(body);
}

async function readErrorDetail(res: Response): Promise<string> {
  try {
    return extractErrorDetail(await res.json());
  } catch {
    return await res.text().catch(() => '');
  }
}

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, withApiAuth(init));
  if (res.status === 401) {
    markAuthRequired();
  }
  if (!res.ok) {
    const method = init?.method ?? 'GET';
    const baseMessage = `API ${method} ${url} failed: ${res.status}`;
    const errorDetail = await readErrorDetail(res);
    throw new Error(errorDetail ? `${baseMessage} - ${errorDetail}` : baseMessage);
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

function withQuery(
  path: string,
  params?: Record<string, string | number | boolean | null | undefined>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value != null && value !== '') {
      search.set(key, String(value));
    }
  }

  const query = search.toString();
  return query ? `${path}?${query}` : path;
}

// ── Query operations (throw on failure) ─────────────────────────────

export async function fetchAgents(): Promise<ApiAgent[]> {
  return apiFetch<ApiAgent[]>(`${API_BASE}/agents`);
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

export async function fetchConversationSummaries(agentId: string): Promise<{ conversations: ApiConversationSummary[] }> {
  return apiFetch<{ conversations: ApiConversationSummary[] }>(`${API_BASE}/agents/${agentId}/conversations/summary`);
}

export async function fetchMessages(agentId: string, conversationId: string) {
  return apiFetch(`${API_BASE}/agents/${agentId}/conversations/${conversationId}/messages`);
}

export async function submitFeedback(
  agentId: string,
  data: ApiFeedbackRequest,
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

export type PendingInterrupt = {
  id: string;
  sessionId: string;
  agentId: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  status: string;
  createdAt?: number;
  resumeError?: string;
};

export async function fetchInterrupts(agentId: string): Promise<PendingInterrupt[]> {
  const data = await apiFetch<{ interrupts?: PendingInterrupt[] }>(
    `${API_BASE}/agents/${agentId}/interrupts`,
  );
  return Array.isArray(data.interrupts) ? data.interrupts : [];
}

export function createSSEConnection(agentId: string): EventSource {
  const token = getApiToken();
  const url = `${API_BASE}/agents/${agentId}/stream`;
  if (!token) {
    return new EventSource(url);
  }
  const params = new URLSearchParams({ access_token: token });
  return new EventSource(`${url}?${params}`);
}

export async function startBackgroundRun(agentId: string, task: string) {
  return apiMutate(`${API_BASE}/agents/${agentId}/session`, 'POST', { task, mode: 'background' });
}

export async function cancelRun(agentId: string, sessionId: string) {
  return apiMutate(`${API_BASE}/agents/${agentId}/sessions/${sessionId}/cancel`, 'POST');
}

/**
 * Trigger a manual restore of a CHECKPOINTED sandbox session per ADR 013.
 * The endpoint is owned by Track 2; this caller is the UI's "Retry restore"
 * action surfaced when an automatic restore failed.
 */
export async function restoreSandboxSession(agentId: string, sandboxSessionId: string): Promise<ApiSandboxRestoreSuccess> {
  return apiMutate<ApiSandboxRestoreSuccess>(
    `${API_BASE}/agents/${agentId}/sandbox-sessions/${sandboxSessionId}/restore?async=true`,
    'POST',
  );
}

export interface ListFilesResponse {
  entries: Array<{ name: string; type: 'file' | 'directory'; size: number }>;
}

export interface ReadFileResponse {
  content: string;
  size: number;
}

export async function listFiles(agentId: string, path: string, sessionId?: string): Promise<ListFilesResponse> {
  return apiFetch<ListFilesResponse>(
    withQuery(`${API_BASE}/agents/${agentId}/files`, { path, sessionId }),
  );
}

export async function readFile(agentId: string, path: string, sessionId?: string): Promise<ReadFileResponse> {
  return apiFetch<ReadFileResponse>(
    withQuery(`${API_BASE}/agents/${agentId}/files/read`, { path, sessionId }),
  );
}

export async function createFile(agentId: string, path: string, content: string, sessionId?: string) {
  return apiMutate<{ path: string; size: number }>(
    withQuery(`${API_BASE}/agents/${agentId}/files`, { sessionId }),
    'POST',
    { path, content },
  );
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

export interface UploadWorkspaceResponse {
  files: number;
  totalBytes: number;
}

export async function uploadWorkspaceTarball(
  agentId: string,
  file: File,
  options?: { force?: boolean },
): Promise<UploadWorkspaceResponse> {
  return apiFetch<UploadWorkspaceResponse>(
    withQuery(`${API_BASE}/agents/${agentId}/workspace`, { force: options?.force ? 'true' : undefined }),
    {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/gzip' },
      body: file,
    },
  );
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
  return apiFetch<Trigger[]>(withQuery(`${API_BASE}/triggers`, { agentId }));
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
  system?: {
    version?: string;
    uptime?: number;
    dbPath?: string;
  };
  agentDefaults?: {
    harness?: string;
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
  return apiFetch<EventsResponse>(withQuery(`${API_BASE}/events`, params));
}

export async function fetchEventStats(range?: string): Promise<EventStats> {
  return apiFetch<EventStats>(withQuery(`${API_BASE}/events/stats`, { range }));
}

export async function fetchEventTypes(): Promise<{ types: string[] }> {
  return apiFetch<{ types: string[] }>(`${API_BASE}/events/types`);
}

// ── Artifact operations ─────────────────────────────────────────────

export interface Artifact {
  id: string;
  agentId: string | null;
  sessionId?: string | null;
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
  return apiFetch<{ artifacts: Artifact[] }>(
    withQuery(`${API_BASE}/artifacts`, { agentId, sessionId }),
  );
}

export async function fetchAllArtifacts(options?: {
  limit?: number;
  offset?: number;
  search?: string;
}): Promise<{ artifacts: Artifact[]; total: number }> {
  return apiFetch<{ artifacts: Artifact[]; total: number }>(
    withQuery(`${API_BASE}/artifacts`, options),
  );
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
  const res = await fetch(`${API_BASE}/artifacts/upload-url`, withApiAuth({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId, name, mimeType, sizeBytes }),
  }));
  if (res.status === 401) {
    markAuthRequired();
  }
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

  const response = await fetch(`${API_BASE}/artifacts/upload`, withApiAuth({
    method: 'POST',
    body: formData,
    // Do NOT set Content-Type header — browser sets it with boundary automatically
  }));

  if (response.status === 401) {
    markAuthRequired();
  }
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Upload failed' }));
    throw new Error(error.error || `Upload failed: ${response.status}`);
  }

  return response.json();
}
