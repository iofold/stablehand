import { create } from 'zustand';
import type { ApiToolCallState } from '@ctxmill/shared';
import { useInterruptStore } from './interrupt';

export type ToolCallState = ApiToolCallState;

export type MessagePart =
  | { type: 'text'; content: string }
  | { type: 'tool_call'; id: string; name: string; args: string; result?: string; error?: string; status: ToolCallState['status'] };

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  parts?: MessagePart[];
  toolCallId?: string;
  toolCalls?: ToolCallState[];
  createdAt: string;
}

function normalizeCreatedAt(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  return new Date().toISOString();
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
        : (typeof raw.toolName === 'string' && raw.toolName.length > 0)
          ? raw.toolName
          : 'unknown',
      args: stringifyToolArgs(raw.args ?? raw.argumentsJson ?? raw.arguments ?? raw.input),
      result: typeof raw.result === 'string'
        ? raw.result
        : typeof raw.output === 'string'
          ? raw.output
          : undefined,
      error,
      status: normalizeToolCallStatus(raw.status, error),
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
            name: (raw.name as string) || 'unknown',
            args: (raw.args as string) || '',
            result: raw.result as string | undefined,
            error: raw.error as string | undefined,
            status: normalizeToolCallStatus(raw.status, raw.error as string | undefined),
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
  committedMessageCount: number;
  streamingContent: string;
  streamingRole: 'user' | 'assistant';
  toolCalls: Map<string, ToolCallState>;
  seenEventIds: Set<string>;

  addUserMessage: (content: string) => void;
  handleSSEEvent: (event: Record<string, unknown>) => void;
  loadMessages: (msgs: Message[]) => void;
  setActiveConversation: (conversationId: string | null) => void;
  reset: () => void;
  addSystemMessage: (content: string) => void;
}

interface PreviewController {
  pendingDelta: string;
  flushFrameId: number | null;
  flushGeneration: number;
  toolCallsWithStartArgs: Set<string>;
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
    toolCallsWithStartArgs: new Set<string>(),
  };
}

function resolveEventTurnId(event: Record<string, unknown>): string | undefined {
  const turnId = event.turnId;
  if (typeof turnId === 'string' && turnId.length > 0) return turnId;

  const runId = event.runId;
  if (typeof runId === 'string' && runId.length > 0) return runId;

  const sessionId = event.sessionId;
  if (typeof sessionId === 'string' && sessionId.length > 0) return sessionId;

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
    type === 'MESSAGE_COMMITTED' ||
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
    name: (typeof value.name === 'string' && value.name.length > 0) ? value.name : 'unknown',
    args: typeof value.args === 'string' ? value.args : '',
    result: typeof value.result === 'string' ? value.result : undefined,
    error,
    status: normalizeToolCallStatus(value.status, error),
  };
}

function mergeCommittedToolCall(
  canonical: ToolCallState,
  preview: ToolCallState | undefined,
): ToolCallState {
  if (!preview) return canonical;

  const status = preview.error
    ? 'error'
    : preview.result !== undefined
      ? preview.status
      : preview.status === 'complete' || preview.status === 'error'
        ? preview.status
        : canonical.status;

  return {
    id: canonical.id,
    name: canonical.name || preview.name,
    args: preview.args || canonical.args,
    result: preview.result ?? canonical.result,
    error: preview.error ?? canonical.error,
    status,
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
    previewController.toolCallsWithStartArgs.clear();
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
  committedMessageCount: 0,
  streamingContent: '',
  streamingRole: 'assistant',
  toolCalls: new Map(),
  seenEventIds: new Set(),

  addUserMessage: (content: string) => {
    const msg: Message = {
      id: nextId(),
      role: 'user',
      content,
      parts: [{ type: 'text', content }],
      createdAt: new Date().toISOString(),
    };
    set((state) => ({ messages: [...state.messages, msg] }));
  },

  addSystemMessage: (content: string) => {
    const msg: Message = {
      id: nextId(),
      role: 'system',
      content,
      parts: [{ type: 'text', content }],
      createdAt: new Date().toISOString(),
    };
    set((prev) => ({ messages: [...prev.messages, msg] }));
  },

  setActiveConversation: (conversationId: string | null) => {
    set({ activeConversationId: conversationId });
  },

  loadMessages: (msgs: Message[]) => {
    const { isStreaming, committedMessageCount, streamingContent, streamingRole, toolCalls } = get();
    const normalizedMessages = msgs.map((msg, index) => (
      normalizeConversationMessage(msg as unknown as Record<string, unknown>, msg.id || `loaded-${index}`)
    ));
    if (!isStreaming) {
      discardPendingPreview();
      previewController.toolCallsWithStartArgs.clear();
    }
    set({
      messages: normalizedMessages,
      // Preserve streaming state if a run is active — don't clobber
      isStreaming,
      committedMessageCount: isStreaming ? committedMessageCount : 0,
      streamingContent: isStreaming ? streamingContent : '',
      streamingRole: isStreaming ? streamingRole : 'assistant',
      toolCalls: isStreaming ? toolCalls : new Map(),
    });
  },

  handleSSEEvent: (event: Record<string, unknown>) => {
    const type = event.type as string;
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
      if (!isStreaming && !currentTurnId) {
        return;
      }

      const eventTurnId = resolveEventTurnId(event);
      if (currentTurnId && eventTurnId && eventTurnId !== currentTurnId) {
        return;
      }
    }

    switch (type) {
      case 'TURN_PENDING': {
        resetPreviewController();
        set({
          isStreaming: true,
          currentTurnId: (event.runId as string) || null,
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
          currentTurnId: nextTurnId,
          streamingContent: get().streamingContent || '',
          toolCalls: get().toolCalls.size > 0 ? get().toolCalls : new Map(),
        });
        break;
      }

      case 'TEXT_MESSAGE_START': {
        const role = ((event.role as string) || 'assistant') as 'user' | 'assistant';
        set({ streamingContent: '', streamingRole: role });
        break;
      }

      case 'TEXT_MESSAGE_CONTENT': {
        if (get().streamingRole === 'user') break;
        const delta = (event.delta as string) || (event.content as string) || '';
        previewController.pendingDelta += delta;
        scheduleDeltaFlush();
        break;
      }

      case 'TEXT_MESSAGE_END': {
        // Flush any pending delta before finalizing the message
        flushPendingDelta();
        const state = get();
        // Skip user message echoes — they were already added via addUserMessage()
        if (state.streamingRole === 'user') {
          set({ streamingContent: '', streamingRole: 'assistant' });
        }
        break;
      }

      case 'TOOL_CALL_START': {
        flushPendingDelta();
        const startArgs = event.args;
        const argsStr = startArgs
          ? (typeof startArgs === 'string' ? startArgs : JSON.stringify(startArgs))
          : '';
        const tc: ToolCallState = {
          id: (event.toolCallId as string) || nextId(),
          name: (event.toolCallName as string) || (event.name as string) || (event.toolName as string) || 'unknown',
          args: argsStr,
          status: 'running',
        };
        if (argsStr) previewController.toolCallsWithStartArgs.add(tc.id);
        set((state) => {
          const next = new Map(state.toolCalls);
          next.set(tc.id, tc);
          return { toolCalls: next };
        });
        break;
      }

      case 'TOOL_CALL_ARGS': {
        const tcId = event.toolCallId as string;
        if (previewController.toolCallsWithStartArgs.has(tcId)) break;
        const delta = (event.delta as string) || (event.args as string) || '';
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
        previewController.toolCallsWithStartArgs.delete(tcId);
        const result = (event.content as string) || (event.result as string) || '';
        const error = event.error as string | undefined;

        const state = get();
        const completedTc = state.toolCalls.get(tcId);
        if (!completedTc) break;

        const finalTc: ToolCallState = {
          ...completedTc,
          result,
          error,
          status: error ? 'error' : 'complete',
        };

        set((prev) => {
          const next = new Map(prev.toolCalls);
          next.set(tcId, finalTc);
          return { toolCalls: next };
        });
        break;
      }

      case 'CUSTOM': {
        const subtype = (event.subtype as string) || '';
        if (subtype === 'state_snapshot') {
          const convId = event.conversationId as string;
          const activeConv = get().activeConversationId;
          const activeTurnId = typeof event.activeTurnId === 'string'
            ? event.activeTurnId
            : (typeof event.turnId === 'string' ? event.turnId : '');
          if (convId && convId === activeConv) {
            set({
              isStreaming: activeTurnId.length > 0,
              currentTurnId: activeTurnId || get().currentTurnId,
            });
          }
          break;
        }
        if (subtype === 'interrupt_resolved') {
          const action = (event.action as string) || 'resolved';
          const toolName = (event.toolName as string) || '';
          const isApproved = action === 'approve';
          const prefix = isApproved ? '✓ Approved' : '✗ Rejected';
          const label = toolName ? `${prefix}: ${toolName}` : prefix;
          const existing = get().messages;
          const alreadyLogged = existing.length > 0 &&
            existing[existing.length - 1].role === 'system' &&
            existing[existing.length - 1].content.startsWith(prefix);
          if (!alreadyLogged) {
            const msg: Message = {
              id: nextId(),
              role: 'system',
              content: label,
              parts: [{ type: 'text', content: label }],
              createdAt: new Date().toISOString(),
            };
            set((prev) => ({ messages: [...prev.messages, msg] }));
          }
          useInterruptStore.getState().clear();
        }
        // interrupt events are handled by the interrupt store
        break;
      }

      case 'HITL_PAUSE': {
        useInterruptStore.getState().setPending({
          agentId: (event.agentId as string) || '',
          toolName: (event.toolName as string) || '',
          args: (event.args as Record<string, unknown>) || {},
          toolCallId: (event.toolCallId as string) || '',
          sessionId: (event.runId as string) || undefined,
        });
        break;
      }

      case 'MESSAGE_COMMITTED': {
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
          id: typeof event.messageId === 'string' && event.messageId.length > 0 ? event.messageId : nextId(),
          role,
          content,
          parts: parts.length > 0 ? parts : undefined,
          toolCalls: mergedToolCalls.length > 0 ? mergedToolCalls : undefined,
          createdAt: new Date().toISOString(),
        };

        set((prev) => {
          const nextToolCalls = new Map(prev.toolCalls);
          for (const toolCallId of mergedToolCallIds) {
            nextToolCalls.delete(toolCallId);
            previewController.toolCallsWithStartArgs.delete(toolCallId);
          }

          return {
            messages: [...prev.messages, msg],
            committedMessageCount: prev.committedMessageCount + 1,
            streamingContent: '',
            streamingRole: 'assistant',
            toolCalls: nextToolCalls,
          };
        });
        break;
      }

      case 'RUN_FINISHED': {
        useInterruptStore.getState().clear();
        flushPendingDelta();
        const state = get();
        // Transcript recovery is owned by the backend via MESSAGE_COMMITTED.
        // The UI only clears preview state here; it does not synthesize final messages.
        if (state.committedMessageCount > 0) {
          previewController.toolCallsWithStartArgs.clear();
        }
        set({
          isStreaming: false,
          currentTurnId: null,
          committedMessageCount: 0,
          streamingContent: '',
          streamingRole: 'assistant',
          toolCalls: new Map(),
          seenEventIds: new Set(),
        });
        resetPreviewController();
        break;
      }

      case 'RUN_ERROR': {
        const errorMsg = (event.message as string) || (event.error as string) || 'Unknown error';
        useInterruptStore.getState().clear();
        resetPreviewController();
        const msg: Message = {
          id: typeof event.messageId === 'string' && event.messageId.length > 0 ? event.messageId : nextId(),
          role: 'system',
          content: `Error: ${errorMsg}`,
          parts: [{ type: 'text', content: `Error: ${errorMsg}` }],
          createdAt: new Date().toISOString(),
        };
        set((prev) => ({
          messages: [...prev.messages, msg],
          isStreaming: false,
          currentTurnId: null,
          committedMessageCount: 0,
          streamingContent: '',
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
      committedMessageCount: 0,
      streamingContent: '',
      streamingRole: 'assistant',
      toolCalls: new Map(),
      seenEventIds: new Set(),
    });
  },
  });
});
