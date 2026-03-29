import { create } from 'zustand';
import type { ApiToolCallState } from '@ctxmill/shared';
import { useInterruptStore } from './interrupt';

export type ToolCallState = ApiToolCallState;

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
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

  return {
    id,
    role,
    content,
    toolCallId: typeof value.toolCallId === 'string' ? value.toolCallId : undefined,
    toolCalls: normalizeStoredToolCalls(value.toolCalls, id),
    createdAt: normalizeCreatedAt(value.createdAt),
  };
}

interface ConversationStore {
  messages: Message[];
  currentRunId: string | null;
  activeConversationId: string | null;
  isStreaming: boolean;
  streamingContent: string;
  streamingRole: 'user' | 'assistant';
  toolCalls: Map<string, ToolCallState>;
  seenEventIds: Set<string>;
  _historyLoaded: boolean;

  addUserMessage: (content: string) => void;
  handleSSEEvent: (event: Record<string, unknown>) => void;
  loadMessages: (msgs: Message[]) => void;
  setActiveConversation: (conversationId: string | null) => void;
  reset: () => void;
  addSystemMessage: (content: string) => void;
}

// Track tool calls that received complete args via TOOL_CALL_START.
// When the harness provides full args upfront, subsequent TOOL_CALL_ARGS
// deltas (echoed by the SSE broadcaster) must be skipped to avoid doubling.
const toolCallsWithStartArgs = new Set<string>();

let messageCounter = 0;
function nextId() {
  messageCounter += 1;
  return `msg-${Date.now()}-${messageCounter}`;
}

// Streaming content throttle: batch TEXT_MESSAGE_CONTENT deltas to prevent UI freeze
let pendingDelta = '';
let flushScheduled = false;
let flushCallback: (() => void) | null = null;

function scheduleDeltaFlush(set: (updater: (state: ConversationStore) => Partial<ConversationStore>) => void): void {
  if (flushScheduled) return;
  flushScheduled = true;

  flushCallback = () => {
    if (pendingDelta.length > 0) {
      set((state) => ({
        streamingContent: state.streamingContent + pendingDelta,
      }));
      pendingDelta = '';
    }
    flushScheduled = false;
    flushCallback = null;
  };

  requestAnimationFrame(flushCallback);
}

function flushPendingDelta(set: (updater: (state: ConversationStore) => Partial<ConversationStore>) => void): void {
  if (pendingDelta.length > 0) {
    set((state) => ({
      streamingContent: state.streamingContent + pendingDelta,
    }));
    pendingDelta = '';
  }
  flushScheduled = false;
  flushCallback = null;
}

function buildAssistantMessage(state: Pick<ConversationStore, 'streamingContent' | 'toolCalls'>): Message | undefined {
  const toolCalls = Array.from(state.toolCalls.values());
  if (!state.streamingContent && toolCalls.length === 0) {
    return undefined;
  }

  const msgId = nextId();

  const content = state.streamingContent;

  return {
    id: msgId,
    role: 'assistant',
    content,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    createdAt: new Date().toISOString(),
  };
}

export const useConversationStore = create<ConversationStore>((set, get) => ({
  messages: [],
  currentRunId: null,
  activeConversationId: null,
  isStreaming: false,
  streamingContent: '',
  streamingRole: 'assistant',
  toolCalls: new Map(),
  seenEventIds: new Set(),
  _historyLoaded: false,

  addUserMessage: (content: string) => {
    const msg: Message = {
      id: nextId(),
      role: 'user',
      content,
      createdAt: new Date().toISOString(),
    };
    set((state) => ({ messages: [...state.messages, msg], _historyLoaded: false }));
  },

  addSystemMessage: (content: string) => {
    const msg: Message = {
      id: nextId(),
      role: 'system',
      content,
      createdAt: new Date().toISOString(),
    };
    set((prev) => ({ messages: [...prev.messages, msg] }));
  },

  setActiveConversation: (conversationId: string | null) => {
    set({ activeConversationId: conversationId });
  },

  loadMessages: (msgs: Message[]) => {
    set({
      messages: msgs,
      isStreaming: false,
      streamingContent: '',
      streamingRole: 'assistant',
      toolCalls: new Map(),
      _historyLoaded: msgs.length > 0,
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
    const { activeConversationId } = get();
    if (activeConversationId && eventConvId && eventConvId !== activeConversationId) {
      return;
    }

    switch (type) {
      case 'RUN_STARTED': {
        const { _historyLoaded } = get();
        if (_historyLoaded) {
          break;
        }
        set({
          isStreaming: true,
          currentRunId: (event.runId as string) || null,
          streamingContent: '',
          toolCalls: new Map(),
          seenEventIds: new Set(),
        });
        break;
      }

      case 'TEXT_MESSAGE_START': {
        const pendingTCs = Array.from(get().toolCalls.values());
        if (pendingTCs.length > 0) {
          const tcMsg: Message = {
            id: nextId(),
            role: 'assistant',
            content: '',
            toolCalls: pendingTCs,
            createdAt: new Date().toISOString(),
          };
          set((prev) => ({
            messages: [...prev.messages, tcMsg],
            toolCalls: new Map(),
          }));
        }
        const role = ((event.role as string) || 'assistant') as 'user' | 'assistant';
        set({ streamingContent: '', streamingRole: role });
        break;
      }

      case 'TEXT_MESSAGE_CONTENT': {
        if (get()._historyLoaded) break;
        if (get().streamingRole === 'user') break;
        const delta = (event.content as string) || (event.delta as string) || '';
        pendingDelta += delta;
        scheduleDeltaFlush(set);
        break;
      }

      case 'TEXT_MESSAGE_END': {
        // Flush any pending delta before finalizing the message
        flushPendingDelta(set);
        const state = get();
        // Skip user message echoes — they were already added via addUserMessage()
        if (state.streamingRole === 'user') {
          set({ streamingContent: '', streamingRole: 'assistant' });
          break;
        }
        const msg = buildAssistantMessage(state);
        set((prev) => ({
          messages: msg ? [...prev.messages, msg] : prev.messages,
          streamingContent: '',
          streamingRole: 'assistant',
          toolCalls: new Map(),
        }));
        break;
      }

      case 'TOOL_CALL_START': {
        flushPendingDelta(set);
        const pendingText = get().streamingContent;
        if (pendingText) {
          const textMsg: Message = {
            id: nextId(),
            role: 'assistant',
            content: pendingText,
            createdAt: new Date().toISOString(),
          };
          set((prev) => ({
            messages: [...prev.messages, textMsg],
            streamingContent: '',
          }));
        }
        const startArgs = event.args;
        const argsStr = startArgs
          ? (typeof startArgs === 'string' ? startArgs : JSON.stringify(startArgs))
          : '';
        const tc: ToolCallState = {
          id: (event.toolCallId as string) || nextId(),
          name: (event.name as string) || (event.toolName as string) || 'unknown',
          args: argsStr,
          status: 'running',
        };
        if (argsStr) toolCallsWithStartArgs.add(tc.id);
        set((state) => {
          const next = new Map(state.toolCalls);
          next.set(tc.id, tc);
          return { toolCalls: next };
        });
        break;
      }

      case 'TOOL_CALL_ARGS': {
        const tcId = event.toolCallId as string;
        if (toolCallsWithStartArgs.has(tcId)) break;
        const delta = (event.args as string) || (event.delta as string) || '';
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
        toolCallsWithStartArgs.delete(tcId);
        const result = (event.result as string) || '';
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

        const pendingText = state.streamingContent;
        set((prev) => ({
          messages: [...prev.messages, {
            id: nextId(),
            role: 'assistant' as const,
            content: pendingText,
            toolCalls: [finalTc],
            createdAt: new Date().toISOString(),
          }],
          toolCalls: (() => {
            const next = new Map(prev.toolCalls);
            next.delete(tcId);
            return next;
          })(),
          streamingContent: '',
        }));
        break;
      }

      case 'CUSTOM': {
        const subtype = event.subtype as string;
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
              createdAt: new Date().toISOString(),
            };
            set((prev) => ({ messages: [...prev.messages, msg] }));
          }
          useInterruptStore.getState().clear();
        }
        // interrupt events are handled by the interrupt store
        break;
      }

      case 'RUN_FINISHED': {
        useInterruptStore.getState().clear();
        const { _historyLoaded: histLoaded } = get();
        if (histLoaded) {
          set({ isStreaming: false, currentRunId: null });
          break;
        }
        flushPendingDelta(set);
        const state = get();
        const msg = buildAssistantMessage(state);
        if (msg) {
          set((prev) => ({
            messages: [...prev.messages, msg],
            streamingContent: '',
            streamingRole: 'assistant',
            toolCalls: new Map(),
          }));
        }
        set({
          isStreaming: false,
          currentRunId: null,
          streamingContent: '',
          streamingRole: 'assistant',
          toolCalls: new Map(),
          seenEventIds: new Set(),
        });
        break;
      }

      case 'RUN_ERROR': {
        const errorMsg = (event.message as string) || (event.error as string) || 'Unknown error';
        useInterruptStore.getState().clear();
        const msg: Message = {
          id: nextId(),
          role: 'system',
          content: `Error: ${errorMsg}`,
          createdAt: new Date().toISOString(),
        };
        set((prev) => ({
          messages: [...prev.messages, msg],
          isStreaming: false,
          currentRunId: null,
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
    pendingDelta = '';
    flushScheduled = false;
    flushCallback = null;
    toolCallsWithStartArgs.clear();
    set({
      messages: [],
      currentRunId: null,
      activeConversationId: null,
      isStreaming: false,
      streamingContent: '',
      streamingRole: 'assistant',
      toolCalls: new Map(),
      seenEventIds: new Set(),
      _historyLoaded: false,
    });
  },
}));
