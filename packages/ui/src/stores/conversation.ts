import { create } from 'zustand';
import type { ApiMessage, ApiMessagePart, ApiToolCallState } from '@stablehand/shared';
import { TurnStopReasonSchema, type TurnStopReason } from '@stablehand/contracts';
import { useInterruptStore } from './interrupt';
import { isMissingToolName, MISSING_TOOL_NAME } from '@/lib/tool-display';

export type ToolCallState = ApiToolCallState;
export type MessagePart = ApiMessagePart;
export type Message = ApiMessage;

// ctx-iqzy T1: the wire is epoch-ms only; tolerate a legacy ISO string by
// converting rather than passing it through.
function normalizeCreatedAt(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function stringifyToolArgs(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeToolCallStatus(value: unknown, error: string | undefined): ToolCallState['status'] {
  if (value === 'pending' || value === 'running' || value === 'complete' || value === 'error') {
    return value;
  }
  if (value === 'completed' || value === 'done' || value === 'success' || value === 'succeeded') {
    return 'complete';
  }
  return error ? 'error' : 'complete';
}

function normalizeStoredToolCalls(value: unknown, messageId: string): ToolCallState[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;

  const toolCalls = value.flatMap((entry, index) => {
    if (!entry || typeof entry !== 'object') return [];

    const raw = entry as Record<string, unknown>;
    const error = typeof raw.error === 'string'
      ? raw.error
      : typeof raw.lastError === 'string'
        ? raw.lastError
        : undefined;

    const toolCall: ToolCallState = {
      id: (typeof raw.id === 'string' && raw.id.length > 0) ? raw.id : `${messageId}-tool-${index}`,
      name: (typeof raw.name === 'string' && raw.name.length > 0)
        ? raw.name
        : MISSING_TOOL_NAME,
      args: stringifyToolArgs(raw.args ?? raw.argumentsJson ?? raw.arguments ?? raw.input),
      result: typeof raw.result === 'string'
        ? raw.result
        : typeof raw.output === 'string'
          ? raw.output
          : undefined,
      error,
      status: normalizeToolCallStatus(raw.status, error),
      ...(typeof raw.durationMs === 'number' ? { durationMs: raw.durationMs } : {}),
    };

    return [toolCall];
  });

  return toolCalls.length > 0 ? toolCalls : undefined;
}

export function normalizeConversationMessage(
  value: Record<string, unknown>,
  fallbackId: string,
): Message {
  const id = (value.id as string) || fallbackId;
  const rawContent = (value.content as string) || '';
  const role = ((value.role as string) || 'assistant') as Message['role'];

  const content = rawContent;
  const toolCalls = normalizeStoredToolCalls(value.toolCalls, id);
  const parts: MessagePart[] = [];
  if (role === 'tool' && typeof value.toolCallId === 'string') {
    parts.push({ type: 'tool_call', id: value.toolCallId, name: 'tool result', args: '', result: content, status: 'complete' });
  } else {
    if (Array.isArray(value.parts) && value.parts.length > 0) {
      for (const p of value.parts) {
        const raw = p as Record<string, unknown>;
        if (raw.type === 'text') {
          parts.push({ type: 'text', content: (raw.content as string) || '' });
        } else if (raw.type === 'tool_call') {
          parts.push({
            type: 'tool_call',
            id: (raw.id as string) || '',
            name: (raw.name as string) || MISSING_TOOL_NAME,
            args: (raw.args as string) || '',
            result: raw.result as string | undefined,
            error: raw.error as string | undefined,
            status: normalizeToolCallStatus(raw.status, raw.error as string | undefined),
            ...(typeof raw.durationMs === 'number' ? { durationMs: raw.durationMs } : {}),
            ...(typeof raw.parentToolCallId === 'string' ? { parentToolCallId: raw.parentToolCallId } : {}),
            ...(typeof raw.agentName === 'string' ? { agentName: raw.agentName } : {}),
          });
        }
      }
    } else {
      if (content) parts.push({ type: 'text', content });
      if (toolCalls) {
        for (const tc of toolCalls) {
          parts.push({ type: 'tool_call', ...tc });
        }
      }
    }
  }

  return {
    id,
    ...(typeof value.turnId === 'string' ? { turnId: value.turnId } : {}),
    ...(typeof value.messageSeq === 'number' ? { messageSeq: value.messageSeq } : {}),
    messageRevision: typeof value.messageRevision === 'number'
      ? value.messageRevision
      : 0,
    role,
    content,
    parts: parts.length > 0 ? parts : undefined,
    toolCallId: typeof value.toolCallId === 'string' ? value.toolCallId : undefined,
    toolCalls,
    createdAt: normalizeCreatedAt(value.createdAt),
  };
}

interface ConversationStore {
  messages: Message[];
  currentTurnId: string | null;
  activeConversationId: string | null;
  isStreaming: boolean;
  /**
   * The agent's final reply for the current turn is committed and nothing
   * new has streamed since; the turn itself has not closed (no RUN_FINISHED).
   */
  responseComplete: boolean;
  /** Epoch ms of the last event for the open turn (second resolution). */
  lastTurnEventAt: number | null;
  committedMessageCount: number;
  streamingContent: string;
  streamingRole: 'user' | 'assistant';
  toolCalls: Map<string, ToolCallState>;
  messageRevisions: Map<string, number>;
  seenEventIds: Set<string>;
  optimisticUserMessageIds: string[];
  reconciledUserMessageIds: Set<string>;
  /**
   * Typed stops seen live on RUN_ERROR frames (e.g. a run stopped at its
   * spend cap), keyed by turn id, until the turns API reflects them.
   */
  turnStopReasons: Map<string, TurnStopReason>;

  addUserMessage: (content: string) => string;
  discardOptimisticUserMessage: (messageId: string) => void;
  handleSSEEvent: (event: Record<string, unknown>) => void;
  loadMessages: (msgs: Message[]) => void;
  setActiveConversation: (conversationId: string | null) => void;
  reset: () => void;
  /** Local log line; with a turnId it stays inside that turn's section. */
  addSystemMessage: (content: string, turnId?: string) => void;
}

interface PreviewController {
  pendingDelta: string;
  flushFrameId: number | null;
  flushGeneration: number;
}

let messageCounter = 0;
function nextId() {
  messageCounter += 1;
  return `msg-${Date.now()}-${messageCounter}`;
}

function createPreviewController(): PreviewController {
  return {
    pendingDelta: '',
    flushFrameId: null,
    flushGeneration: 0,
  };
}

function resolveEventTurnId(event: Record<string, unknown>): string | undefined {
  const turnId = event.turnId;
  if (typeof turnId === 'string' && turnId.length > 0) return turnId;

  const runId = event.runId;
  if (typeof runId === 'string' && runId.length > 0) return runId;

  return undefined;
}

function isTurnScopedEvent(type: string): boolean {
  return type === 'TEXT_MESSAGE_START' ||
    type === 'TEXT_MESSAGE_CONTENT' ||
    type === 'TEXT_MESSAGE_END' ||
    type === 'TOOL_CALL_START' ||
    type === 'TOOL_CALL_ARGS' ||
    type === 'TOOL_CALL_END' ||
    type === 'TOOL_CALL_RESULT' ||
    type === 'STABLEHAND_MESSAGE_COMMITTED' ||
    type === 'STABLEHAND_MESSAGE_UPDATED' ||
    type === 'RUN_FINISHED' ||
    type === 'RUN_ERROR';
}

function normalizeEventToolCall(
  value: Record<string, unknown>,
  fallbackId: string,
): ToolCallState {
  const error = typeof value.error === 'string' ? value.error : undefined;

  return {
    id: (typeof value.id === 'string' && value.id.length > 0) ? value.id : fallbackId,
    name: (typeof value.name === 'string' && value.name.length > 0) ? value.name : MISSING_TOOL_NAME,
    args: typeof value.args === 'string' ? value.args : '',
    result: typeof value.result === 'string' ? value.result : undefined,
    error,
    status: normalizeToolCallStatus(value.status, error),
    ...(typeof value.durationMs === 'number' ? { durationMs: value.durationMs } : {}),
  };
}

function mergeCommittedToolCall(
  canonical: ToolCallState,
  preview: ToolCallState | undefined,
): ToolCallState {
  if (!preview) return canonical;

  const hasCanonicalOutcome = canonical.result !== undefined
    || canonical.error !== undefined;
  const status = hasCanonicalOutcome
    ? canonical.status
    : preview.error
      ? 'error'
      : preview.result !== undefined
        ? preview.status
        : preview.status === 'complete' || preview.status === 'error'
          ? preview.status
          : canonical.status;

  return {
    id: canonical.id,
    // A transcript row written without a name must not hide the name the
    // live stream already showed.
    name: isMissingToolName(canonical.name) && !isMissingToolName(preview.name)
      ? preview.name
      : canonical.name,
    args: preview.args || canonical.args,
    result: hasCanonicalOutcome ? canonical.result : preview.result,
    error: hasCanonicalOutcome ? canonical.error : preview.error,
    status,
    ...(canonical.durationMs ?? preview.durationMs
      ? { durationMs: canonical.durationMs ?? preview.durationMs }
      : {}),
  };
}

function mergeToolResultIntoCommittedMessages(
  messages: Message[],
  toolCallId: string,
  result: string,
  error: string | undefined,
): Message[] | undefined {
  let changed = false;

  const nextMessages = messages.map((message) => {
    let messageChanged = false;
    const canonicalOutcome = message.parts?.find(
      (part): part is Extract<MessagePart, { type: 'tool_call' }> =>
        part.type === 'tool_call'
        && part.id === toolCallId
        && (part.result !== undefined || part.error !== undefined),
    ) ?? message.toolCalls?.find(
      (toolCall) => toolCall.id === toolCallId
        && (toolCall.result !== undefined || toolCall.error !== undefined),
    );
    const resolvedResult = canonicalOutcome ? canonicalOutcome.result : result;
    const resolvedError = canonicalOutcome ? canonicalOutcome.error : error;
    const resolvedStatus: ToolCallState['status'] = canonicalOutcome
      ? canonicalOutcome.status
      : error
        ? 'error'
        : 'complete';

    const toolCalls = message.toolCalls?.map((toolCall) => {
      if (toolCall.id !== toolCallId) return toolCall;
      messageChanged = true;
      return {
        ...toolCall,
        result: resolvedResult,
        error: resolvedError,
        status: resolvedStatus,
      };
    });

    const parts = message.parts?.map((part) => {
      if (part.type !== 'tool_call' || part.id !== toolCallId) return part;
      messageChanged = true;
      return {
        ...part,
        result: resolvedResult,
        error: resolvedError,
        status: resolvedStatus,
      };
    });

    if (!messageChanged) return message;
    changed = true;
    return {
      ...message,
      ...(toolCalls ? { toolCalls } : {}),
      ...(parts ? { parts } : {}),
    };
  });

  return changed ? nextMessages : undefined;
}

function normalizeAuthoritativeMessageUpdate(
  event: Record<string, unknown>,
  existing: Message | undefined,
): { message: Message; toolCallIds: Set<string> } {
  const rawParts = Array.isArray(event.parts) ? event.parts as Array<Record<string, unknown>> : [];
  const rawToolCalls = Array.isArray(event.toolCalls) ? event.toolCalls as Array<Record<string, unknown>> : [];
  const parts: MessagePart[] = [];
  const partToolCalls = new Map<string, ToolCallState>();
  const toolCallIds = new Set<string>();

  for (const part of rawParts) {
    if (part.type === 'text') {
      parts.push({ type: 'text', content: (part.content as string) || '' });
      continue;
    }
    if (part.type !== 'tool_call') continue;

    const toolCall = normalizeEventToolCall(part, `updated-part-${parts.length}`);
    parts.push({ type: 'tool_call', ...toolCall });
    partToolCalls.set(toolCall.id, toolCall);
    toolCallIds.add(toolCall.id);
  }

  const toolCalls = rawToolCalls.map((rawToolCall, index) => {
    const canonical = normalizeEventToolCall(rawToolCall, `updated-tool-${index}`);
    const fromPart = partToolCalls.get(canonical.id);
    const toolCall = fromPart
      ? mergeCommittedToolCall(canonical, fromPart)
      : canonical;
    toolCallIds.add(toolCall.id);
    return toolCall;
  });

  return {
    message: {
      id: event.messageId as string,
      ...(typeof event.conversationId === 'string'
        ? { conversationId: event.conversationId }
        : existing?.conversationId
          ? { conversationId: existing.conversationId }
          : {}),
      ...(typeof event.agentId === 'string'
        ? { agentId: event.agentId }
        : existing?.agentId
          ? { agentId: existing.agentId }
          : {}),
      ...(typeof event.turnId === 'string'
        ? { turnId: event.turnId }
        : existing?.turnId
          ? { turnId: existing.turnId }
          : {}),
      ...(typeof event.messageSeq === 'number'
        ? { messageSeq: event.messageSeq }
        : existing?.messageSeq !== undefined
          ? { messageSeq: existing.messageSeq }
          : {}),
      messageRevision: event.messageRevision as number,
      role: 'assistant',
      content: (event.content as string) || '',
      parts: parts.length > 0 ? parts : undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      ...(typeof event.toolCallId === 'string'
        ? { toolCallId: event.toolCallId }
        : existing?.toolCallId
          ? { toolCallId: existing.toolCallId }
          : {}),
      createdAt: existing?.createdAt ?? Date.now(),
    },
    toolCallIds,
  };
}

function upsertMessageById(messages: Message[], message: Message): {
  messages: Message[];
  inserted: boolean;
} {
  const messageIndex = messages.findIndex((candidate) => candidate.id === message.id);
  if (messageIndex === -1) {
    return { messages: [...messages, message], inserted: true };
  }
  return {
    messages: messages.map((candidate, index) => index === messageIndex ? message : candidate),
    inserted: false,
  };
}

function appendTextToMessage(message: Message, delta: string): Message {
  const parts = [...(message.parts ?? [])];
  const lastPart = parts.at(-1);
  if (lastPart?.type === 'text') {
    parts[parts.length - 1] = {
      type: 'text',
      content: lastPart.content + delta,
    };
  } else if (delta.length > 0) {
    parts.push({ type: 'text', content: delta });
  }
  return {
    ...message,
    content: message.content + delta,
    parts: parts.length > 0 ? parts : undefined,
  };
}

export const useConversationStore = create<ConversationStore>((set, get) => {
  const previewController = createPreviewController();

  const invalidateScheduledFlush = (): void => {
    previewController.flushGeneration += 1;
    if (previewController.flushFrameId !== null) {
      cancelAnimationFrame(previewController.flushFrameId);
      previewController.flushFrameId = null;
    }
  };

  const discardPendingPreview = (): void => {
    invalidateScheduledFlush();
    previewController.pendingDelta = '';
  };

  const resetPreviewController = (): void => {
    discardPendingPreview();
  };

  const flushPendingDelta = (): void => {
    const delta = previewController.pendingDelta;
    invalidateScheduledFlush();
    previewController.pendingDelta = '';
    if (delta.length === 0) return;
    set((state) => ({
      streamingContent: state.streamingContent + delta,
    }));
  };

  const scheduleDeltaFlush = (): void => {
    if (previewController.flushFrameId !== null) return;

    const flushGeneration = previewController.flushGeneration;
    const frameId = requestAnimationFrame(() => {
      if (previewController.flushFrameId !== frameId) return;
      previewController.flushFrameId = null;
      if (flushGeneration !== previewController.flushGeneration) return;

      const delta = previewController.pendingDelta;
      previewController.pendingDelta = '';
      if (delta.length === 0) return;

      set((state) => ({
        streamingContent: state.streamingContent + delta,
      }));
    });

    previewController.flushFrameId = frameId;
  };

  return ({
  messages: [],
  currentTurnId: null,
  activeConversationId: null,
  isStreaming: false,
  responseComplete: false,
  lastTurnEventAt: null,
  committedMessageCount: 0,
  streamingContent: '',
  streamingRole: 'assistant',
  toolCalls: new Map(),
  messageRevisions: new Map(),
  seenEventIds: new Set(),
  optimisticUserMessageIds: [],
  reconciledUserMessageIds: new Set(),
  turnStopReasons: new Map(),

  addUserMessage: (content: string) => {
    const msg: Message = {
      id: nextId(),
      messageRevision: 0,
      role: 'user',
      content,
      parts: [{ type: 'text', content }],
      createdAt: Date.now(),
    };
    set((state) => ({
      messages: [...state.messages, msg],
      optimisticUserMessageIds: [
        ...state.optimisticUserMessageIds,
        msg.id,
      ],
    }));
    return msg.id;
  },

  discardOptimisticUserMessage: (messageId: string) => {
    set((state) => {
      if (!state.optimisticUserMessageIds.includes(messageId)) {
        return state;
      }
      return {
        messages: state.messages.filter(
          (message) => message.id !== messageId,
        ),
        optimisticUserMessageIds:
          state.optimisticUserMessageIds.filter(
            (optimisticMessageId) =>
              optimisticMessageId !== messageId,
          ),
      };
    });
  },

  addSystemMessage: (content: string, turnId?: string) => {
    const msg: Message = {
      id: nextId(),
      ...(turnId ? { turnId } : {}),
      messageRevision: 0,
      role: 'system',
      content,
      parts: [{ type: 'text', content }],
      createdAt: Date.now(),
    };
    set((prev) => ({ messages: [...prev.messages, msg] }));
  },

  setActiveConversation: (conversationId: string | null) => {
    set({ activeConversationId: conversationId });
  },

  loadMessages: (msgs: Message[]) => {
    const {
      isStreaming,
      committedMessageCount,
      streamingContent,
      streamingRole,
      toolCalls,
      messageRevisions,
    } = get();
    const normalizedMessages = msgs.map((msg, index) => (
      normalizeConversationMessage(msg as unknown as Record<string, unknown>, msg.id || `loaded-${index}`)
    ));
    if (!isStreaming) {
      discardPendingPreview();
    }
    const nextMessageRevisions = isStreaming
      ? new Map(messageRevisions)
      : new Map<string, number>();
    for (const message of normalizedMessages) {
      const durableRevision = message.messageRevision ?? 0;
      if ((nextMessageRevisions.get(message.id) ?? -1) < durableRevision) {
        nextMessageRevisions.set(message.id, durableRevision);
      }
    }
    set({
      messages: normalizedMessages,
      // Preserve streaming state if a run is active — don't clobber
      isStreaming,
      responseComplete: isStreaming ? get().responseComplete : false,
      committedMessageCount: isStreaming ? committedMessageCount : 0,
      streamingContent: isStreaming ? streamingContent : '',
      streamingRole: isStreaming ? streamingRole : 'assistant',
      toolCalls: isStreaming ? toolCalls : new Map(),
      messageRevisions: nextMessageRevisions,
      optimisticUserMessageIds: [],
      reconciledUserMessageIds: new Set(),
    });
  },

  handleSSEEvent: (event: Record<string, unknown>) => {
    let type = event.type as string;
    // Canonical wire (ADR-015): orchestrator signals arrive as
    // CUSTOM{name:'stablehand.*'}; route them onto the existing handlers.
    if (type === 'CUSTOM' && typeof event.name === 'string') {
      switch (event.name) {
        case 'stablehand.turn.pending': type = 'STABLEHAND_TURN_PENDING'; break;
        case 'stablehand.interrupt.requested': type = 'STABLEHAND_INTERRUPT_REQUESTED'; break;
        case 'stablehand.message.committed': type = 'STABLEHAND_MESSAGE_COMMITTED'; break;
        case 'stablehand.message.updated': type = 'STABLEHAND_MESSAGE_UPDATED'; break;
        default: break; // stablehand.interrupt.resolved handled in the CUSTOM case
      }
    }
    const eventId = event._eventId as string | undefined;
    if (eventId) {
      const { seenEventIds } = get();
      if (seenEventIds.has(eventId)) return;
      seenEventIds.add(eventId);
    }

    const eventConvId = event.conversationId as string | undefined;
    const state = get();
    const { activeConversationId, currentTurnId, isStreaming } = state;
    if (activeConversationId && eventConvId && eventConvId !== activeConversationId) {
      return;
    }

    if (isTurnScopedEvent(type)) {
      const eventMessageId = typeof event.messageId === 'string'
        ? event.messageId
        : null;
      const isUserMessageFrame =
        (type === 'TEXT_MESSAGE_START' && event.role === 'user')
        || (
          (type === 'TEXT_MESSAGE_CONTENT' || type === 'TEXT_MESSAGE_END')
          && eventMessageId !== null
          && state.messages.some(
            (message) =>
              message.id === eventMessageId && message.role === 'user',
          )
        );
      if (!isStreaming && !currentTurnId && !isUserMessageFrame) {
        return;
      }

      const eventTurnId = resolveEventTurnId(event);
      if (currentTurnId && eventTurnId && eventTurnId !== currentTurnId) {
        return;
      }
    }

    // Coarse "last heard from the turn" clock for the idle hint; at most one
    // store write per second so token deltas don't double the render rate.
    const now = Date.now();
    const lastTurnEventAt = get().lastTurnEventAt;
    if (lastTurnEventAt === null || now - lastTurnEventAt >= 1000) {
      set({ lastTurnEventAt: now });
    }

    // Any new output or pause means the agent is not done with its reply.
    if (
      get().responseComplete
      && (
        type === 'TOOL_CALL_START'
        || type === 'STABLEHAND_INTERRUPT_REQUESTED'
        || ((type === 'TEXT_MESSAGE_START' || type === 'TEXT_MESSAGE_CONTENT')
          && get().streamingRole !== 'user'
          && event.role !== 'user')
      )
    ) {
      set({ responseComplete: false });
    }

    switch (type) {
      case 'STABLEHAND_TURN_PENDING': {
        resetPreviewController();
        set({
          isStreaming: true,
          responseComplete: false,
          currentTurnId: (event.turnId as string) || null,
          committedMessageCount: 0,
          streamingContent: '',
          toolCalls: new Map(),
          seenEventIds: new Set(),
        });
        break;
      }

      case 'RUN_STARTED': {
        const nextTurnId = (event.runId as string) || null;
        if (currentTurnId && nextTurnId && currentTurnId !== nextTurnId) {
          resetPreviewController();
        }
        set({
          isStreaming: true,
          responseComplete: false,
          currentTurnId: nextTurnId,
          streamingContent: get().streamingContent || '',
          toolCalls: get().toolCalls.size > 0 ? get().toolCalls : new Map(),
        });
        break;
      }

      case 'TEXT_MESSAGE_START': {
        const role = ((event.role as string) || 'assistant') as 'user' | 'assistant';
        if (role === 'user') {
          set((state) => {
            const messageId = typeof event.messageId === 'string'
              && event.messageId.length > 0
              ? event.messageId
              : nextId();
            const optimisticMessageId =
              state.optimisticUserMessageIds[0];
            const optimisticMessage = optimisticMessageId
              ? state.messages.find(
                  (message) => message.id === optimisticMessageId,
                )
              : undefined;
            const canonicalMessage: Message = {
              id: messageId,
              messageRevision: 0,
              role: 'user',
              content: '',
              createdAt: normalizeCreatedAt(event.timestamp),
            };
            const messages = optimisticMessage
              ? state.messages.map((message) =>
                  message.id === optimisticMessageId
                    ? { ...message, id: messageId }
                    : message)
              : upsertMessageById(
                  state.messages,
                  canonicalMessage,
                ).messages;
            const reconciledUserMessageIds =
              new Set(state.reconciledUserMessageIds);
            if (optimisticMessage) {
              reconciledUserMessageIds.add(messageId);
            }
            return {
              messages,
              optimisticUserMessageIds: optimisticMessageId
                ? state.optimisticUserMessageIds.slice(1)
                : state.optimisticUserMessageIds,
              reconciledUserMessageIds,
              streamingContent: '',
              streamingRole: role,
            };
          });
          break;
        }
        set({ streamingContent: '', streamingRole: role });
        break;
      }

      case 'TEXT_MESSAGE_CONTENT': {
        if (get().streamingRole === 'user') {
          const messageId = event.messageId as string;
          if (
            !messageId
            || get().reconciledUserMessageIds.has(messageId)
          ) {
            break;
          }
          const delta = (event.delta as string) || '';
          set((state) => ({
            messages: state.messages.map((message) =>
              message.id === messageId
                ? appendTextToMessage(message, delta)
                : message),
          }));
          break;
        }
        const delta = (event.delta as string) || '';
        previewController.pendingDelta += delta;
        scheduleDeltaFlush();
        break;
      }

      case 'TEXT_MESSAGE_END': {
        // Flush any pending delta before finalizing the message
        flushPendingDelta();
        const state = get();
        if (state.streamingRole === 'user') {
          const messageId = event.messageId as string;
          const reconciledUserMessageIds =
            new Set(state.reconciledUserMessageIds);
          reconciledUserMessageIds.delete(messageId);
          set({
            streamingContent: '',
            streamingRole: 'assistant',
            reconciledUserMessageIds,
          });
        }
        break;
      }

      case 'TOOL_CALL_START': {
        flushPendingDelta();
        const tc: ToolCallState = {
          id: (event.toolCallId as string) || nextId(),
          // AG-UI carries the name as toolCallName; older frames used toolName.
          name: (event.toolCallName as string) || (event.toolName as string) || MISSING_TOOL_NAME,
          args: '',
          status: 'running',
          ...(typeof event.parentToolCallId === 'string'
            ? { parentToolCallId: event.parentToolCallId }
            : {}),
          ...(typeof event.agentName === 'string'
            ? { agentName: event.agentName }
            : {}),
        };
        set((state) => {
          const next = new Map(state.toolCalls);
          next.set(tc.id, tc);
          return { toolCalls: next };
        });
        break;
      }

      case 'TOOL_CALL_ARGS': {
        const tcId = event.toolCallId as string;
        const delta = (event.delta as string) || '';
        set((state) => {
          const next = new Map(state.toolCalls);
          const existing = next.get(tcId);
          if (existing) {
            next.set(tcId, { ...existing, args: existing.args + delta });
          }
          return { toolCalls: next };
        });
        break;
      }

      case 'TOOL_CALL_END': {
        const tcId = event.toolCallId as string;
        set((state) => {
          const next = new Map(state.toolCalls);
          const existing = next.get(tcId);
          if (existing) {
            next.set(tcId, { ...existing, status: 'complete' });
          }
          return { toolCalls: next };
        });
        break;
      }

      case 'TOOL_CALL_RESULT': {
        let tcId = (event.toolCallId as string) || '';
        if (!tcId) {
          const running = Array.from(get().toolCalls.entries()).find(([_, tc]) => tc.status === 'running');
          if (running) tcId = running[0];
        }
        if (!tcId) break;
        const result = stringifyToolArgs(event.result);
        const error = event.error as string | undefined;

        const state = get();
        const completedTc = state.toolCalls.get(tcId);
        if (!completedTc) {
          const messages = mergeToolResultIntoCommittedMessages(state.messages, tcId, result, error);
          if (messages) set({ messages });
          break;
        }

        const finalTc: ToolCallState = {
          ...completedTc,
          result,
          error,
          status: error ? 'error' : 'complete',
          ...(typeof event.durationMs === 'number' ? { durationMs: event.durationMs } : {}),
        };

        set((prev) => {
          const next = new Map(prev.toolCalls);
          next.set(tcId, finalTc);
          return { toolCalls: next };
        });
        break;
      }

      case 'CUSTOM': {
        if (event.name === 'stablehand.sandbox_session.snapshot') {
          const convId = event.conversationId as string;
          const activeConv = get().activeConversationId;
          const activeTurnId = typeof event.activeTurnId === 'string' ? event.activeTurnId : '';
          if (convId && convId === activeConv) {
            set({
              isStreaming: activeTurnId.length > 0,
              currentTurnId: activeTurnId || get().currentTurnId,
            });
          }
          break;
        }
        if (event.name === 'stablehand.interrupt.resolved') {
          // Approve/reject show on the tool call itself (its result records the
          // decision); a timeout has no such record, so log it.
          const action = (event.action as string) || 'resolved';
          const label = action === 'timeout' ? 'Approval request timed out' : null;
          const resolvedTurnId = typeof event.turnId === 'string' && event.turnId.length > 0
            ? event.turnId
            : undefined;
          // The approver's own tab already logged the decision locally.
          const alreadyLogged = label !== null && get().messages.slice(-20).some((message) =>
            message.role === 'system'
            && message.content.startsWith(label)
            && (resolvedTurnId === undefined || message.turnId === undefined || message.turnId === resolvedTurnId));
          if (label && !alreadyLogged) {
            const msg: Message = {
              id: nextId(),
              ...(resolvedTurnId ? { turnId: resolvedTurnId } : {}),
              messageRevision: 0,
              role: 'system',
              content: label,
              parts: [{ type: 'text', content: label }],
              createdAt: Date.now(),
            };
            set((prev) => ({ messages: [...prev.messages, msg] }));
          }
          useInterruptStore.getState().clear();
        }
        // interrupt events are handled by the interrupt store
        break;
      }

      case 'STABLEHAND_INTERRUPT_REQUESTED': {
        const turnId = (event.turnId as string) || '';
        const interruptId = (event.interruptId as string) || '';
        if (!turnId || !interruptId) break;
        useInterruptStore.getState().setPending({
          interruptId,
          turnId,
          agentId: (event.agentId as string) || '',
          toolName: (event.toolName as string) || '',
          args: (event.args as Record<string, unknown>) || {},
          toolCallId: (event.toolCallId as string) || '',
          ...((event.sandboxSessionId as string) ? { sandboxSessionId: event.sandboxSessionId as string } : {}),
        });
        break;
      }

      case 'STABLEHAND_MESSAGE_COMMITTED': {
        if (typeof event.messageId !== 'string' || event.messageId.length === 0) break;
        const committedState = get();
        const existingCommittedMessage = committedState.messages
          .some((message) => message.id === event.messageId);
        const committedRevision = committedState.messageRevisions.get(event.messageId)
          ?? (existingCommittedMessage ? 0 : -1);
        if (committedRevision >= 0) break;
        flushPendingDelta();
        const state = get();
        const role = ((event.role as string) || 'assistant') as Message['role'];
        const content = (event.content as string) || '';
        const rawParts = Array.isArray(event.parts) ? event.parts as Array<Record<string, unknown>> : [];
        const rawToolCalls = Array.isArray(event.toolCalls) ? event.toolCalls as Array<Record<string, unknown>> : [];

        const mergedToolCalls = rawToolCalls.map((rawToolCall, index) => {
          const canonical = normalizeEventToolCall(rawToolCall, `committed-tool-${index}`);
          return mergeCommittedToolCall(canonical, state.toolCalls.get(canonical.id));
        });
        const mergedToolCallIds = new Set(mergedToolCalls.map((toolCall) => toolCall.id));

        const parts: MessagePart[] = [];
        if (rawParts.length > 0) {
          for (const part of rawParts) {
            if (part.type === 'text') {
              parts.push({ type: 'text', content: (part.content as string) || '' });
              continue;
            }

            if (part.type !== 'tool_call') continue;
            const canonical = normalizeEventToolCall(part, `committed-part-${parts.length}`);
            const merged = mergeCommittedToolCall(canonical, state.toolCalls.get(canonical.id));
            mergedToolCallIds.add(merged.id);
            parts.push({ type: 'tool_call', ...merged });
          }

          for (const toolCall of mergedToolCalls) {
            const alreadyIncluded = parts.some((part) => part.type === 'tool_call' && part.id === toolCall.id);
            if (!alreadyIncluded) {
              parts.push({ type: 'tool_call', ...toolCall });
            }
          }
        } else {
          if (content) parts.push({ type: 'text', content });
          for (const toolCall of mergedToolCalls) {
            parts.push({ type: 'tool_call', ...toolCall });
          }
        }

        const msg: Message = {
          id: event.messageId,
          ...(typeof event.conversationId === 'string' ? { conversationId: event.conversationId } : {}),
          ...(typeof event.agentId === 'string' ? { agentId: event.agentId } : {}),
          ...(typeof event.turnId === 'string' ? { turnId: event.turnId } : {}),
          ...(typeof event.messageSeq === 'number' ? { messageSeq: event.messageSeq } : {}),
          messageRevision: 0,
          role,
          content,
          parts: parts.length > 0 ? parts : undefined,
          toolCalls: mergedToolCalls.length > 0 ? mergedToolCalls : undefined,
          ...(typeof event.toolCallId === 'string' ? { toolCallId: event.toolCallId } : {}),
          createdAt: normalizeCreatedAt(event.timestamp),
        };

        set((prev) => {
          const nextToolCalls = new Map(prev.toolCalls);
          for (const toolCallId of mergedToolCallIds) {
            nextToolCalls.delete(toolCallId);
          }

          const upserted = upsertMessageById(prev.messages, msg);
          const toolStillRunning = Array.from(nextToolCalls.values()).some(
            (toolCall) => toolCall.status === 'running' || toolCall.status === 'pending',
          );
          // Harnesses commit a text-only assistant message once their output
          // for the turn is done; tool-carrying commits happen mid-turn.
          const isFinalReply = role === 'assistant'
            && content.trim().length > 0
            && mergedToolCalls.length === 0
            && !parts.some((part) => part.type === 'tool_call')
            && !toolStillRunning;
          return {
            messages: upserted.messages,
            responseComplete: prev.isStreaming && isFinalReply,
            committedMessageCount: prev.committedMessageCount + (upserted.inserted ? 1 : 0),
            streamingContent: '',
            streamingRole: 'assistant',
            toolCalls: nextToolCalls,
            messageRevisions: new Map(prev.messageRevisions).set(msg.id, 0),
          };
        });
        break;
      }

      case 'STABLEHAND_MESSAGE_UPDATED': {
        if (typeof event.messageId !== 'string' || event.messageId.length === 0) break;
        if (
          typeof event.messageRevision !== 'number'
          || !Number.isInteger(event.messageRevision)
          || event.messageRevision <= 0
        ) break;
        const currentRevision = get().messageRevisions.get(event.messageId) ?? -1;
        if (event.messageRevision <= currentRevision) break;
        flushPendingDelta();
        const existing = get().messages.find((message) => message.id === event.messageId);
        const { message, toolCallIds } = normalizeAuthoritativeMessageUpdate(event, existing);

        set((prev) => {
          const { messages } = upsertMessageById(prev.messages, message);
          const nextToolCalls = new Map(prev.toolCalls);
          for (const toolCallId of toolCallIds) {
            nextToolCalls.delete(toolCallId);
          }

          return {
            messages,
            streamingContent: '',
            streamingRole: 'assistant',
            toolCalls: nextToolCalls,
            messageRevisions: new Map(prev.messageRevisions)
              .set(message.id, event.messageRevision as number),
          };
        });
        break;
      }

      case 'RUN_FINISHED': {
        useInterruptStore.getState().clear();
        flushPendingDelta();
        // Transcript recovery is owned by the backend via stablehand.message.committed.
        // The UI only clears preview state here; it does not synthesize final messages.
        set({
          isStreaming: false,
          responseComplete: false,
          currentTurnId: null,
          committedMessageCount: 0,
          streamingContent: '',
          streamingRole: 'assistant',
          toolCalls: new Map(),
          seenEventIds: new Set(),
          optimisticUserMessageIds: [],
          reconciledUserMessageIds: new Set(),
        });
        resetPreviewController();
        break;
      }

      case 'RUN_ERROR': {
        const errorMsg = (event.message as string) || 'Unknown error';
        useInterruptStore.getState().clear();
        resetPreviewController();
        const parsedStop = TurnStopReasonSchema.safeParse(event.stopReason);
        const stopTurnId = parsedStop.success ? resolveEventTurnId(event) : undefined;
        const msg: Message = {
          id: typeof event.messageId === 'string' && event.messageId.length > 0 ? event.messageId : nextId(),
          messageRevision: 0,
          role: 'system',
          content: `Error: ${errorMsg}`,
          parts: [{ type: 'text', content: `Error: ${errorMsg}` }],
          // A typed stop belongs to its turn, so the thread can show its
          // receipt there instead of a generic error.
          ...(stopTurnId ? { turnId: stopTurnId } : {}),
          createdAt: Date.now(),
        };
        set((prev) => ({
          ...(parsedStop.success && stopTurnId
            ? { turnStopReasons: new Map(prev.turnStopReasons).set(stopTurnId, parsedStop.data) }
            : {}),
          messages: [...prev.messages, msg],
          isStreaming: false,
          responseComplete: false,
          currentTurnId: null,
          committedMessageCount: 0,
          streamingContent: '',
          optimisticUserMessageIds: [],
          reconciledUserMessageIds: new Set(),
        }));
        break;
      }

      case 'STATE_DELTA': {
        // State deltas can be used to update agent state in the agents store
        // For now, we store them as system messages if they have meaningful content
        break;
      }

      default:
        break;
    }
  },

  reset: () => {
    resetPreviewController();
    set({
      messages: [],
      currentTurnId: null,
      activeConversationId: null,
      isStreaming: false,
      responseComplete: false,
      lastTurnEventAt: null,
      committedMessageCount: 0,
      streamingContent: '',
      streamingRole: 'assistant',
      toolCalls: new Map(),
      messageRevisions: new Map(),
      seenEventIds: new Set(),
      optimisticUserMessageIds: [],
      reconciledUserMessageIds: new Set(),
      turnStopReasons: new Map(),
    });
  },
  });
});
