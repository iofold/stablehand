import {
  createCtxmillId,
  getA2UIBlock,
  getInterruptRequest,
  type CtxmillA2UIBlock,
  type CtxmillInterruptRequest,
  type CtxmillMessage,
  type CtxmillStreamEvent,
} from '@ctxmill/client';

export interface CtxmillTextPart {
  type: 'text';
  content: string;
}

export interface CtxmillToolCallPart {
  type: 'tool_call';
  id: string;
  name: string;
  args: string;
  result?: string;
  error?: string;
  status: 'running' | 'complete' | 'error';
}

export interface CtxmillA2UIPart {
  type: 'a2ui';
  block: CtxmillA2UIBlock;
}

export type CtxmillChatPart = CtxmillTextPart | CtxmillToolCallPart | CtxmillA2UIPart;

export interface CtxmillChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  parts: CtxmillChatPart[];
  toolCallId?: string;
  createdAt: string;
}

/**
 * Where the current run is in its lifecycle, for streaming feedback UI:
 * submitted (request sent) → provisioning (sandbox spinning up) →
 * thinking (model working, no visible text yet) → streaming (text flowing)
 * with tool (a tool call is executing) interleaved. 'idle' when no run.
 */
export type CtxmillRunPhase = 'idle' | 'submitted' | 'provisioning' | 'thinking' | 'tool' | 'streaming';

export interface CtxmillChatState {
  threadId: string;
  messages: CtxmillChatMessage[];
  isRunning: boolean;
  runPhase: CtxmillRunPhase;
  error: string | null;
  pendingHitl: CtxmillInterruptRequest | null;
  activeAssistantMessageId: string | null;
  messageRevisions: Map<string, number>;
  optimisticUserMessageIds: string[];
  reconciledUserMessageIds: string[];
}

export type CtxmillPersistedMessage = Omit<CtxmillMessage, 'createdAt'> & {
  messageRevision: number;
  createdAt?: number | string;
};

export type CtxmillChatAction =
  | { type: 'load_messages'; messages: CtxmillPersistedMessage[]; threadId?: string }
  | { type: 'append_user_message'; message: CtxmillMessage }
  | { type: 'discard_optimistic_user_message'; messageId: string }
  | { type: 'stream_event'; event: CtxmillStreamEvent }
  | { type: 'hitl_resolved'; interruptId?: string }
  | { type: 'set_error'; error: string | null }
  | { type: 'run_settled' }
  | { type: 'reset'; threadId: string };

function nowIso(): string {
  return new Date().toISOString();
}

function canonicalCreatedAt(value: number | string | undefined): string {
  if (value === undefined) return nowIso();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? nowIso() : parsed.toISOString();
}

export function createInitialChatState(threadId?: string): CtxmillChatState {
  return {
    threadId: threadId ?? createCtxmillId('thread'),
    messages: [],
    isRunning: false,
    runPhase: 'idle',
    error: null,
    pendingHitl: null,
    activeAssistantMessageId: null,
    messageRevisions: new Map(),
    optimisticUserMessageIds: [],
    reconciledUserMessageIds: [],
  };
}

export function toCtxmillMessages(messages: CtxmillChatMessage[]): CtxmillMessage[] {
  return messages
    .filter((message) => message.role === 'user' || message.role === 'assistant' || message.role === 'system' || message.role === 'tool')
    .map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      parts: message.parts.flatMap((part) => part.type === 'a2ui' ? [] : [part]),
      ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    }));
}

function normalizeToolStatus(
  status: 'pending' | 'running' | 'complete' | 'error',
): CtxmillToolCallPart['status'] {
  return status === 'pending' ? 'running' : status;
}

function normalizeMessage(
  message: Omit<CtxmillMessage, 'createdAt'> & {
    createdAt?: number | string;
  },
): CtxmillChatMessage {
  const content = message.content ?? '';
  const parts: CtxmillChatPart[] = [];
  const partToolCallIds = new Set<string>();
  if (message.parts && message.parts.length > 0) {
    for (const part of message.parts) {
      if (part.type === 'text') {
        parts.push({ type: 'text', content: part.content });
      } else {
        partToolCallIds.add(part.id);
        parts.push({
          type: 'tool_call',
          id: part.id,
          name: part.name,
          args: part.args,
          ...(part.result !== undefined ? { result: part.result } : {}),
          ...(part.error !== undefined ? { error: part.error } : {}),
          status: normalizeToolStatus(part.status),
        });
      }
    }
  } else {
    if (content) {
      parts.push({ type: 'text', content });
    }
  }
  for (const toolCall of message.toolCalls ?? []) {
    if (!partToolCallIds.has(toolCall.id)) {
      parts.push({
        type: 'tool_call',
        id: toolCall.id,
        name: toolCall.name,
        args: toolCall.args,
        ...(toolCall.result !== undefined ? { result: toolCall.result } : {}),
        ...(toolCall.error !== undefined ? { error: toolCall.error } : {}),
        status: normalizeToolStatus(toolCall.status),
      });
    }
  }
  return {
    id: message.id,
    role: message.role === 'developer' ? 'system' : message.role,
    content,
    parts,
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    createdAt: canonicalCreatedAt(message.createdAt),
  };
}

function revisionBaselines(
  messages: ReadonlyArray<{ id: string; messageRevision?: number }>,
): Map<string, number> {
  return new Map(messages.map((message) => {
    const revision = message.messageRevision;
    return [
      message.id,
      Number.isInteger(revision) && revision !== undefined && revision >= 0
        ? revision
        : 0,
    ];
  }));
}

type CtxmillCustomEvent = Extract<CtxmillStreamEvent, { type: 'CUSTOM' }>;
type MessageCommittedCustomEvent = Extract<
  CtxmillCustomEvent,
  { name: 'ctxmill.message.committed' }
>;
type MessageUpdatedCustomEvent = Extract<
  CtxmillCustomEvent,
  { name: 'ctxmill.message.updated' }
>;

function isMessageCommittedEvent(
  event: CtxmillCustomEvent,
): event is MessageCommittedCustomEvent {
  return event.name === 'ctxmill.message.committed' && 'messageId' in event;
}

function isMessageUpdatedEvent(
  event: CtxmillCustomEvent,
): event is MessageUpdatedCustomEvent {
  return event.name === 'ctxmill.message.updated'
    && 'messageId' in event
    && 'messageRevision' in event;
}

function canonicalMessageFromEvent(
  event: CtxmillCustomEvent,
  existing: CtxmillChatMessage | undefined,
): CtxmillChatMessage | null {
  if (
    !('messageId' in event)
    || typeof event.messageId !== 'string'
    || !('role' in event)
    || (event.role !== 'assistant' && event.role !== 'tool')
  ) {
    return null;
  }
  const message = normalizeMessage({
    id: event.messageId,
    role: event.role,
    content: 'content' in event && typeof event.content === 'string' ? event.content : '',
    createdAt: event.timestamp,
    ...('parts' in event && Array.isArray(event.parts) ? { parts: event.parts } : {}),
    ...('toolCalls' in event && Array.isArray(event.toolCalls) ? { toolCalls: event.toolCalls } : {}),
    ...('toolCallId' in event && typeof event.toolCallId === 'string'
      ? { toolCallId: event.toolCallId }
      : {}),
  });
  return {
    ...message,
    createdAt: existing?.createdAt ?? message.createdAt,
  };
}

function canonicalToolCallIds(event: CtxmillCustomEvent): Set<string> {
  const ids = new Set<string>();
  if ('parts' in event && Array.isArray(event.parts)) {
    for (const part of event.parts) {
      if (part.type === 'tool_call') ids.add(part.id);
    }
  }
  if ('toolCalls' in event && Array.isArray(event.toolCalls)) {
    for (const toolCall of event.toolCalls) ids.add(toolCall.id);
  }
  return ids;
}

function messageContainsAnyToolCall(
  message: CtxmillChatMessage,
  toolCallIds: ReadonlySet<string>,
): boolean {
  return message.parts.some((part) =>
    part.type === 'tool_call' && toolCallIds.has(part.id),
  );
}

function upsertCanonicalMessage(
  messages: CtxmillChatMessage[],
  message: CtxmillChatMessage,
  transientMessageId: string | null,
  toolCallIds: ReadonlySet<string>,
): CtxmillChatMessage[] {
  const retained = messages.filter((candidate) => {
    if (candidate.id === message.id) return true;
    if (transientMessageId && candidate.id === transientMessageId) return false;
    return !messageContainsAnyToolCall(candidate, toolCallIds);
  });
  return updateMessage(retained, message.id, () => message, message.role);
}

function assistantIdFor(event: CtxmillStreamEvent): string {
  if ('messageId' in event && typeof event.messageId === 'string') {
    return event.messageId;
  }
  if ('runId' in event && typeof event.runId === 'string') {
    return `assistant-${event.runId}`;
  }
  return createCtxmillId('assistant');
}

function updateMessage(
  messages: CtxmillChatMessage[],
  id: string,
  update: (message: CtxmillChatMessage) => CtxmillChatMessage,
  role: CtxmillChatMessage['role'] = 'assistant',
  createdAt = nowIso(),
): CtxmillChatMessage[] {
  let found = false;
  const next = messages.map((message) => {
    if (message.id !== id) return message;
    found = true;
    return update(message);
  });
  if (found) return next;
  return [
    ...messages,
    update({
      id,
      role,
      content: '',
      parts: [],
      createdAt,
    }),
  ];
}

function appendText(message: CtxmillChatMessage, delta: string): CtxmillChatMessage {
  const parts = [...message.parts];
  const last = parts[parts.length - 1];
  if (last?.type === 'text') {
    parts[parts.length - 1] = { type: 'text', content: last.content + delta };
  } else {
    parts.push({ type: 'text', content: delta });
  }
  return {
    ...message,
    content: message.content + delta,
    parts,
  };
}

function updateToolPart(
  message: CtxmillChatMessage,
  toolCallId: string,
  update: (part: CtxmillToolCallPart) => CtxmillToolCallPart,
): CtxmillChatMessage {
  let found = false;
  const parts = message.parts.map((part) => {
    if (part.type !== 'tool_call' || part.id !== toolCallId) return part;
    found = true;
    return update(part);
  });
  if (!found) {
    parts.push(update({
      type: 'tool_call',
      id: toolCallId,
      name: 'tool',
      args: '',
      status: 'running',
    }));
  }
  return { ...message, parts };
}

function appendA2UIBlock(message: CtxmillChatMessage, block: CtxmillA2UIBlock): CtxmillChatMessage {
  return {
    ...message,
    parts: [...message.parts, { type: 'a2ui', block }],
  };
}

export function reduceCtxmillChatState(
  state: CtxmillChatState,
  action: CtxmillChatAction,
): CtxmillChatState {
  switch (action.type) {
    case 'load_messages': {
      const messages = action.messages.map(normalizeMessage);
      return {
        ...state,
        threadId: action.threadId ?? state.threadId,
        messages,
        messageRevisions: revisionBaselines(action.messages),
        optimisticUserMessageIds: [],
        reconciledUserMessageIds: [],
      };
    }

    case 'append_user_message':
      return {
        ...state,
        error: null,
        // Optimistic: feedback starts the moment the user sends, not when
        // the server's RUN_STARTED lands (sandbox spin-up can take seconds).
        isRunning: true,
        runPhase: 'submitted',
        messages: [...state.messages, normalizeMessage(action.message)],
        optimisticUserMessageIds: [
          ...state.optimisticUserMessageIds,
          action.message.id,
        ],
      };

    case 'discard_optimistic_user_message':
      if (
        !state.optimisticUserMessageIds.includes(action.messageId)
      ) {
        return state;
      }
      return {
        ...state,
        messages: state.messages.filter(
          (message) => message.id !== action.messageId,
        ),
        optimisticUserMessageIds:
          state.optimisticUserMessageIds.filter(
            (messageId) => messageId !== action.messageId,
          ),
      };

    // Stream closed without a terminal frame (stop/abort, dropped connection).
    // Idempotent after RUN_FINISHED / RUN_ERROR.
    case 'run_settled':
      return {
        ...state,
        isRunning: false,
        runPhase: 'idle',
        activeAssistantMessageId: null,
      };

    case 'hitl_resolved':
      return {
        ...state,
        pendingHitl: action.interruptId && state.pendingHitl?.interruptId !== action.interruptId ? state.pendingHitl : null,
      };

    case 'set_error':
      return {
        ...state,
        isRunning: false,
        runPhase: 'idle',
        error: action.error,
      };

    case 'reset':
      return createInitialChatState(action.threadId);

    case 'stream_event': {
      const { event } = action;
      if (event.type === 'MESSAGES_SNAPSHOT') {
        const messages = event.messages.map(normalizeMessage);
        return {
          ...state,
          threadId: event.threadId,
          messages,
          messageRevisions: revisionBaselines(messages),
          optimisticUserMessageIds: [],
          reconciledUserMessageIds: [],
        };
      }
      if (event.type === 'RUN_STARTED') {
        return { ...state, isRunning: true, runPhase: 'thinking', error: null };
      }
      if (event.type === 'TEXT_MESSAGE_START') {
        const optimisticUserMessageId = event.role === 'user'
          ? state.optimisticUserMessageIds[0]
          : undefined;
        const optimisticMessage = optimisticUserMessageId
          ? state.messages.find(
              (message) => message.id === optimisticUserMessageId,
            )
          : undefined;
        const messages = optimisticMessage
          ? state.messages.map((message) =>
              message.id === optimisticUserMessageId
                ? {
                    ...message,
                    id: event.messageId,
                    role: 'user' as const,
                    createdAt: canonicalCreatedAt(event.timestamp),
                  }
                : message)
          : updateMessage(
              state.messages,
              event.messageId,
              (message) => ({
                ...message,
                role: event.role,
                content: '',
                parts: [],
              }),
              event.role,
              canonicalCreatedAt(event.timestamp),
            );
        return {
          ...state,
          activeAssistantMessageId:
            event.role === 'assistant' ? event.messageId : null,
          messages,
          optimisticUserMessageIds: optimisticUserMessageId
            ? state.optimisticUserMessageIds.slice(1)
            : state.optimisticUserMessageIds,
          reconciledUserMessageIds: optimisticMessage
            ? [...state.reconciledUserMessageIds, event.messageId]
            : state.reconciledUserMessageIds,
        };
      }
      if (event.type === 'TEXT_MESSAGE_CONTENT') {
        const messageId = event.messageId;
        const delta = event.delta;
        const messageRole = state.messages.find(
          (message) => message.id === messageId,
        )?.role;
        if (
          messageRole === 'user'
          && state.reconciledUserMessageIds.includes(messageId)
        ) {
          return state;
        }
        const assistantContent = messageRole !== 'user';
        return {
          ...state,
          runPhase: assistantContent
            ? 'streaming'
            : state.runPhase,
          activeAssistantMessageId: assistantContent
            ? messageId
            : state.activeAssistantMessageId,
          messages: updateMessage(state.messages, messageId, (message) => appendText(message, delta)),
        };
      }
      if (event.type === 'TEXT_MESSAGE_END') {
        const messageRole = state.messages.find(
          (message) => message.id === event.messageId,
        )?.role;
        if (messageRole === 'user') {
          return state.reconciledUserMessageIds.includes(event.messageId)
            ? {
                ...state,
                reconciledUserMessageIds:
                  state.reconciledUserMessageIds.filter(
                    (messageId) => messageId !== event.messageId,
                  ),
              }
            : state;
        }
        return state.isRunning ? { ...state, runPhase: 'thinking' } : state;
      }
      if (event.type === 'TOOL_CALL_START') {
        const messageId = state.activeAssistantMessageId ?? assistantIdFor(event);
        const name = event.toolCallName;
        return {
          ...state,
          runPhase: 'tool',
          activeAssistantMessageId: messageId,
          messages: updateMessage(state.messages, messageId, (message) =>
            updateToolPart(message, event.toolCallId, (part) => ({
              ...part,
              name,
              status: 'running',
            })),
          ),
        };
      }
      if (event.type === 'TOOL_CALL_ARGS') {
        const messageId = state.activeAssistantMessageId ?? assistantIdFor(event);
        const delta = event.delta;
        return {
          ...state,
          activeAssistantMessageId: messageId,
          messages: updateMessage(state.messages, messageId, (message) =>
            updateToolPart(message, event.toolCallId, (part) => ({
              ...part,
              args: `${part.args}${delta}`,
            })),
          ),
        };
      }
      if (event.type === 'TOOL_CALL_END') {
        return {
          ...state,
          runPhase: state.isRunning ? 'tool' : state.runPhase,
        };
      }
      if (event.type === 'TOOL_CALL_RESULT') {
        const messageId = state.activeAssistantMessageId ?? assistantIdFor(event);
        const result = typeof event.result === 'string'
          ? event.result
          : JSON.stringify(event.result ?? '');
        // Durable message revisions are authoritative. A later raw AG-UI
        // frame may carry a bounded preview of the same tool outcome.
        const hasCanonicalOutcome =
          state.messageRevisions.has(messageId);
        return {
          ...state,
          runPhase: state.isRunning ? 'thinking' : state.runPhase,
          activeAssistantMessageId: messageId,
          messages: updateMessage(state.messages, messageId, (message) =>
            updateToolPart(message, event.toolCallId, (part) =>
              hasCanonicalOutcome && part.result !== undefined
                ? part
                : {
                    ...part,
                    result,
                    status: event.error || part.status === 'error'
                      ? 'error'
                      : 'complete',
                  }),
          ),
        };
      }
      if (event.type === 'CUSTOM') {
        if (event.name === 'ctxmill.turn.pending') {
          // Persisted during run preparation and replayed to fresh
          // subscribers: the turn is queued and the sandbox is spinning up.
          return state.runPhase === 'submitted' || state.runPhase === 'idle'
            ? { ...state, isRunning: true, runPhase: 'provisioning' }
            : state;
        }
        if (isMessageCommittedEvent(event)) {
          const existing = state.messages.find((message) => message.id === event.messageId);
          const currentRevision = state.messageRevisions.get(event.messageId)
            ?? (existing ? 0 : -1);
          if (currentRevision >= 0) return state;

          const message = canonicalMessageFromEvent(event, existing);
          if (!message) return state;
          const canonicalAssistant = message.role === 'assistant';
          return {
            ...state,
            activeAssistantMessageId: canonicalAssistant
              ? message.id
              : state.activeAssistantMessageId,
            messages: upsertCanonicalMessage(
              state.messages,
              message,
              canonicalAssistant ? state.activeAssistantMessageId : null,
              canonicalToolCallIds(event),
            ),
            messageRevisions: new Map(state.messageRevisions).set(message.id, 0),
          };
        }
        if (isMessageUpdatedEvent(event)) {
          const existing = state.messages.find((message) => message.id === event.messageId);
          const currentRevision = state.messageRevisions.get(event.messageId)
            ?? (existing ? 0 : -1);
          if (event.messageRevision <= currentRevision) return state;

          const message = canonicalMessageFromEvent(event, existing);
          if (!message) return state;
          return {
            ...state,
            activeAssistantMessageId: message.id,
            messages: upsertCanonicalMessage(
              state.messages,
              message,
              state.activeAssistantMessageId,
              canonicalToolCallIds(event),
            ),
            messageRevisions: new Map(state.messageRevisions)
              .set(message.id, event.messageRevision),
          };
        }
        const interruptRequest = getInterruptRequest(event);
        if (interruptRequest) {
          return { ...state, pendingHitl: interruptRequest };
        }
        if (event.name === 'ctxmill.interrupt.resolved' && 'interruptId' in event) {
          return event.interruptId === state.pendingHitl?.interruptId
            ? { ...state, pendingHitl: null }
            : state;
        }
        const block = getA2UIBlock(event);
        if (block) {
          const messageId = state.activeAssistantMessageId ?? assistantIdFor(event);
          return {
            ...state,
            activeAssistantMessageId: messageId,
            messages: updateMessage(state.messages, messageId, (message) => appendA2UIBlock(message, block)),
          };
        }
        return state;
      }
      if (event.type === 'RUN_ERROR') {
        return {
          ...state,
          isRunning: false,
          runPhase: 'idle',
          error: event.message ?? 'Run failed',
        };
      }
      if (event.type === 'RUN_FINISHED') {
        return {
          ...state,
          isRunning: false,
          runPhase: 'idle',
          activeAssistantMessageId: null,
        };
      }
      return state;
    }
  }
}
