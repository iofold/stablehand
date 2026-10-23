import { z } from 'zod';

import { EpochMillisSchema } from './time.js';

import {
  ApiCallerSchema,
  ArtifactKindSchema,
  ArtifactSha256Schema,
  CustomEventNameSchema,
  CustomEventPayloadSchema,
  WebhookEventNameSchema,
  type BuiltinWebhookEventName,
} from './api.js';
import {
  AgentIdSchema,
  ArtifactIdSchema,
  ConversationIdSchema,
  InterruptIdSchema,
  MessageIdSchema,
  SandboxSessionIdSchema,
  ToolCallIdSchema,
  TurnIdSchema,
  WebhookDeliveryIdSchema,
} from './ids.js';
import { TurnUsageSchema } from './usage.js';

export const STABLEHAND_WEBHOOK_SIGNATURE_VERSION = 'v1';
export const STABLEHAND_WEBHOOK_DEFAULT_TOLERANCE_SECONDS = 300;

const WebhookTimestampHeaderSchema = z.string()
  .regex(/^(0|[1-9]\d*)$/, 'Expected Unix time in whole seconds')
  .refine((value) => Number.isSafeInteger(Number(value)), 'Timestamp exceeds safe integer range');

export const StablehandWebhookHeadersSchema = z.strictObject({
  'X-Delivery-Id': WebhookDeliveryIdSchema,
  'X-Event-Type': WebhookEventNameSchema,
  'X-Agent-Id': AgentIdSchema,
  'X-Webhook-Timestamp': WebhookTimestampHeaderSchema,
  'X-Webhook-Signature': z.string().regex(/^v1=[0-9a-f]{64}$/),
});

// Payload timestamps are epoch-MILLISECONDS (unlike the X-Webhook-Timestamp
// signing header, which is unix seconds — see WEBHOOK_TIMESTAMP_TOLERANCE_SEC).
const TimestampSchema = EpochMillisSchema;

const turnIdentity = {
  turnId: TurnIdSchema,
  agentId: AgentIdSchema,
  conversationId: ConversationIdSchema,
};

const MessagePartSchema = z.looseObject({
  type: z.string(),
});

const MessageToolCallSchema = z.strictObject({
  id: ToolCallIdSchema,
  name: z.string(),
  args: z.string(),
  status: z.string(),
  error: z.string().optional(),
});

export const TurnStartedWebhookPayloadSchema = z.strictObject({
  ...turnIdentity,
  sandboxSessionId: SandboxSessionIdSchema,
  mode: z.enum(['interactive', 'background']),
  taskDescription: z.string(),
  timestamp: TimestampSchema,
});

export const TurnCompletedWebhookPayloadSchema = z.strictObject({
  ...turnIdentity,
  sandboxSessionId: SandboxSessionIdSchema.optional(),
  // ctx-iqzy S4: the same TurnStatus values REST serves — no lowercase shadow copy.
  status: z.enum(['COMPLETED', 'ERROR', 'CANCELLED']),
  error: z.string().optional(),
  durationMs: z.number().int().nonnegative(),
  usage: TurnUsageSchema.nullable(),
  timestamp: TimestampSchema,
});

export const ToolCallStartedWebhookPayloadSchema = z.strictObject({
  ...turnIdentity,
  toolCallId: ToolCallIdSchema,
  toolName: z.string(),
  args: z.record(z.string(), z.unknown()),
  requiresApproval: z.boolean().optional(),
  timestamp: TimestampSchema,
});

export const ToolCallCompletedWebhookPayloadSchema = z.strictObject({
  ...turnIdentity,
  toolCallId: ToolCallIdSchema,
  toolName: z.string(),
  result: z.string(),
  durationMs: z.number().int().nonnegative(),
  error: z.string().optional(),
  timestamp: TimestampSchema,
});

export const InterruptRequestedWebhookPayloadSchema = z.strictObject({
  ...turnIdentity,
  sandboxSessionId: SandboxSessionIdSchema.optional(),
  interruptId: InterruptIdSchema,
  toolCallId: ToolCallIdSchema,
  toolName: z.string(),
  args: z.record(z.string(), z.unknown()),
  timestamp: TimestampSchema,
});

export const InterruptResolvedWebhookPayloadSchema = z.strictObject({
  ...turnIdentity,
  sandboxSessionId: SandboxSessionIdSchema.optional(),
  interruptId: InterruptIdSchema,
  action: z.enum(['approve', 'reject', 'suspend', 'timeout']),
  resolvedBy: ApiCallerSchema.optional(),
  reason: z.string().optional(),
  timestamp: TimestampSchema,
});

export const MessageCommittedWebhookPayloadSchema = z.strictObject({
  ...turnIdentity,
  messageId: MessageIdSchema,
  messageSeq: z.number().int().nonnegative(),
  role: z.enum(['assistant', 'tool']),
  content: z.string(),
  parts: z.array(MessagePartSchema).optional(),
  toolCalls: z.array(MessageToolCallSchema).optional(),
  toolCallId: ToolCallIdSchema.optional(),
  timestamp: TimestampSchema,
});

export const MessageUpdatedWebhookPayloadSchema = z.strictObject({
  ...turnIdentity,
  messageId: MessageIdSchema,
  messageSeq: z.number().int().nonnegative(),
  messageRevision: z.number().int().positive(),
  role: z.literal('assistant'),
  content: z.string(),
  parts: z.array(MessagePartSchema).optional(),
  toolCalls: z.array(MessageToolCallSchema).optional(),
  timestamp: TimestampSchema,
});

export const FeedbackReceivedWebhookPayloadSchema = z.strictObject({
  feedbackId: z.string().trim().min(1),
  turnId: TurnIdSchema,
  agentId: AgentIdSchema,
  type: z.enum(['thumbs_up', 'thumbs_down']),
  messageId: MessageIdSchema.optional(),
  comment: z.string().max(4000).optional(),
  timestamp: TimestampSchema,
});

export const BudgetThresholdWebhookPayloadSchema = z.strictObject({
  policyId: z.string().trim().min(1),
  policyName: z.string(),
  bucket: z.string().optional(),
  action: z.enum(['warn', 'block']),
  threshold: z.number().nonnegative(),
  metric: z.enum(['totalTokens', 'costUsd', 'turns']),
  spent: z.number().nonnegative(),
  limit: z.number().nonnegative(),
  agentId: AgentIdSchema,
  /** Present when spend from a campaign gateway key crossed the threshold. */
  campaignKeyId: z.string().trim().min(1).optional(),
  timestamp: TimestampSchema,
});

export const ArtifactCreatedWebhookPayloadSchema = z.strictObject({
  artifactId: ArtifactIdSchema,
  agentId: AgentIdSchema,
  turnId: TurnIdSchema.optional(),
  name: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  kind: ArtifactKindSchema.optional(),
  sha256: ArtifactSha256Schema.optional(),
  timestamp: TimestampSchema,
});

// ctx-iqzy S20: previously-invisible lifecycle events, now subscribable.
export const ArtifactDeletedWebhookPayloadSchema = z.strictObject({
  artifactId: z.string(),
  // Webhooks are per-agent: unowned-artifact deletions have no subscriber,
  // so a delivered payload always carries a concrete agentId.
  agentId: z.string(),
  timestamp: TimestampSchema,
});

export const TurnCancelledWebhookPayloadSchema = z.strictObject({
  turnId: TurnIdSchema,
  agentId: AgentIdSchema,
  conversationId: ConversationIdSchema.nullable().optional(),
  timestamp: TimestampSchema,
});

export const AgentDeletedWebhookPayloadSchema = z.strictObject({
  agentId: AgentIdSchema,
  timestamp: TimestampSchema,
});

/** @experimental Extension-to-extension custom webhook envelope. */
export const CustomWebhookPayloadSchema = z.looseObject({
  type: CustomEventNameSchema,
  agentId: AgentIdSchema,
  turnId: TurnIdSchema.optional(),
  conversationId: ConversationIdSchema.optional(),
  payload: CustomEventPayloadSchema,
  timestamp: TimestampSchema,
});

export const WEBHOOK_PAYLOAD_SCHEMAS = {
  'turn.started': TurnStartedWebhookPayloadSchema,
  'turn.completed': TurnCompletedWebhookPayloadSchema,
  'tool_call.started': ToolCallStartedWebhookPayloadSchema,
  'tool_call.completed': ToolCallCompletedWebhookPayloadSchema,
  'interrupt.requested': InterruptRequestedWebhookPayloadSchema,
  'interrupt.resolved': InterruptResolvedWebhookPayloadSchema,
  'message.committed': MessageCommittedWebhookPayloadSchema,
  'message.updated': MessageUpdatedWebhookPayloadSchema,
  'feedback.received': FeedbackReceivedWebhookPayloadSchema,
  'budget.threshold': BudgetThresholdWebhookPayloadSchema,
  'artifact.created': ArtifactCreatedWebhookPayloadSchema,
  'artifact.deleted': ArtifactDeletedWebhookPayloadSchema,
  'turn.cancelled': TurnCancelledWebhookPayloadSchema,
  'agent.deleted': AgentDeletedWebhookPayloadSchema,
} as const satisfies Readonly<Record<BuiltinWebhookEventName, z.ZodType>>;

export const WebhookPayloadSchema = z.union([
  TurnStartedWebhookPayloadSchema,
  TurnCompletedWebhookPayloadSchema,
  ToolCallStartedWebhookPayloadSchema,
  ToolCallCompletedWebhookPayloadSchema,
  InterruptRequestedWebhookPayloadSchema,
  InterruptResolvedWebhookPayloadSchema,
  MessageCommittedWebhookPayloadSchema,
  MessageUpdatedWebhookPayloadSchema,
  FeedbackReceivedWebhookPayloadSchema,
  BudgetThresholdWebhookPayloadSchema,
  ArtifactCreatedWebhookPayloadSchema,
  ArtifactDeletedWebhookPayloadSchema,
  TurnCancelledWebhookPayloadSchema,
  AgentDeletedWebhookPayloadSchema,
  CustomWebhookPayloadSchema,
]);

export type WebhookEventName = z.infer<typeof WebhookEventNameSchema>;
export type StablehandWebhookHeaders = z.infer<typeof StablehandWebhookHeadersSchema>;
export type WebhookPayload = z.infer<typeof WebhookPayloadSchema>;

export type StablehandWebhookRawBody = string | Uint8Array | ArrayBuffer;

export interface CreateStablehandWebhookSignatureInput {
  secret: string;
  timestamp: string;
  rawBody: StablehandWebhookRawBody;
}

export interface VerifyStablehandWebhookInput {
  headers: StablehandWebhookHeaders | Record<string, string> | Headers;
  rawBody: StablehandWebhookRawBody;
  secrets: string | readonly string[];
  /** Unix time in whole seconds. Defaults to the current clock. */
  nowSeconds?: number;
  toleranceSeconds?: number;
}

export type VerifyStablehandWebhookResult =
  | {
    valid: true;
    headers: StablehandWebhookHeaders;
    payload: WebhookPayload;
  }
  | {
    valid: false;
    reason:
      | 'invalid_headers'
      | 'invalid_secrets'
      | 'timestamp_outside_tolerance'
      | 'invalid_signature'
      | 'invalid_payload'
      | 'header_body_mismatch';
  };

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

function rawBodyBytes(rawBody: StablehandWebhookRawBody): Uint8Array {
  if (typeof rawBody === 'string') {
    return textEncoder.encode(rawBody);
  }
  if (rawBody instanceof Uint8Array) {
    return new Uint8Array(rawBody);
  }
  return new Uint8Array(rawBody.slice(0));
}

function signingBytes(
  timestamp: string,
  rawBody: StablehandWebhookRawBody,
): Uint8Array<ArrayBuffer> {
  const prefix = textEncoder.encode(`${timestamp}.`);
  const body = rawBodyBytes(rawBody);
  const signed = new Uint8Array(prefix.byteLength + body.byteLength);
  signed.set(prefix);
  signed.set(body, prefix.byteLength);
  return signed;
}

function bytesToHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.byteLength ^ right.byteLength;
  const length = Math.max(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index++) {
    difference |= (left[index % left.byteLength] ?? 0) ^ (right[index % right.byteLength] ?? 0);
  }
  return difference === 0;
}

async function hmacSha256(
  secret: string,
  timestamp: string,
  rawBody: StablehandWebhookRawBody,
): Promise<Uint8Array> {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Web Crypto HMAC support is required');
  }
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await globalThis.crypto.subtle.sign(
    'HMAC',
    key,
    signingBytes(timestamp, rawBody),
  );
  return new Uint8Array(signature);
}

/**
 * Creates `v1=<hex-hmac>` over the exact bytes:
 * `utf8(X-Webhook-Timestamp) || "." || raw HTTP body`.
 */
export async function createStablehandWebhookSignature(
  input: CreateStablehandWebhookSignatureInput,
): Promise<string> {
  const timestamp = WebhookTimestampHeaderSchema.parse(input.timestamp);
  const secret = z.string().min(1).parse(input.secret);
  const signature = await hmacSha256(secret, timestamp, input.rawBody);
  return `${STABLEHAND_WEBHOOK_SIGNATURE_VERSION}=${bytesToHex(signature)}`;
}

function canonicalHeaders(
  input: VerifyStablehandWebhookInput['headers'],
): unknown {
  if (typeof Headers !== 'undefined' && input instanceof Headers) {
    return {
      'X-Delivery-Id': input.get('X-Delivery-Id'),
      'X-Event-Type': input.get('X-Event-Type'),
      'X-Agent-Id': input.get('X-Agent-Id'),
      'X-Webhook-Timestamp': input.get('X-Webhook-Timestamp'),
      'X-Webhook-Signature': input.get('X-Webhook-Signature'),
    };
  }
  return input;
}

/**
 * Verifies clock skew, all active/previous rotation keys without key-order
 * short-circuiting, the exact raw-body HMAC, and signed header/body identities.
 */
export async function verifyStablehandWebhook(
  input: VerifyStablehandWebhookInput,
): Promise<VerifyStablehandWebhookResult> {
  const parsedHeaders = StablehandWebhookHeadersSchema.safeParse(canonicalHeaders(input.headers));
  if (!parsedHeaders.success) {
    return { valid: false, reason: 'invalid_headers' };
  }
  const headers = parsedHeaders.data;

  const parsedSecrets = z.array(z.string().min(1)).min(1).safeParse(
    typeof input.secrets === 'string' ? [input.secrets] : input.secrets,
  );
  if (!parsedSecrets.success) {
    return { valid: false, reason: 'invalid_secrets' };
  }

  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1_000);
  const toleranceSeconds = input.toleranceSeconds
    ?? STABLEHAND_WEBHOOK_DEFAULT_TOLERANCE_SECONDS;
  if (
    !Number.isSafeInteger(nowSeconds)
    || !Number.isSafeInteger(toleranceSeconds)
    || toleranceSeconds < 0
  ) {
    throw new RangeError('Webhook clock values must be safe whole seconds');
  }
  const timestamp = Number(headers['X-Webhook-Timestamp']);
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) {
    return { valid: false, reason: 'timestamp_outside_tolerance' };
  }

  const receivedSignature = hexToBytes(
    headers['X-Webhook-Signature'].slice(`${STABLEHAND_WEBHOOK_SIGNATURE_VERSION}=`.length),
  );
  let signatureValid = false;
  for (const secret of parsedSecrets.data) {
    const expected = await hmacSha256(secret, headers['X-Webhook-Timestamp'], input.rawBody);
    signatureValid = constantTimeEqual(expected, receivedSignature) || signatureValid;
  }
  if (!signatureValid) {
    return { valid: false, reason: 'invalid_signature' };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(textDecoder.decode(rawBodyBytes(input.rawBody))) as unknown;
  } catch {
    return { valid: false, reason: 'invalid_payload' };
  }
  const eventType = headers['X-Event-Type'];
  const builtInSchema = Object.prototype.hasOwnProperty.call(
    WEBHOOK_PAYLOAD_SCHEMAS,
    eventType,
  )
    ? WEBHOOK_PAYLOAD_SCHEMAS[eventType as BuiltinWebhookEventName]
    : undefined;
  const parsedPayload = (builtInSchema ?? CustomWebhookPayloadSchema).safeParse(decoded);
  if (!parsedPayload.success) {
    return { valid: false, reason: 'invalid_payload' };
  }
  const payload = parsedPayload.data;
  if (headers['X-Agent-Id'] !== payload.agentId) {
    return { valid: false, reason: 'header_body_mismatch' };
  }
  if (!builtInSchema && headers['X-Event-Type'] !== CustomWebhookPayloadSchema.parse(payload).type) {
    return { valid: false, reason: 'header_body_mismatch' };
  }

  return { valid: true, headers, payload };
}
