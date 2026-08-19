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

const UnknownRecordSchema = z.record(z.string(), z.unknown());
const StringRecordSchema = z.record(z.string(), z.string());

export const ARTIFACT_METADATA_MAX_BYTES = 16 * 1024;
export const CUSTOM_EVENT_PAYLOAD_MAX_BYTES = 32 * 1024;
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
  `Custom event payload must not exceed ${CUSTOM_EVENT_PAYLOAD_MAX_BYTES} serialized bytes`,
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
  error: z.literal('custom_event_payload_too_large'),
  maxBytes: z.literal(CUSTOM_EVENT_PAYLOAD_MAX_BYTES),
});

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
});

export const AgentCreateInputSchema = z.strictObject({
  name: z.string().trim().min(1),
  harness: z.string().trim().min(1),
  harnessConfig: UnknownRecordSchema,
  systemPrompt: z.string(),
  tools: z.array(z.string().trim().min(1)),
  httpTools: z.array(HttpToolDefinitionSchema).optional(),
  builtinToolPolicy: BuiltinToolPolicySchema.optional(),
  description: z.string().optional(),
  metadata: UnknownRecordSchema.optional(),
  resourceLimits: AgentResourceLimitsSchema.nullable().optional(),
  nativeToolPolicy: NativeToolPolicySchema.optional(),
  workspaceContent: AgentWorkspaceContentSchema.optional(),
  mode: AgentModeSchema.optional(),
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
    manifest: UnknownRecordSchema.nullable().optional(),
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
  workspaceContent: AgentWorkspaceContentSchema.nullable(),
  mode: AgentModeSchema.nullable(),
  resourceLimits: AgentResourceLimitsSchema.nullable(),
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

export const SecretListResponseSchema = z.strictObject({
  keys: z.array(z.string().trim().min(1)),
});

export const SecretPutInputSchema = z.strictObject({
  key: z.string().trim().min(1),
  value: z.string().min(1),
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
  return key.startsWith('CTXMILL_')
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

export const BackgroundTurnStartResponseSchema = z.strictObject({
  turnId: TurnIdSchema,
  conversationId: ConversationIdSchema,
  sandboxSessionId: SandboxSessionIdSchema.nullable(),
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

export const ToolCallStateSchema = z.strictObject({
  id: ToolCallIdSchema,
  name: z.string(),
  args: z.string(),
  result: z.string().optional(),
  error: z.string().optional(),
  status: z.enum(['pending', 'running', 'complete', 'error']),
  durationMs: z.number().nonnegative().optional(),
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
  resolvedAt: EpochMillisecondsSchema.nullable(),
  resolvedAction: InterruptActionSchema.nullable(),
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
});

export const InterruptResolveResponseSchema = z.union([
  z.strictObject({
    resolved: z.literal(true),
    action: z.enum(['approve', 'reject']),
    note: z.string().optional(),
  }),
  z.strictObject({
    alreadyResolved: z.literal(true),
    action: z.enum(['approve', 'reject']).nullable(),
  }),
  z.strictObject({
    accepted: z.literal(true),
    resuming: z.boolean(),
    action: z.enum(['approve', 'reject']),
    resumeAttemptId: z.string().trim().min(1),
    error: z.string().optional(),
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
  total: z.number().int().nonnegative().optional(),
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

export const ArtifactDeleteResponseSchema = z.strictObject({
  deleted: z.literal(true),
  id: ArtifactIdSchema,
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
  sandbox: z.strictObject({
    execution_mode: z.literal('sandbox'),
    containers: z.strictObject({
      active: z.number().int().nonnegative(),
      queued: z.number().int().nonnegative(),
      peak: z.number().int().nonnegative(),
      total_created: z.number().int().nonnegative(),
    }),
    limits: z.strictObject({
      max_global_containers: z.number().int().positive(),
    }),
  }).optional(),
  // Optional so the client keeps accepting servers predating the arm.
  model_gateway: z.strictObject({
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
  execution_mode: z.literal('sandbox'),
  containers: z.strictObject({
    active: z.number().int().nonnegative(),
    queued: z.number().int().nonnegative(),
    peak: z.number().int().nonnegative(),
    total_created: z.number().int().nonnegative(),
    by_harness: z.record(z.string(), z.number().int().nonnegative()),
    average_lifetime_ms: z.number().nonnegative(),
  }),
  limits: z.strictObject({
    max_global_containers: z.number().int().positive(),
  }),
});

export type AgentResourceLimits = z.infer<typeof AgentResourceLimitsSchema>;
export type AgentWorkspaceContent = z.infer<typeof AgentWorkspaceContentSchema>;
export type AgentMode = z.infer<typeof AgentModeSchema>;
export type HttpToolDefinition = z.infer<typeof HttpToolDefinitionSchema>;
export type AgentCreateInput = z.input<typeof AgentCreateInputSchema>;
export type AgentPatchInput = z.input<typeof AgentPatchInputSchema>;
export type Agent = z.infer<typeof AgentSchema>;
export type Turn = z.infer<typeof TurnSchema>;
export type TurnDetailResponse = z.infer<typeof TurnDetailResponseSchema>;
export type Message = z.infer<typeof MessageSchema>;
export type ConversationSnapshot = z.infer<typeof ConversationSnapshotResponseSchema>;
export type Conversation = z.infer<typeof ConversationSchema>;
export type ConversationSummary = z.infer<typeof ConversationSummarySchema>;
export type SandboxSession = z.infer<typeof SandboxSessionSchema>;
export type Interrupt = z.infer<typeof InterruptSchema>;
export type InterruptRecord = z.infer<typeof InterruptRecordSchema>;
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
