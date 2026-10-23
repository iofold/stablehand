import { z } from 'zod';

import { DurationMsSchema, EpochMillisSchema as EpochMillisecondsSchema } from './time.js';

import {
  AgentIdSchema,
  ArtifactIdSchema,
  ConversationIdSchema,
  InterruptIdSchema,
  MessageIdSchema,
  SandboxSessionIdSchema,
  ToolCallIdSchema,
  TurnIdSchema,
  WebhookIdSchema,
} from './ids.js';
import {
  BuiltinToolPolicySchema,
  NativeToolPolicySchema,
  WorkspaceRelativePathSchema,
} from './harness.js';
import { TurnUsageSchema } from './usage.js';
import { TurnStopReasonSchema } from './budgets.js';
import { AgentEgressSchema } from './egress.js';

const UnknownRecordSchema = z.record(z.string(), z.unknown());
const StringRecordSchema = z.record(z.string(), z.string());

export const ARTIFACT_METADATA_MAX_BYTES = 16 * 1024;
/**
 * Serialized-JSON cap for a custom event's `payload` (ctx-et0w: raised from
 * 32 KiB, which could not carry a campaign summary). 256 KiB is the ceiling
 * the common managed event buses use (EventBridge, SNS, SQS), well under
 * Fastify's 1 MiB request body limit. Every event row keeps the payload twice
 * (frame body and source payload) and SSE replay and spine catch-up read rows
 * in batches, so larger content belongs in an artifact or behind a URL, with
 * only its id or URL in the event.
 */
export const CUSTOM_EVENT_PAYLOAD_MAX_BYTES = 256 * 1024;
export const CUSTOM_EVENT_NAME_PATTERN_SOURCE = String.raw`^custom\.[a-z0-9][a-z0-9_.-]{0,126}$`;
export const CUSTOM_EVENT_NAME_PATTERN = new RegExp(CUSTOM_EVENT_NAME_PATTERN_SOURCE);

export function serializedJsonByteLength(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined
      ? Number.POSITIVE_INFINITY
      : new TextEncoder().encode(serialized).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export const ArtifactKindSchema = z.string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);

export const ArtifactSha256Schema = z.string()
  .regex(/^[a-f0-9]{64}$/, 'Artifact sha256 must be 64 lowercase hex characters');

export const CustomEventNameSchema = z.string().regex(
  CUSTOM_EVENT_NAME_PATTERN,
  'Custom event names must match ^custom\\.[a-z0-9][a-z0-9_.-]{0,126}$',
);

export function isCustomEventName(value: string): boolean {
  return CUSTOM_EVENT_NAME_PATTERN.test(value);
}

export const CustomEventPayloadSchema = UnknownRecordSchema.refine(
  (value) => serializedJsonByteLength(value) <= CUSTOM_EVENT_PAYLOAD_MAX_BYTES,
  `Custom event payload must not exceed ${CUSTOM_EVENT_PAYLOAD_MAX_BYTES} serialized bytes (256 KiB); `
  + 'put larger content in an artifact or behind a URL and send its id or URL instead',
);

export const CustomEventEmitInputSchema = z.strictObject({
  type: CustomEventNameSchema,
  agentId: AgentIdSchema.optional(),
  payload: CustomEventPayloadSchema,
});

export const CustomEventEmitResponseSchema = z.strictObject({
  ok: z.literal(true),
  type: CustomEventNameSchema,
});

export const CustomEventPayloadTooLargeErrorSchema = z.strictObject({
  // ctx-iqzy S12/R3: `error` is the human sentence, `code` the machine token.
  error: z.string(),
  code: z.literal('custom_event_payload_too_large'),
  maxBytes: z.literal(CUSTOM_EVENT_PAYLOAD_MAX_BYTES),
  /** Serialized size of the rejected payload. */
  sizeBytes: z.number().int().positive().optional(),
});

/** The typed 413 body for an oversized custom event payload (emit and schedules). */
export function customEventPayloadTooLargeError(
  sizeBytes: number,
): z.infer<typeof CustomEventPayloadTooLargeErrorSchema> {
  return {
    error: `Custom event payload is ${sizeBytes} bytes; the limit is ${CUSTOM_EVENT_PAYLOAD_MAX_BYTES} bytes `
      + '(256 KiB) of serialized JSON. Put larger content in an artifact or behind a URL and send its id '
      + 'or URL in the payload instead.',
    code: 'custom_event_payload_too_large',
    maxBytes: CUSTOM_EVENT_PAYLOAD_MAX_BYTES,
    sizeBytes,
  };
}

export const ArtifactMetadataSchema = UnknownRecordSchema.refine(
  (value) => serializedJsonByteLength(value) <= ARTIFACT_METADATA_MAX_BYTES,
  `Artifact metadata must not exceed ${ARTIFACT_METADATA_MAX_BYTES} serialized bytes`,
);

export const AgentResourceLimitsSchema = z.strictObject({
  cpus: z.number().min(0.5).max(4).optional(),
  memoryMb: z.number().int().min(256).max(4096).optional(),
  pidsLimit: z.number().int().min(64).max(512).optional(),
  timeoutSec: z.number().int().min(60).max(3600).optional(),
});

export const AgentWorkspaceContentSchema = z.strictObject({
  files: z.array(z.strictObject({
    src: WorkspaceRelativePathSchema,
    dest: WorkspaceRelativePathSchema,
  })).optional(),
});

export const AgentModeSchema = z.enum(['interactive', 'background', 'both']);

export const HttpToolDefinitionSchema = z.strictObject({
  name: z.string().trim().min(1),
  description: z.string(),
  endpoint: z.string().url(),
  method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']).optional(),
  inputSchema: UnknownRecordSchema.optional(),
  headers: StringRecordSchema.optional(),
  // Milliseconds; min guards the seconds-vs-ms foot-gun (resourceLimits.timeoutSec
  // sits two keys away and IS seconds).
  timeoutMs: z.number().int().min(100).optional(),
  authentication: z.strictObject({
    type: z.enum(['bearer', 'api-key']),
    secretName: z.string().trim().min(1),
    allowEnvFallback: z.boolean().optional(),
  }).optional(),
  programmatic: z.boolean().optional(),
  /** Pause each call on an approval card before the request is sent (ctx-9gy9). */
  requiresApproval: z.boolean().optional(),
});

/**
 * A `$secret:NAME` reference to an agent secret. MCP server auth accepts only
 * references, never literal tokens, and resolves them from the agent's
 * tools-scope secrets, which never enter the sandbox.
 */
export const SECRET_REFERENCE_PATTERN = /^\$secret:[A-Za-z_][A-Za-z0-9_]{0,127}$/;
export const SecretReferenceSchema = z.string().trim().regex(
  SECRET_REFERENCE_PATTERN,
  'Use a $secret:NAME reference and store the value as a tools-only secret on the agent',
);

/** Lowercase name of an MCP server; it prefixes the server's tool names. */
export const McpServerNameSchema = z.string().trim().regex(
  /^[a-z][a-z0-9_-]{0,23}$/,
  'Use 1-24 lowercase letters, digits, - or _, starting with a letter',
);

export const McpServerAuthSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('none') }),
  /** `Authorization: Bearer <secret>` on every request. */
  z.strictObject({ type: z.literal('bearer'), token: SecretReferenceSchema }),
  /** A custom header, e.g. `x-api-key: <secret>`. */
  z.strictObject({
    type: z.literal('header'),
    name: z.string().trim().regex(/^[A-Za-z0-9-]{1,64}$/, 'Header names use letters, digits and -'),
    value: SecretReferenceSchema,
  }),
  /**
   * OAuth 2.1 with discovery, dynamic client registration and PKCE. A person
   * connects once from the agent's Tools tab; tokens are stored encrypted in
   * the agent's tools-scope secrets and refreshed by the orchestrator.
   */
  z.strictObject({
    type: z.literal('oauth'),
    scopes: z.array(z.string().trim().min(1)).max(32).optional(),
  }),
]);

export const McpServerDefinitionSchema = z.strictObject({
  name: McpServerNameSchema,
  /** Remote Streamable HTTP endpoint. https, or http for an allowlisted internal host. */
  url: z.string().url().refine(
    (value) => value.startsWith('https://') || value.startsWith('http://'),
    'MCP server URLs must use https (or http for an allowlisted internal host)',
  ),
  description: z.string().max(500).optional(),
  auth: McpServerAuthSchema.optional(),
  /** Glob allowlist of the server's tool names (`*` wildcard). Default: every tool. */
  tools: z.array(z.string().trim().min(1)).max(100).optional(),
  /**
   * Which calls wait for a person's approval: `true` every tool, `false`
   * none, or a glob list of tool names. Omitted: tools the server marks
   * destructive.
   */
  requireApproval: z.union([z.boolean(), z.array(z.string().trim().min(1)).max(100)]).optional(),
  /** Per-call timeout in milliseconds (default 120000). */
  timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
});

export const McpServerListSchema = z.array(McpServerDefinitionSchema).max(10).superRefine((servers, ctx) => {
  const seen = new Set<string>();
  servers.forEach((server, index) => {
    if (seen.has(server.name)) {
      ctx.addIssue({
        code: 'custom',
        path: [index, 'name'],
        message: `Duplicate MCP server name: ${server.name}`,
      });
    }
    seen.add(server.name);
  });
});

export const McpServerStateSchema = z.enum(['connecting', 'ready', 'needs_auth', 'error']);

export const McpServerToolSummarySchema = z.strictObject({
  /** Name the agent calls, e.g. `granola__list_meetings`. */
  name: z.string(),
  /** Name on the MCP server, e.g. `list_meetings`. */
  mcpName: z.string(),
  displayName: z.string(),
  requiresApproval: z.boolean(),
});

export const McpServerStatusSchema = z.strictObject({
  name: McpServerNameSchema,
  url: z.string(),
  authType: z.enum(['none', 'bearer', 'header', 'oauth']),
  state: McpServerStateSchema,
  /** Plain-language reason when state is needs_auth or error. */
  message: z.string().optional(),
  /** OAuth servers: true once a person has connected an account. */
  connected: z.boolean(),
  toolCount: z.number().int().nonnegative(),
  lastListedAt: z.number().int().nonnegative().nullable(),
  tools: z.array(McpServerToolSummarySchema),
});

export const McpServerStatusListResponseSchema = z.strictObject({
  servers: z.array(McpServerStatusSchema),
});

export const McpServerConnectInputSchema = z.strictObject({
  /** Origin the browser uses for the Stablehand API, e.g. https://stablehand.example.com. */
  redirectOrigin: z.string().url().optional(),
});

export const McpServerConnectResponseSchema = z.strictObject({
  /** Open this in a browser to sign in to the server's provider. */
  authorizationUrl: z.string().url(),
  /** Host of the sign-in page, shown before the person follows the link. */
  host: z.string(),
  expiresAt: z.number().int().positive(),
});

export const AgentCreateInputSchema = z.strictObject({
  name: z.string().trim().min(1),
  harness: z.string().trim().min(1),
  harnessConfig: UnknownRecordSchema,
  systemPrompt: z.string(),
  tools: z.array(z.string().trim().min(1)),
  httpTools: z.array(HttpToolDefinitionSchema).optional(),
  /** Remote MCP servers whose tools this agent may call (run by the orchestrator). */
  mcpServers: McpServerListSchema.optional(),
  builtinToolPolicy: BuiltinToolPolicySchema.optional(),
  description: z.string().optional(),
  metadata: UnknownRecordSchema.optional(),
  resourceLimits: AgentResourceLimitsSchema.nullable().optional(),
  nativeToolPolicy: NativeToolPolicySchema.optional(),
  workspaceContent: AgentWorkspaceContentSchema.optional(),
  mode: AgentModeSchema.optional(),
  egress: AgentEgressSchema.optional(),
  manifest: UnknownRecordSchema.optional(),
});

export const AgentPatchInputSchema = AgentCreateInputSchema
  .partial()
  .extend({
    description: z.string().nullable().optional(),
    builtinToolPolicy: BuiltinToolPolicySchema.nullable().optional(),
    metadata: UnknownRecordSchema.nullable().optional(),
    nativeToolPolicy: NativeToolPolicySchema.nullable().optional(),
    workspaceContent: AgentWorkspaceContentSchema.nullable().optional(),
    mode: AgentModeSchema.nullable().optional(),
    egress: AgentEgressSchema.nullable().optional(),
    manifest: UnknownRecordSchema.nullable().optional(),
    mcpServers: McpServerListSchema.nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'At least one agent field is required');

export const TurnStatusSchema = z.enum([
  'QUEUED',
  'RUNNING',
  'COMPLETED',
  'ERROR',
  'CANCELLED',
]);

export const ConversationStatusSchema = z.enum([
  'ACTIVE',
  'CHECKPOINTED',
  'RESTORING',
  'COMPLETED',
  'ERROR',
  'CANCELLED',
  'IDLE',
]);

export const SandboxSessionStatusSchema = z.enum([
  'ACTIVE',
  'CHECKPOINTED',
  'RESTORING',
  'TERMINATED',
]);

export const TurnSchema = z.strictObject({
  id: TurnIdSchema,
  agentId: AgentIdSchema,
  // ctx-iqzy S7: null when the turn has no conversation — never '' sentinels.
  conversationId: ConversationIdSchema.nullable(),
  // ctx-iqzy S6/R1: entity fields with no value are null and always present;
  // omission is reserved for projection enrichments below.
  sandboxSessionId: SandboxSessionIdSchema.nullable(),
  sandboxStatus: SandboxSessionStatusSchema.optional(),
  status: TurnStatusSchema,
  mode: z.enum(['interactive', 'background']),
  // ctx-iqzy T2: queue-admission time; startedAt is execution start.
  queuedAt: EpochMillisecondsSchema,
  startedAt: EpochMillisecondsSchema,
  completedAt: EpochMillisecondsSchema.nullable(),
  error: z.string().nullable(),
  // Typed reason for a terminal error, e.g. a run stopped at its spend cap.
  // Omitted when the turn ended without one.
  stopReason: TurnStopReasonSchema.optional(),
  taskDescription: z.string().nullable(),
  conversationMessageCount: z.number().int().nonnegative().optional(),
  restoreAttempts: z.number().int().nonnegative().nullable().optional(),
  lastRestoreError: z.string().nullable().optional(),
  checkpointAt: EpochMillisecondsSchema.optional(),
  usage: TurnUsageSchema.nullable(),
  // Budget-attribution tags stamped at turn creation (system + caller tags).
  tags: StringRecordSchema.optional(),
  // Model-gateway attribution; null means the turn ran on direct provider
  // credentials and no spend reconciliation is expected for it.
  gatewayMode: z.enum(['gateway_only', 'mixed']).nullable().optional(),
  // Join key into the model-gateway spend ledger; absent for direct turns.
  gatewayCorrelationId: z.string().optional(),
  usageReconciledAt: EpochMillisecondsSchema.optional(),
});

export const SandboxSessionsByStatusSchema = z.strictObject({
  ACTIVE: z.number().int().nonnegative(),
  CHECKPOINTED: z.number().int().nonnegative(),
  RESTORING: z.number().int().nonnegative(),
  TERMINATED: z.number().int().nonnegative(),
});

export const AgentSchema = z.strictObject({
  id: AgentIdSchema,
  name: z.string(),
  harness: z.string(),
  harnessConfig: UnknownRecordSchema,
  systemPrompt: z.string(),
  tools: z.array(z.string()),
  description: z.string().nullable(),
  workspaceDir: z.string().nullable(),
  status: z.enum(['idle', 'running']),
  manifest: UnknownRecordSchema.nullable(),
  metadata: UnknownRecordSchema.nullable(),
  createdAt: EpochMillisecondsSchema,
  updatedAt: EpochMillisecondsSchema,
  builtinToolPolicy: BuiltinToolPolicySchema.nullable(),
  nativeToolPolicy: NativeToolPolicySchema.nullable(),
  httpTools: z.array(HttpToolDefinitionSchema),
  mcpServers: z.array(McpServerDefinitionSchema).optional(),
  workspaceContent: AgentWorkspaceContentSchema.nullable(),
  mode: AgentModeSchema.nullable(),
  resourceLimits: AgentResourceLimitsSchema.nullable(),
  // null: the agent has no egress setting of its own and uses the server allowlist.
  egress: AgentEgressSchema.nullable(),
  sseClients: z.number().int().nonnegative().optional(),
  hasPendingInterrupt: z.boolean().optional(),
  conversationCount: z.number().int().nonnegative().optional(),
  turnCount: z.number().int().nonnegative().optional(),
  completedTurnCount: z.number().int().nonnegative().optional(),
  failedTurnCount: z.number().int().nonnegative().optional(),
  activeTurnCount: z.number().int().nonnegative().optional(),
  tokensTotal: z.number().int().nonnegative().optional(),
  tokensLast24h: z.number().int().nonnegative().optional(),
  sandboxSessionsByStatus: SandboxSessionsByStatusSchema.optional(),
  lastActivity: EpochMillisecondsSchema.nullable().optional(),
});

export const AgentListResponseSchema = z.array(AgentSchema);

/**
 * `sandbox` secrets are injected into the agent's sandbox env. `tools`
 * secrets are read only by the orchestrator for HTTP tools and MCP servers
 * and never enter the sandbox.
 */
export const SecretScopeSchema = z.enum(['sandbox', 'tools']);

export const SecretListResponseSchema = z.strictObject({
  /** Sandbox-scope keys. */
  keys: z.array(z.string().trim().min(1)),
  /** Tools-scope keys (never in the sandbox). */
  toolKeys: z.array(z.string().trim().min(1)).optional(),
});

export const SecretPutInputSchema = z.strictObject({
  key: z.string().trim().min(1),
  value: z.string().min(1),
  scope: SecretScopeSchema.optional(),
});

export const SecretPutResponseSchema = z.strictObject({
  key: z.string().trim().min(1),
});

export const MAX_SANDBOX_SECRET_COUNT = 128;
export const MAX_SANDBOX_SECRET_KEY_LENGTH = 128;
export const MAX_SANDBOX_SECRET_VALUE_BYTES = 64 * 1024;
export const MAX_SANDBOX_SECRETS_TOTAL_BYTES = 128 * 1024;

const RESERVED_SANDBOX_ENVIRONMENT_KEYS: ReadonlySet<string> = new Set([
  'NODE_OPTIONS',
  'ORCHESTRATOR_URL',
  'PTC_PORT',
  'SANDBOX_PORT',
]);
const UNSAFE_RECORD_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);
const UTF8_ENCODER = new TextEncoder();

export function isReservedSandboxEnvironmentKey(key: string): boolean {
  return key.startsWith('STABLEHAND_')
    || RESERVED_SANDBOX_ENVIRONMENT_KEYS.has(key)
    || UNSAFE_RECORD_KEYS.has(key);
}

const SandboxSecretsRecordSchema = z.record(
  z.string()
    .max(MAX_SANDBOX_SECRET_KEY_LENGTH)
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  z.string().refine(
    (value) => !value.includes('\0'),
    'Secret value cannot contain a NUL byte',
  ),
).superRefine((secrets, ctx) => {
  const entries = Object.entries(secrets);
  if (entries.length > MAX_SANDBOX_SECRET_COUNT) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `At most ${MAX_SANDBOX_SECRET_COUNT} sandbox secrets are allowed`,
    });
  }

  let totalBytes = 0;
  for (const [key, value] of entries) {
    const valueBytes = UTF8_ENCODER.encode(value).byteLength;
    totalBytes += UTF8_ENCODER.encode(key).byteLength + valueBytes;
    if (valueBytes > MAX_SANDBOX_SECRET_VALUE_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `Secret value exceeds ${MAX_SANDBOX_SECRET_VALUE_BYTES} UTF-8 bytes`,
      });
    }
  }

  if (totalBytes > MAX_SANDBOX_SECRETS_TOTAL_BYTES) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Sandbox secrets exceed ${MAX_SANDBOX_SECRETS_TOTAL_BYTES} total UTF-8 bytes`,
    });
  }
});

export const SandboxSecretsSchema = z.preprocess((value, ctx) => {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    for (const key of Object.keys(value)) {
      if (isReservedSandboxEnvironmentKey(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: 'Secret key is reserved by the sandbox runtime',
        });
      }
    }
  }
  return value;
}, SandboxSecretsRecordSchema);

export const TagsSchema = z.record(z.string().trim().min(1), z.string().min(1).max(256));

export const BackgroundTurnStartInputSchema = z.strictObject({
  task: z.string().trim().min(1),
  conversationId: ConversationIdSchema.optional(),
  requestedTurnId: z.string().trim().min(1).optional(),
  sandboxSecrets: SandboxSecretsSchema.optional(),
  tags: TagsSchema.optional(),
});

// ctx-iqzy: no sandbox session exists at accept time; the response carries
// only the turn/conversation identities. Read sandboxSessionId from the turn.
export const BackgroundTurnStartResponseSchema = z.strictObject({
  turnId: TurnIdSchema,
  conversationId: ConversationIdSchema,
});

export const ConversationTurnStartInputSchema = z.strictObject({
  content: z.string().trim().min(1),
  conversationId: z.string().trim().min(1).optional(),
  requestedTurnId: z.string().trim().min(1).optional(),
  sandboxSecrets: SandboxSecretsSchema.optional(),
  tags: TagsSchema.optional(),
});

export const ConversationTurnStartResponseSchema = z.strictObject({
  messageId: MessageIdSchema,
  turnId: TurnIdSchema,
  conversationId: ConversationIdSchema,
});

export const TurnListResponseSchema = z.strictObject({
  turns: z.array(TurnSchema),
});

/**
 * GET /api/turns (ctx-89id): turns across agents, newest first. Every tag must
 * match; `status` matches any of the listed values. Tag keys used as filters
 * cannot contain ':' because the query form is `tag=key:value`.
 */
export const TurnSearchInputSchema = z.strictObject({
  tags: z.record(
    z.string().trim().min(1).regex(/^[^:]+$/, 'Tag keys used as filters cannot contain ":"'),
    z.string().min(1).max(256),
  ).optional(),
  status: z.union([TurnStatusSchema, z.array(TurnStatusSchema).min(1)]).optional(),
  agentId: AgentIdSchema.optional(),
  limit: z.number().int().positive().max(200).optional(),
  cursor: z.string().trim().min(1).optional(),
});

export const TurnSearchResponseSchema = z.strictObject({
  turns: z.array(TurnSchema),
  /** Opaque; pass back as `cursor` for the next page. Absent on the last page. */
  nextCursor: z.string().optional(),
});

/** GET /api/turns/:turnId — one turn by id, without its agent. */
export const TurnLookupResponseSchema = z.strictObject({
  turn: TurnSchema,
});

export const ToolCallStateSchema = z.strictObject({
  id: ToolCallIdSchema,
  name: z.string(),
  args: z.string(),
  result: z.string().optional(),
  error: z.string().optional(),
  status: z.enum(['pending', 'running', 'complete', 'error']),
  durationMs: z.number().nonnegative().optional(),
  // Subagent annotation (ctx-5myn), same as MessagePart tool_call entries.
  parentToolCallId: ToolCallIdSchema.optional(),
  agentName: z.string().optional(),
});

export const MessagePartSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('text'),
    content: z.string(),
  }),
  z.strictObject({
    type: z.literal('tool_call'),
    id: ToolCallIdSchema,
    name: z.string(),
    args: z.string(),
    result: z.string().optional(),
    error: z.string().optional(),
    status: ToolCallStateSchema.shape.status,
    durationMs: z.number().nonnegative().optional(),
    // Subagent annotation (ctx-5myn): the spawning Task tool call's id and
    // the subagent's display identity. Parts stay flat; the UI nests.
    parentToolCallId: ToolCallIdSchema.optional(),
    agentName: z.string().optional(),
  }),
]);

export const MessageSchema = z.strictObject({
  id: MessageIdSchema,
  conversationId: ConversationIdSchema.optional(),
  agentId: AgentIdSchema.nullable().optional(),
  turnId: TurnIdSchema.optional(),
  messageSeq: z.number().int().nonnegative().optional(),
  messageRevision: z.number().int().nonnegative(),
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  content: z.string(),
  toolCallId: ToolCallIdSchema.nullable().optional(),
  toolCalls: z.array(ToolCallStateSchema).nullable().optional(),
  parts: z.array(MessagePartSchema).nullable().optional(),
  createdAt: EpochMillisecondsSchema,
});

export const MessageListResponseSchema = z.array(MessageSchema);

export const EventCursorSchema = z.string().regex(/^\d{12,15}$/);

export const ConversationSnapshotResponseSchema = z.strictObject({
  conversationId: ConversationIdSchema,
  eventCursor: EventCursorSchema,
  messages: MessageListResponseSchema,
});

export const TurnDetailResponseSchema = z.strictObject({
  turn: TurnSchema,
  messages: MessageListResponseSchema,
});

export const TurnCancelResponseSchema = z.strictObject({
  cancelled: z.boolean(),
  turnId: TurnIdSchema,
  alreadyTerminal: z.boolean().optional(),
});

export const ConversationSchema = z.strictObject({
  id: ConversationIdSchema,
  agentId: AgentIdSchema,
  tags: TagsSchema.nullable(),
  createdAt: EpochMillisecondsSchema,
  updatedAt: EpochMillisecondsSchema,
});

export const ConversationListResponseSchema = z.array(ConversationSchema);

export const ConversationSummarySchema = z.strictObject({
  id: ConversationIdSchema,
  agentId: AgentIdSchema,
  status: ConversationStatusSchema,
  mode: z.enum(['interactive', 'background']),
  turnCount: z.number().int().nonnegative(),
  messageCount: z.number().int().nonnegative(),
  taskDescription: z.string().nullable(),
  startedAt: EpochMillisecondsSchema,
  completedAt: EpochMillisecondsSchema.nullable(),
  updatedAt: EpochMillisecondsSchema,
  latestTurnId: TurnIdSchema.nullable(),
  sandboxSessionId: SandboxSessionIdSchema.nullable(),
  totalTokens: z.number().int().nonnegative().nullable(),
  // Sum of known cost across the conversation's turns; null when no turn
  // carries any cost data (distinct from a real $0).
  knownCostUsd: z.number().nonnegative().nullable(),
  // Turns whose cost is not yet fully known (pending, partial, or unpriced).
  incompleteCostTurnCount: z.number().int().nonnegative(),
  // Budget-attribution tags fixed at conversation creation.
  tags: StringRecordSchema.optional(),
});

export const ConversationSummaryListResponseSchema = z.strictObject({
  conversations: z.array(ConversationSummarySchema),
});

export const ActiveConversationListResponseSchema = z.array(ConversationSummarySchema);

export const SandboxSessionSchema = z.strictObject({
  id: SandboxSessionIdSchema,
  conversationId: ConversationIdSchema,
  agentId: AgentIdSchema,
  containerName: z.string().nullable(),
  containerId: z.string().nullable(),
  status: SandboxSessionStatusSchema,
  harnessName: z.string(),
  checkpointRef: z.string().nullable(),
  createdAt: EpochMillisecondsSchema,
  updatedAt: EpochMillisecondsSchema,
  lastActivityAt: EpochMillisecondsSchema,
  restoreAttempts: z.number().int().nonnegative().nullable().optional(),
  lastRestoreError: z.string().nullable().optional(),
  // ctx-sf2n: durable checkpoint-failure evidence (ctx-vsf8) is operator-relevant.
  checkpointFailures: z.number().int().nonnegative().nullable().optional(),
  lastCheckpointError: z.string().nullable().optional(),
  restoreOwnerId: z.string().nullable(),
  restoreFenceToken: z.number().int().nonnegative(),
  restoreLeaseExpiresAt: EpochMillisecondsSchema.nullable(),
});

export const SandboxSessionListResponseSchema = z.array(SandboxSessionSchema);

export const SandboxSessionActionResponseSchema = z.strictObject({
  sandboxSessionId: SandboxSessionIdSchema,
  status: SandboxSessionStatusSchema,
  restoreAttempts: z.number().int().nonnegative().optional(),
});

// ctx-iqzy S3: the single interrupt vocabularies. Status covers both the
// agent-scoped view and the durable cross-agent inbox; action is what a
// resolution can record.
export const InterruptStatusSchema = z.enum(['pending', 'resolved', 'resume_failed', 'timed_out']);
export const InterruptActionSchema = z.enum(['approve', 'reject', 'suspend', 'timeout']);

/**
 * Who made an API call (ctx-lhr0): the master token, a scoped key (its id and
 * its name at the time of the call), or nobody when authentication is off.
 */
export const ApiCallerSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('master_token') }),
  z.strictObject({
    type: z.literal('api_key'),
    keyId: z.string().trim().min(1),
    keyName: z.string(),
  }),
  z.strictObject({ type: z.literal('unauthenticated') }),
]);

/** Longest accepted reason when resolving an approval, in characters. */
export const INTERRUPT_REASON_MAX_LENGTH = 2000;

/**
 * Who resolved an interrupt, when, and why. `resolvedBy` and `resolvedReason`
 * are null for resolutions Stablehand made itself (expiry, a newer request
 * replacing an older one) and for interrupts resolved before this was recorded.
 */
const InterruptResolutionFields = {
  resolvedAt: EpochMillisecondsSchema.nullable(),
  resolvedAction: InterruptActionSchema.nullable(),
  resolvedBy: ApiCallerSchema.nullable(),
  resolvedReason: z.string().nullable(),
};

export const InterruptSchema = z.strictObject({
  // ctx-iqzy S2: entity PK is `id` like every other resource; event/webhook
  // payloads keep `interruptId` as the cross-reference name.
  id: InterruptIdSchema,
  turnId: TurnIdSchema,
  sandboxSessionId: SandboxSessionIdSchema.nullable(),
  agentId: AgentIdSchema,
  toolCallId: ToolCallIdSchema,
  // ctx-iqzy S1: names the tool; the call is toolCallId.
  toolName: z.string(),
  args: UnknownRecordSchema,
  createdAt: EpochMillisecondsSchema,
  status: InterruptStatusSchema,
  resumeError: z.string().optional(),
  // Present once the interrupt has been resolved (resume_failed rows).
  resolvedAt: InterruptResolutionFields.resolvedAt.optional(),
  resolvedAction: InterruptResolutionFields.resolvedAction.optional(),
  resolvedBy: InterruptResolutionFields.resolvedBy.optional(),
  resolvedReason: InterruptResolutionFields.resolvedReason.optional(),
});

export const InterruptListResponseSchema = z.strictObject({
  interrupts: z.array(InterruptSchema),
});

export const InterruptRecordSchema = z.strictObject({
  id: InterruptIdSchema,
  agentId: AgentIdSchema,
  turnId: TurnIdSchema,
  sandboxSessionId: SandboxSessionIdSchema.nullable(),
  toolCallId: ToolCallIdSchema,
  toolName: z.string().trim().min(1),
  args: UnknownRecordSchema,
  status: InterruptStatusSchema,
  createdAt: EpochMillisecondsSchema,
  expiresAt: EpochMillisecondsSchema,
  ...InterruptResolutionFields,
});

/**
 * GET /api/interrupts/:id — one interrupt plus `resolvedData`, the `data`
 * sent with the resolution (left out of lists because it can be large).
 */
export const InterruptRecordDetailSchema = InterruptRecordSchema.extend({
  resolvedData: z.unknown().nullable(),
});

export const InterruptRecordListInputSchema = z.strictObject({
  status: z.enum(['pending', 'resolved', 'all']).optional(),
  agentId: AgentIdSchema.optional(),
  limit: z.number().int().positive().max(200).optional(),
  before: EpochMillisecondsSchema.optional(),
});

export const InterruptRecordListResponseSchema = z.strictObject({
  interrupts: z.array(InterruptRecordSchema),
  nextBefore: EpochMillisecondsSchema.optional(),
});

export const InterruptResolveInputSchema = z.strictObject({
  interruptId: z.string().trim().min(1),
  action: z.enum(['approve', 'reject']),
  data: z.unknown().optional(),
  /** Why the approval was granted or refused; recorded with the resolution. */
  reason: z.string().trim().min(1).max(INTERRUPT_REASON_MAX_LENGTH).optional(),
});

/**
 * The recorded resolution, echoed on every resolve response. For an
 * interrupt that was already resolved it describes the first resolution.
 * Absent only when the interrupt was never stored (in-memory only).
 */
const InterruptResolveRecordFields = {
  resolvedAt: EpochMillisecondsSchema.optional(),
  resolvedBy: ApiCallerSchema.nullable().optional(),
  resolvedReason: z.string().nullable().optional(),
};

export const InterruptResolveResponseSchema = z.union([
  z.strictObject({
    resolved: z.literal(true),
    action: z.enum(['approve', 'reject']),
    note: z.string().optional(),
    ...InterruptResolveRecordFields,
  }),
  z.strictObject({
    alreadyResolved: z.literal(true),
    action: z.enum(['approve', 'reject']).nullable(),
    ...InterruptResolveRecordFields,
  }),
  z.strictObject({
    accepted: z.literal(true),
    resuming: z.boolean(),
    action: z.enum(['approve', 'reject']),
    resumeAttemptId: z.string().trim().min(1),
    error: z.string().optional(),
    ...InterruptResolveRecordFields,
  }),
]);

export const PersistedEventSchema = z.strictObject({
  seq: z.number().int().positive(),
  type: z.string().trim().min(1),
  agentId: z.string(),
  turnId: TurnIdSchema.nullable(),
  conversationId: ConversationIdSchema.nullable(),
  payload: z.string(),
  createdAt: EpochMillisecondsSchema,
  // Bus provenance (ADR-016): which channel persisted the event and, for
  // bridged events, the upstream source record it was derived from.
  channel: z.string().optional(),
  sourceType: z.string().nullable().optional(),
  sourcePayload: z.string().nullable().optional(),
});

export const EventListInputSchema = z.strictObject({
  cursor: z.number().int().positive().optional(),
  limit: z.number().int().positive().max(200).optional(),
  type: z.string().trim().min(1).optional(),
  agentId: AgentIdSchema.optional(),
  turnId: TurnIdSchema.optional(),
  conversationId: ConversationIdSchema.optional(),
  since: EpochMillisecondsSchema.optional(),
});

export const EventListResponseSchema = z.strictObject({
  events: z.array(PersistedEventSchema),
  nextCursor: z.number().int().positive().optional(),
});

export const ArtifactStatusSchema = z.enum([
  'pending_upload',
  'active',
  'upload_failed',
  'deleting',
  'delete_failed',
]);

export const ArtifactSchema = z.strictObject({
  id: ArtifactIdSchema,
  agentId: AgentIdSchema.nullable(),
  turnId: TurnIdSchema.nullable(),
  conversationId: ConversationIdSchema.nullable(),
  name: z.string().trim().min(1),
  mimeType: z.string().trim().min(1),
  sizeBytes: z.number().int().nonnegative(),
  storageKey: z.string().trim().min(1),
  bucket: z.string().trim().min(1),
  kind: ArtifactKindSchema.nullable(),
  metadata: ArtifactMetadataSchema.nullable(),
  sha256: ArtifactSha256Schema.nullable().optional(),
  status: ArtifactStatusSchema,
  expiresAt: EpochMillisecondsSchema.nullable(),
  createdAt: EpochMillisecondsSchema,
  updatedAt: EpochMillisecondsSchema,
});

export const ArtifactListInputSchema = z.strictObject({
  agentId: AgentIdSchema.optional(),
  turnId: TurnIdSchema.optional(),
  limit: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional(),
  search: z.string().optional(),
});

export const ArtifactListResponseSchema = z.strictObject({
  artifacts: z.array(ArtifactSchema),
  // ctx-iqzy S10: always present; for filtered lists it is the filtered count.
  total: z.number().int().nonnegative(),
});

export const ArtifactUploadUrlInputSchema = z.strictObject({
  agentId: AgentIdSchema,
  name: z.string().trim().min(1),
  mimeType: z.string().trim().min(1),
  sizeBytes: z.number().int().nonnegative().optional(),
  kind: ArtifactKindSchema.optional(),
  metadata: ArtifactMetadataSchema.optional(),
  sha256: ArtifactSha256Schema.optional(),
});

export const ArtifactUploadUrlResponseSchema = z.strictObject({
  artifactId: ArtifactIdSchema,
  uploadUrl: z.string().url(),
  storageKey: z.string().trim().min(1),
  expiresInSec: z.number().int().positive(),
});

export const ArtifactDownloadUrlResponseSchema = z.strictObject({
  url: z.string().url(),
  expiresInSec: z.number().int().positive(),
  name: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
});

export const FileListResponseSchema = z.strictObject({
  entries: z.array(z.strictObject({
    name: z.string(),
    type: z.enum(['file', 'directory']),
    sizeBytes: z.number().int().nonnegative(),
  })),
});

export const FileReadResponseSchema = z.strictObject({
  path: z.string(),
  content: z.string(),
  sizeBytes: z.number().int().nonnegative(),
});

export const FileWriteInputSchema = z.strictObject({
  path: z.string().trim().min(1),
  content: z.string(),
  conversationId: z.string().trim().min(1).optional(),
});

export const FileWriteResponseSchema = z.strictObject({
  path: z.string(),
  sizeBytes: z.number().int().nonnegative(),
});

export const WorkspaceReplaceResponseSchema = z.strictObject({
  revision: z.number().int().positive(),
  sha256: z.string().trim().min(1),
  fileCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  appliedAt: EpochMillisecondsSchema,
});

export const WorkspaceRevisionResponseSchema = WorkspaceReplaceResponseSchema;

export const BUILTIN_WEBHOOK_EVENT_NAMES = [
  'turn.started',
  'turn.completed',
  'tool_call.started',
  'tool_call.completed',
  'interrupt.requested',
  'interrupt.resolved',
  'message.committed',
  'message.updated',
  'feedback.received',
  'budget.threshold',
  'artifact.created',
  'artifact.deleted',
  'turn.cancelled',
  'agent.deleted',
] as const;

export const BuiltinWebhookEventNameSchema = z.enum(BUILTIN_WEBHOOK_EVENT_NAMES);
export const WebhookEventNameSchema = z.union([
  BuiltinWebhookEventNameSchema,
  CustomEventNameSchema,
]);

export const WebhookCreateInputSchema = z.strictObject({
  url: z.string().url(),
  events: z.array(WebhookEventNameSchema).min(1),
  secret: z.string().min(1),
});

export const WebhookPatchInputSchema = WebhookCreateInputSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Webhook patch must include at least one field',
  });

export const WebhookSchema = z.strictObject({
  id: WebhookIdSchema,
  agentId: AgentIdSchema,
  url: z.string().url(),
  events: z.array(WebhookEventNameSchema),
  active: z.boolean(),
  hasSecret: z.boolean(),
  createdAt: EpochMillisecondsSchema,
  updatedAt: EpochMillisecondsSchema,
});

export const WebhookListResponseSchema = z.array(WebhookSchema);

export const HealthResponseSchema = z.strictObject({
  status: z.literal('ok'),
  timestamp: EpochMillisecondsSchema,
  // ctx-iqzy S13: camelCase like every other surface (was the API's one
  // snake_case island alongside /api/sandbox/metrics).
  sandbox: z.strictObject({
    executionMode: z.literal('sandbox'),
    containers: z.strictObject({
      active: z.number().int().nonnegative(),
      queued: z.number().int().nonnegative(),
      peak: z.number().int().nonnegative(),
      totalCreated: z.number().int().nonnegative(),
    }),
    limits: z.strictObject({
      maxGlobalContainers: z.number().int().positive(),
    }),
  }).optional(),
  // Optional so the client keeps accepting servers predating the arm.
  modelGateway: z.strictObject({
    enabled: z.boolean(),
    state: z.enum(['disabled', 'initializing', 'healthy', 'degraded']),
    lagMs: z.number().nonnegative().nullable(),
    awaitingTurns: z.number().int().nonnegative(),
    lastError: z.string().nullable(),
  }).optional(),
});

export const ConfigResponseSchema = z.strictObject({
  system: z.strictObject({
    version: z.string(),
    uptimeMs: DurationMsSchema,
    dbPath: z.string(),
  }),
  agentDefaults: z.strictObject({
    harness: z.string(),
    temperature: z.number(),
    maxTokens: z.number().int().positive(),
  }),
  authentication: z.strictObject({
    mode: z.enum(['enforced', 'disabled']),
  }),
});

export type ConfigResponse = z.infer<typeof ConfigResponseSchema>;

export const SandboxMetricsResponseSchema = z.strictObject({
  executionMode: z.literal('sandbox'),
  containers: z.strictObject({
    active: z.number().int().nonnegative(),
    queued: z.number().int().nonnegative(),
    peak: z.number().int().nonnegative(),
    totalCreated: z.number().int().nonnegative(),
    byHarness: z.record(z.string(), z.number().int().nonnegative()),
    averageLifetimeMs: DurationMsSchema,
  }),
  limits: z.strictObject({
    maxGlobalContainers: z.number().int().positive(),
  }),
});

export type AgentResourceLimits = z.infer<typeof AgentResourceLimitsSchema>;
export type AgentWorkspaceContent = z.infer<typeof AgentWorkspaceContentSchema>;
export type AgentMode = z.infer<typeof AgentModeSchema>;
export type HttpToolDefinition = z.infer<typeof HttpToolDefinitionSchema>;
export type McpServerDefinition = z.infer<typeof McpServerDefinitionSchema>;
export type McpServerAuth = z.infer<typeof McpServerAuthSchema>;
export type McpServerStatus = z.infer<typeof McpServerStatusSchema>;
export type McpServerToolSummary = z.infer<typeof McpServerToolSummarySchema>;
export type McpServerConnectResponse = z.infer<typeof McpServerConnectResponseSchema>;
export type AgentCreateInput = z.input<typeof AgentCreateInputSchema>;
export type AgentPatchInput = z.input<typeof AgentPatchInputSchema>;
export type Agent = z.infer<typeof AgentSchema>;
export type Turn = z.infer<typeof TurnSchema>;
export type TurnDetailResponse = z.infer<typeof TurnDetailResponseSchema>;
export type TurnStatus = z.infer<typeof TurnStatusSchema>;
export type TurnSearchInput = z.input<typeof TurnSearchInputSchema>;
export type TurnSearchResponse = z.infer<typeof TurnSearchResponseSchema>;
export type Message = z.infer<typeof MessageSchema>;
export type ConversationSnapshot = z.infer<typeof ConversationSnapshotResponseSchema>;
export type Conversation = z.infer<typeof ConversationSchema>;
export type ConversationSummary = z.infer<typeof ConversationSummarySchema>;
export type SandboxSession = z.infer<typeof SandboxSessionSchema>;
export type Interrupt = z.infer<typeof InterruptSchema>;
export type InterruptRecord = z.infer<typeof InterruptRecordSchema>;
export type InterruptRecordDetail = z.infer<typeof InterruptRecordDetailSchema>;
export type ApiCaller = z.infer<typeof ApiCallerSchema>;
export type InterruptRecordListInput = z.input<typeof InterruptRecordListInputSchema>;
export type PersistedEvent = z.infer<typeof PersistedEventSchema>;
export type EventListInput = z.input<typeof EventListInputSchema>;
export type EventListResponse = z.infer<typeof EventListResponseSchema>;
export type CustomEventName = z.infer<typeof CustomEventNameSchema>;
export type CustomEventPayload = z.infer<typeof CustomEventPayloadSchema>;
export type CustomEventEmitInput = z.input<typeof CustomEventEmitInputSchema>;
export type CustomEventEmitResponse = z.infer<typeof CustomEventEmitResponseSchema>;
export type CustomEventPayloadTooLargeError = z.infer<
  typeof CustomEventPayloadTooLargeErrorSchema
>;
export type BuiltinWebhookEventName = z.infer<typeof BuiltinWebhookEventNameSchema>;
export type Artifact = z.infer<typeof ArtifactSchema>;
export type ArtifactListInput = z.input<typeof ArtifactListInputSchema>;
export type ArtifactUploadUrlInput = z.input<typeof ArtifactUploadUrlInputSchema>;
export type Webhook = z.infer<typeof WebhookSchema>;
export type BackgroundTurnStartInput = z.input<typeof BackgroundTurnStartInputSchema>;
export type ConversationTurnStartInput = z.input<typeof ConversationTurnStartInputSchema>;
export type InterruptResolveInput = z.input<typeof InterruptResolveInputSchema>;
export type FileWriteInput = z.input<typeof FileWriteInputSchema>;
export type WebhookCreateInput = z.input<typeof WebhookCreateInputSchema>;
export type WebhookPatchInput = z.input<typeof WebhookPatchInputSchema>;
