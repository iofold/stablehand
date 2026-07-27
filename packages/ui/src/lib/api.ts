import { getApiToken, markAuthRequired, withApiAuth } from './auth';
import type {
  ApiFeedbackRequest,
  ApiSandboxRestoreSuccess,
} from '@ctxmill/shared';
import {
  ActiveConversationListResponseSchema,
  AgentBudgetStatusListResponseSchema,
  AgentCreateInputSchema,
  AgentListResponseSchema,
  AgentPatchInputSchema,
  AgentSchema,
  AnalyticsOverviewSchema,
  AnalyticsWindowSchema,
  BudgetPolicyCreateInputSchema,
  BudgetPolicyListResponseSchema,
  BudgetPolicyPatchInputSchema,
  BudgetPolicySchema,
  BudgetSpendResponseSchema,
  ConversationListResponseSchema,
  ConversationSnapshotResponseSchema,
  ConversationSummaryListResponseSchema,
  ConversationTurnStartInputSchema,
  FileListResponseSchema,
  FileReadResponseSchema,
  FileWriteResponseSchema,
  InterruptResolveInputSchema,
  ModelGatewayQuarantineSchema,
  ModelGatewayStatusSchema,
  type ModelGatewayQuarantine,
  SecretListResponseSchema,
  SecretPutInputSchema,
  SecretPutResponseSchema,
  SandboxSessionListResponseSchema,
  TurnListResponseSchema,
  WorkspaceReplaceResponseSchema,
  type Conversation,
  type ConversationSnapshot,
  type Agent,
  type AgentCreateInput,
  type AgentPatchInput,
  type AgentBudgetStatus,
  type Artifact,
  type AnalyticsOverview,
  type AnalyticsWindow,
  type BudgetPolicy,
  type BudgetPolicyCreateInput,
  type BudgetPolicyPatchInput,
  type BudgetSpendResponse,
  type ConversationSummary,
  type ConversationTurnStartInput,
  type EventListInput,
  type EventListResponse,
  type InterruptResolveInput,
  type ModelGatewayStatus,
  type PersistedEvent,
  type SandboxSession,
  type Turn,
} from '@ctxmill/contracts';

const API_BASE = '/api';

// ── Session types ────────────────────────────────────────────────────

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

/**
 * Error from a non-2xx API response, keeping the parsed body so callers can
 * react to structured error codes (e.g. budget_exceeded) instead of string
 * matching on the message.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
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
    let body: unknown = null;
    let errorDetail = '';
    try {
      body = await res.json();
      errorDetail = extractErrorDetail(body);
    } catch {
      errorDetail = await res.text().catch(() => '');
    }
    throw new ApiError(
      errorDetail ? `${baseMessage} - ${errorDetail}` : baseMessage,
      res.status,
      body,
    );
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

export async function fetchAgents(): Promise<Agent[]> {
  const response = await apiFetch<unknown>(`${API_BASE}/agents`);
  return AgentListResponseSchema.parse(response);
}

export async function fetchAgent(id: string): Promise<Agent> {
  const response = await apiFetch<unknown>(`${API_BASE}/agents/${id}`);
  return AgentSchema.parse(response);
}

export async function fetchAgentTurns(agentId: string): Promise<Turn[]> {
  const response = await apiFetch<unknown>(`${API_BASE}/agents/${agentId}/turns`);
  return TurnListResponseSchema.parse(response).turns;
}

export async function fetchActiveSandboxSessions(): Promise<SandboxSession[]> {
  const response = await apiFetch<unknown>(`${API_BASE}/sandbox-sessions?status=active`);
  return SandboxSessionListResponseSchema.parse(response);
}

export async function fetchActiveConversations(): Promise<ConversationSummary[]> {
  const response = await apiFetch<unknown>(`${API_BASE}/conversations?status=active`);
  return ActiveConversationListResponseSchema.parse(response);
}

export async function fetchConversations(agentId: string): Promise<Conversation[]> {
  const response = await apiFetch<unknown>(`${API_BASE}/agents/${agentId}/conversations`);
  return ConversationListResponseSchema.parse(response);
}

export async function fetchConversationSummaries(agentId: string): Promise<{ conversations: ConversationSummary[] }> {
  const response = await apiFetch<unknown>(`${API_BASE}/agents/${agentId}/conversations/summary`);
  return ConversationSummaryListResponseSchema.parse(response);
}

export async function fetchConversationSnapshot(
  agentId: string,
  conversationId: string,
): Promise<ConversationSnapshot> {
  const response = await apiFetch<unknown>(
    `${API_BASE}/agents/${agentId}/conversations/${conversationId}/snapshot`,
  );
  return ConversationSnapshotResponseSchema.parse(response);
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
  input: ConversationTurnStartInput,
): Promise<{ messageId: string; conversationId: string; turnId: string }> {
  return apiMutate<{ messageId: string; conversationId: string; turnId: string }>(
    `${API_BASE}/agents/${agentId}/message`,
    'POST',
    ConversationTurnStartInputSchema.parse(input),
  );
}

export async function sendInterrupt(agentId: string, input: InterruptResolveInput) {
  return apiMutate(
    `${API_BASE}/agents/${agentId}/interrupt`,
    'POST',
    InterruptResolveInputSchema.parse(input),
  );
}

export type PendingInterrupt = {
  interruptId: string;
  turnId: string;
  sandboxSessionId?: string;
  agentId: string;
  toolCallId: string;
  toolCallName: string;
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

export function createSSEConnection(
  agentId: string,
  eventCursor?: string,
): EventSource {
  const token = getApiToken();
  const url = `${API_BASE}/agents/${agentId}/stream`;
  if (!eventCursor && !token) {
    return new EventSource(url);
  }
  const params = new URLSearchParams();
  if (eventCursor) params.set('cursor', eventCursor);
  if (token) params.set('access_token', token);
  return new EventSource(`${url}?${params}`);
}

export async function startBackgroundRun(agentId: string, task: string) {
  return apiMutate(`${API_BASE}/agents/${agentId}/turns`, 'POST', { task });
}

export async function cancelTurn(agentId: string, turnId: string) {
  return apiMutate(`${API_BASE}/agents/${agentId}/turns/${turnId}/cancel`, 'POST');
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

export type ListFilesResponse = ReturnType<typeof FileListResponseSchema.parse>;
export type ReadFileResponse = ReturnType<typeof FileReadResponseSchema.parse>;
export type WriteFileResponse = ReturnType<typeof FileWriteResponseSchema.parse>;

export async function listFiles(agentId: string, path: string, conversationId?: string): Promise<ListFilesResponse> {
  const response = await apiFetch<unknown>(
    withQuery(`${API_BASE}/agents/${agentId}/files`, { path, conversationId }),
  );
  return FileListResponseSchema.parse(response);
}

export async function readFile(agentId: string, path: string, conversationId?: string): Promise<ReadFileResponse> {
  const response = await apiFetch<unknown>(
    withQuery(`${API_BASE}/agents/${agentId}/files/read`, { path, conversationId }),
  );
  return FileReadResponseSchema.parse(response);
}

export async function createFile(
  agentId: string,
  path: string,
  content: string,
  conversationId?: string,
): Promise<WriteFileResponse> {
  const response = await apiMutate<unknown>(
    withQuery(`${API_BASE}/agents/${agentId}/files`, { conversationId }),
    'POST',
    { path, content },
  );
  return FileWriteResponseSchema.parse(response);
}

export async function updateFile(
  agentId: string,
  path: string,
  content: string,
  conversationId?: string,
): Promise<WriteFileResponse> {
  const response = await apiMutate<unknown>(
    withQuery(`${API_BASE}/agents/${agentId}/files`, { conversationId }),
    'PUT',
    { path, content },
  );
  return FileWriteResponseSchema.parse(response);
}

export async function deleteFile(agentId: string, path: string, conversationId?: string): Promise<void> {
  await apiFetch(
    withQuery(`${API_BASE}/agents/${agentId}/files`, { path, conversationId }),
    { method: 'DELETE' },
  );
}

export type UploadWorkspaceResponse = ReturnType<typeof WorkspaceReplaceResponseSchema.parse>;

export async function uploadWorkspaceTarball(
  agentId: string,
  file: File,
  options?: { force?: boolean },
): Promise<UploadWorkspaceResponse> {
  const response = await apiFetch<unknown>(
    withQuery(`${API_BASE}/agents/${agentId}/workspace`, { force: options?.force ? 'true' : undefined }),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/gzip' },
      body: file,
    },
  );
  return WorkspaceReplaceResponseSchema.parse(response);
}

export async function createAgent(data: AgentCreateInput): Promise<Agent> {
  const response = await apiMutate<unknown>(
    `${API_BASE}/agents`,
    'POST',
    AgentCreateInputSchema.parse(data),
  );
  return AgentSchema.parse(response);
}

export async function updateAgent(id: string, data: AgentPatchInput): Promise<Agent> {
  const response = await apiMutate<unknown>(
    `${API_BASE}/agents/${id}`,
    'PATCH',
    AgentPatchInputSchema.parse(data),
  );
  return AgentSchema.parse(response);
}

// ── Agent Secrets operations ──────────────────────────────────────────

export async function fetchSecretKeys(agentId: string): Promise<{ keys: string[] }> {
  const response = await apiFetch<unknown>(`${API_BASE}/agents/${agentId}/secrets`);
  return SecretListResponseSchema.parse(response);
}

export async function setSecret(agentId: string, key: string, value: string): Promise<{ key: string }> {
  const response = await apiMutate<unknown>(
    `${API_BASE}/agents/${agentId}/secrets`,
    'POST',
    SecretPutInputSchema.parse({ key, value }),
  );
  return SecretPutResponseSchema.parse(response);
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
  selector: Record<string, unknown> | null;
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

export type EventRecord = PersistedEvent;
export type EventsResponse = EventListResponse;

export interface EventStats {
  total: number;
  byType: Record<string, number>;
  topAgents: Array<{ agentId: string; count: number }>;
  recentRate: number;
}

export async function fetchEvents(params?: EventListInput): Promise<EventsResponse> {
  return apiFetch<EventsResponse>(withQuery(`${API_BASE}/events`, params));
}

export async function fetchEventStats(range?: string): Promise<EventStats> {
  return apiFetch<EventStats>(withQuery(`${API_BASE}/events/stats`, { range }));
}

export async function fetchEventTypes(): Promise<{ types: string[] }> {
  return apiFetch<{ types: string[] }>(`${API_BASE}/events/types`);
}

// ── Artifact operations ─────────────────────────────────────────────

export type { Artifact };

export async function fetchArtifacts(agentId: string, turnId?: string): Promise<{ artifacts: Artifact[] }> {
  return apiFetch<{ artifacts: Artifact[] }>(
    withQuery(`${API_BASE}/artifacts`, { agentId, turnId }),
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

export async function downloadArtifact(id: string, name: string): Promise<void> {
  const url = `${API_BASE}/artifacts/${id}/download`;
  const res = await fetch(url, withApiAuth());
  if (res.status === 401) {
    markAuthRequired();
  }
  if (!res.ok) {
    const errorDetail = await readErrorDetail(res);
    const baseMessage = `API GET ${url} failed: ${res.status}`;
    throw new Error(errorDetail ? `${baseMessage} - ${errorDetail}` : baseMessage);
  }

  const objectUrl = URL.createObjectURL(await res.blob());
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = name;
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    URL.revokeObjectURL(objectUrl);
  }
}

export async function deleteArtifact(id: string): Promise<void> {
  await apiFetch(`${API_BASE}/artifacts/${id}`, { method: 'DELETE' });
}

export async function requestArtifactUploadUrl(agentId: string, name: string, mimeType: string, sizeBytes: number): Promise<{ artifactId: string; uploadUrl: string; storageKey: string; expiresIn: number }> {
  return apiMutate(`${API_BASE}/artifacts/upload-url`, 'POST', {
    agentId,
    name,
    mimeType,
    sizeBytes,
  });
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

// ── Budget policies ──────────────────────────────────────────────────

export async function fetchBudgetPolicies(): Promise<BudgetPolicy[]> {
  const response = await apiFetch<unknown>(`${API_BASE}/budgets`);
  return BudgetPolicyListResponseSchema.parse(response).policies;
}

export async function createBudgetPolicy(
  input: BudgetPolicyCreateInput,
): Promise<BudgetPolicy> {
  const body = BudgetPolicyCreateInputSchema.parse(input);
  const response = await apiMutate<unknown>(`${API_BASE}/budgets`, 'POST', body);
  return BudgetPolicySchema.parse(response);
}

export async function updateBudgetPolicy(
  id: string,
  input: BudgetPolicyPatchInput,
): Promise<BudgetPolicy> {
  const body = BudgetPolicyPatchInputSchema.parse(input);
  const response = await apiMutate<unknown>(`${API_BASE}/budgets/${id}`, 'PATCH', body);
  return BudgetPolicySchema.parse(response);
}

export async function deleteBudgetPolicy(id: string): Promise<void> {
  await apiFetch(`${API_BASE}/budgets/${id}`, { method: 'DELETE' });
}

export async function fetchBudgetSpend(id: string): Promise<BudgetSpendResponse> {
  const response = await apiFetch<unknown>(`${API_BASE}/budgets/${id}/spend`);
  return BudgetSpendResponseSchema.parse(response);
}

export async function fetchAgentBudgetStatuses(): Promise<AgentBudgetStatus[]> {
  const response = await apiFetch<unknown>(`${API_BASE}/budgets/agents/status`);
  return AgentBudgetStatusListResponseSchema.parse(response).statuses;
}

export async function fetchModelGatewayStatus(): Promise<ModelGatewayStatus> {
  const response = await apiFetch<unknown>(`${API_BASE}/model-gateway/status`);
  return ModelGatewayStatusSchema.parse(response);
}

export async function fetchModelGatewayQuarantine(): Promise<ModelGatewayQuarantine> {
  const response = await apiFetch<unknown>(`${API_BASE}/model-gateway/quarantine`);
  return ModelGatewayQuarantineSchema.parse(response);
}

export async function fetchAnalyticsOverview(
  window: AnalyticsWindow = '24h',
): Promise<AnalyticsOverview> {
  const canonicalWindow = AnalyticsWindowSchema.parse(window);
  const response = await apiFetch<unknown>(withQuery(
    `${API_BASE}/analytics/overview`,
    { window: canonicalWindow },
  ));
  return AnalyticsOverviewSchema.parse(response);
}
