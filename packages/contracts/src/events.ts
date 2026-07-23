import { z } from 'zod';

import {
  AgentIdSchema,
  ConversationIdSchema,
  InterruptIdSchema,
  MessageIdSchema,
  SandboxSessionIdSchema,
  ToolCallIdSchema,
  TurnIdSchema,
} from './ids.js';
import { TurnUsageSchema } from './usage.js';

const UnknownRecordSchema = z.record(z.string(), z.unknown());
const TimestampSchema = z.number().int().nonnegative().optional();

const StreamToolCallStateSchema = z.strictObject({
  id: ToolCallIdSchema,
  name: z.string(),
  args: z.string(),
  result: z.string().optional(),
  error: z.string().optional(),
  status: z.enum(['pending', 'running', 'complete', 'error']),
});

const StreamMessagePartSchema = z.discriminatedUnion('type', [
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
    status: z.enum(['pending', 'running', 'complete', 'error']),
  }),
]);

export const AgUiMessageSchema = z.strictObject({
  id: MessageIdSchema,
  role: z.enum(['developer', 'system', 'assistant', 'user', 'tool']),
  content: z.string().optional(),
  name: z.string().optional(),
  toolCallId: ToolCallIdSchema.optional(),
  toolCalls: z.array(StreamToolCallStateSchema).optional(),
  parts: z.array(StreamMessagePartSchema).optional(),
  createdAt: z.number().int().nonnegative().optional(),
});

export const AgUiToolSchema = z.strictObject({
  name: z.string().trim().min(1),
  description: z.string(),
  parameters: z.unknown(),
});

export const AgUiContextEntrySchema = z.strictObject({
  description: z.string(),
  value: z.string(),
});

const RunFrameIdentity = {
  runId: z.string().trim().min(1),
  threadId: z.string().trim().min(1),
  timestamp: TimestampSchema,
};

export const MessagesSnapshotEventSchema = z.strictObject({
  type: z.literal('MESSAGES_SNAPSHOT'),
  ...RunFrameIdentity,
  messages: z.array(AgUiMessageSchema),
});

export const RunStartedEventSchema = z.strictObject({
  type: z.literal('RUN_STARTED'),
  ...RunFrameIdentity,
});

export const RunFinishedEventSchema = z.strictObject({
  type: z.literal('RUN_FINISHED'),
  ...RunFrameIdentity,
  status: z.string().optional(),
  usage: TurnUsageSchema.nullable(),
});

export const RunErrorEventSchema = z.strictObject({
  type: z.literal('RUN_ERROR'),
  ...RunFrameIdentity,
  message: z.string(),
  status: z.string().optional(),
});

export const TextMessageStartEventSchema = z.strictObject({
  type: z.literal('TEXT_MESSAGE_START'),
  ...RunFrameIdentity,
  messageId: MessageIdSchema,
  role: z.enum(['assistant', 'user', 'system', 'tool']),
});

export const TextMessageContentEventSchema = z.strictObject({
  type: z.literal('TEXT_MESSAGE_CONTENT'),
  ...RunFrameIdentity,
  messageId: MessageIdSchema,
  delta: z.string(),
});

export const TextMessageEndEventSchema = z.strictObject({
  type: z.literal('TEXT_MESSAGE_END'),
  ...RunFrameIdentity,
  messageId: MessageIdSchema,
});

export const ToolCallStartEventSchema = z.strictObject({
  type: z.literal('TOOL_CALL_START'),
  ...RunFrameIdentity,
  toolCallId: ToolCallIdSchema,
  toolCallName: z.string(),
  parentMessageId: MessageIdSchema.optional(),
});

export const ToolCallArgsEventSchema = z.strictObject({
  type: z.literal('TOOL_CALL_ARGS'),
  ...RunFrameIdentity,
  toolCallId: ToolCallIdSchema,
  delta: z.string(),
});

export const ToolCallEndEventSchema = z.strictObject({
  type: z.literal('TOOL_CALL_END'),
  ...RunFrameIdentity,
  toolCallId: ToolCallIdSchema,
});

export const ToolCallResultEventSchema = z.strictObject({
  type: z.literal('TOOL_CALL_RESULT'),
  ...RunFrameIdentity,
  toolCallId: ToolCallIdSchema,
  result: z.unknown().optional(),
  error: z.string().optional(),
});

export const StateDeltaEventSchema = z.strictObject({
  type: z.literal('STATE_DELTA'),
  ...RunFrameIdentity,
  delta: z.unknown(),
});

export const TurnPendingEventSchema = z.strictObject({
  type: z.literal('CUSTOM'),
  name: z.literal('ctxmill.turn.pending'),
  agentId: AgentIdSchema,
  turnId: TurnIdSchema,
  conversationId: ConversationIdSchema,
  mode: z.enum(['interactive', 'background']),
  taskDescription: z.string().optional(),
  timestamp: z.number().int().nonnegative(),
});

export const InterruptRequestedEventSchema = z.strictObject({
  type: z.literal('CUSTOM'),
  name: z.literal('ctxmill.interrupt.requested'),
  agentId: AgentIdSchema,
  turnId: TurnIdSchema,
  conversationId: ConversationIdSchema,
  sandboxSessionId: SandboxSessionIdSchema.optional(),
  interruptId: InterruptIdSchema,
  toolCallId: ToolCallIdSchema,
  toolCallName: z.string(),
  args: UnknownRecordSchema,
  timestamp: z.number().int().nonnegative(),
});

export const InterruptResolvedEventSchema = z.strictObject({
  type: z.literal('CUSTOM'),
  name: z.literal('ctxmill.interrupt.resolved'),
  agentId: AgentIdSchema,
  turnId: TurnIdSchema,
  conversationId: ConversationIdSchema,
  sandboxSessionId: SandboxSessionIdSchema.optional(),
  interruptId: InterruptIdSchema,
  action: z.enum(['approve', 'reject', 'suspend', 'timeout']),
  timestamp: z.number().int().nonnegative(),
});

export const MessageCommittedEventSchema = z.strictObject({
  type: z.literal('CUSTOM'),
  name: z.literal('ctxmill.message.committed'),
  agentId: AgentIdSchema,
  turnId: TurnIdSchema,
  conversationId: ConversationIdSchema,
  messageId: MessageIdSchema,
  role: z.enum(['assistant', 'tool']),
  content: z.string(),
  messageSeq: z.number().int().nonnegative(),
  parts: z.array(StreamMessagePartSchema).optional(),
  toolCalls: z.array(StreamToolCallStateSchema).optional(),
  toolCallId: ToolCallIdSchema.optional(),
  timestamp: z.number().int().nonnegative(),
});

export const MessageUpdatedEventSchema = z.strictObject({
  type: z.literal('CUSTOM'),
  name: z.literal('ctxmill.message.updated'),
  agentId: AgentIdSchema,
  turnId: TurnIdSchema,
  conversationId: ConversationIdSchema,
  messageId: MessageIdSchema,
  messageSeq: z.number().int().nonnegative(),
  messageRevision: z.number().int().positive(),
  role: z.literal('assistant'),
  content: z.string(),
  parts: z.array(StreamMessagePartSchema).optional(),
  toolCalls: z.array(StreamToolCallStateSchema).optional(),
  timestamp: z.number().int().nonnegative(),
});

export const A2UiRenderEventSchema = z.strictObject({
  type: z.literal('CUSTOM'),
  name: z.literal('ctxmill.a2ui.render'),
  runId: z.string().trim().min(1).optional(),
  threadId: z.string().trim().min(1).optional(),
  block: z.strictObject({
    id: z.string().trim().min(1),
    component: z.string().trim().min(1),
    props: UnknownRecordSchema,
  }),
  timestamp: TimestampSchema,
});

export const SandboxSessionSnapshotEventSchema = z.strictObject({
  type: z.literal('CUSTOM'),
  name: z.literal('ctxmill.sandbox_session.snapshot'),
  agentId: AgentIdSchema,
  conversationId: ConversationIdSchema,
  sandboxSessionId: SandboxSessionIdSchema,
  activeTurnId: TurnIdSchema.nullable(),
  status: z.enum(['ACTIVE', 'RESTORING']),
  harnessName: z.string(),
  containerName: z.string().nullable(),
  timestamp: z.number().int().nonnegative(),
});

export const GenericCustomEventSchema = z.strictObject({
  type: z.literal('CUSTOM'),
  name: z.string().refine((name) => !name.startsWith('ctxmill.'), {
    message: 'ctxmill.* custom events require a dedicated contract',
  }),
  runId: z.string().trim().min(1).optional(),
  threadId: z.string().trim().min(1).optional(),
  value: z.unknown().optional(),
  timestamp: TimestampSchema,
});

export const CanonicalStreamEventSchema = z.union([
  MessagesSnapshotEventSchema,
  RunStartedEventSchema,
  RunFinishedEventSchema,
  RunErrorEventSchema,
  TextMessageStartEventSchema,
  TextMessageContentEventSchema,
  TextMessageEndEventSchema,
  ToolCallStartEventSchema,
  ToolCallArgsEventSchema,
  ToolCallEndEventSchema,
  ToolCallResultEventSchema,
  StateDeltaEventSchema,
  TurnPendingEventSchema,
  InterruptRequestedEventSchema,
  InterruptResolvedEventSchema,
  MessageCommittedEventSchema,
  MessageUpdatedEventSchema,
  A2UiRenderEventSchema,
  GenericCustomEventSchema,
]);

export const ConnectedEventSchema = z.strictObject({
  type: z.literal('CONNECTED'),
  agentId: AgentIdSchema,
  latestSeq: z.number().int().nonnegative(),
  timestamp: z.number().int().nonnegative(),
});

export const AgentStreamEventSchema = z.union([
  ConnectedEventSchema,
  SandboxSessionSnapshotEventSchema,
  CanonicalStreamEventSchema,
]);

export type AgUiMessage = z.infer<typeof AgUiMessageSchema>;
export type AgUiMessageInput = z.input<typeof AgUiMessageSchema>;
export type AgUiTool = z.infer<typeof AgUiToolSchema>;
export type AgUiToolInput = z.input<typeof AgUiToolSchema>;
export type AgUiContextEntry = z.infer<typeof AgUiContextEntrySchema>;
export type AgUiContextEntryInput = z.input<typeof AgUiContextEntrySchema>;
export type CanonicalStreamEvent = z.infer<typeof CanonicalStreamEventSchema>;
export type AgentStreamEvent = z.infer<typeof AgentStreamEventSchema>;
export type InterruptRequestedEvent = z.infer<typeof InterruptRequestedEventSchema>;
export type A2UiRenderEvent = z.infer<typeof A2UiRenderEventSchema>;
