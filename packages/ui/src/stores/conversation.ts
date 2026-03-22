import { create } from 'zustand';
import type { ApiToolCallState, ApiA2UIBlock } from '@ctxmill/shared';
import {
  extractEmbeddedA2UIBlocks,
  normalizeA2UIBlock,
  normalizeStoredA2UIBlocks,
} from '@/lib/a2ui';

export type ToolCallState = ApiToolCallState;
export type A2UIBlock = ApiA2UIBlock;

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCalls?: ToolCallState[];
  a2uiBlocks?: A2UIBlock[];
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
  const content = (value.content as string) || '';
  const role = ((value.role as string) || 'assistant') as Message['role'];
  const a2uiBlocks = normalizeStoredA2UIBlocks(value.a2uiBlocks, `${id}-a2ui`)
    ?? normalizeStoredA2UIBlocks(value.a2uiPayload, `${id}-a2ui`)
    ?? (role === 'assistant' ? extractEmbeddedA2UIBlocks(content, `${id}-embedded`) : undefined);

  return {
    id,
    role,
    content,
    toolCalls: normalizeStoredToolCalls(value.toolCalls, id),
    a2uiBlocks,
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
  a2uiBlocks: A2UIBlock[];
  seenEventIds: Set<string>;

  addUserMessage: (content: string) => void;
  handleSSEEvent: (event: Record<string, unknown>) => void;
  loadMessages: (msgs: Message[]) => void;
  setActiveConversation: (conversationId: string | null) => void;
  reset: () => void;
}

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
  if (flushCallback) {
    flushCallback();
  }
}

function buildAssistantMessage(state: Pick<ConversationStore, 'streamingContent' | 'toolCalls' | 'a2uiBlocks'>): Message | undefined {
  const toolCalls = Array.from(state.toolCalls.values());
  if (!state.streamingContent && toolCalls.length === 0 && state.a2uiBlocks.length === 0) {
    return undefined;
  }

  return {
    id: nextId(),
    role: 'assistant',
    content: state.streamingContent,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    a2uiBlocks: state.a2uiBlocks.length > 0 ? [...state.a2uiBlocks] : undefined,
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
  a2uiBlocks: [],
  seenEventIds: new Set(),

  addUserMessage: (content: string) => {
    const msg: Message = {
      id: nextId(),
      role: 'user',
      content,
      createdAt: new Date().toISOString(),
    };
    set((state) => ({ messages: [...state.messages, msg] }));
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
      a2uiBlocks: [],
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
        set({
          isStreaming: true,
          currentRunId: (event.runId as string) || null,
          streamingContent: '',
          toolCalls: new Map(),
          a2uiBlocks: [],
          seenEventIds: new Set(),
        });
        break;
      }

      case 'TEXT_MESSAGE_START': {
        const role = ((event.role as string) || 'assistant') as 'user' | 'assistant';
        set({ streamingContent: '', streamingRole: role });
        break;
      }

      case 'TEXT_MESSAGE_CONTENT': {
        // Skip user echoes
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
          a2uiBlocks: [],
        }));
        break;
      }

      case 'TOOL_CALL_START': {
        // Populate args from the start event if present (some harnesses send args
        // here instead of via separate TOOL_CALL_ARGS streaming events).
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
        set((state) => {
          const next = new Map(state.toolCalls);
          next.set(tc.id, tc);
          return { toolCalls: next };
        });
        break;
      }

      case 'TOOL_CALL_ARGS': {
        const tcId = event.toolCallId as string;
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
        const tcId = event.toolCallId as string;
        const result = (event.result as string) || '';
        const error = event.error as string | undefined;
        set((state) => {
          const next = new Map(state.toolCalls);
          const existing = next.get(tcId);
          if (existing) {
            next.set(tcId, {
              ...existing,
              result,
              error,
              status: error ? 'error' : 'complete',
            });
          }
          return { toolCalls: next };
        });
        break;
      }

      case 'CUSTOM': {
        const subtype = event.subtype as string;
        if (subtype === 'a2ui') {
          // Backend sends payload as nested object: { payload: { component, props } }
          const payload = (event.payload as Record<string, unknown>) || event;
          const block = normalizeA2UIBlock(payload, (event.id as string) || nextId());
          if (block) {
            set((state) => ({ a2uiBlocks: [...state.a2uiBlocks, block] }));
          }
        }
        // interrupt events are handled by the interrupt store
        break;
      }

      case 'RUN_FINISHED': {
        // Flush any pending delta before finalizing the message
        flushPendingDelta(set);
        const state = get();
        const msg = buildAssistantMessage(state);
        if (msg) {
          set((prev) => ({
            messages: [...prev.messages, msg],
            streamingContent: '',
            streamingRole: 'assistant',
            toolCalls: new Map(),
            a2uiBlocks: [],
          }));
        }
        set({
          isStreaming: false,
          currentRunId: null,
          streamingContent: '',
          streamingRole: 'assistant',
          toolCalls: new Map(),
          a2uiBlocks: [],
          seenEventIds: new Set(),
        });
        break;
      }

      case 'RUN_ERROR': {
        const errorMsg = (event.message as string) || (event.error as string) || 'Unknown error';
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

  reset: () =>
    set({
      messages: [],
      currentRunId: null,
      activeConversationId: null,
      isStreaming: false,
      streamingContent: '',
      streamingRole: 'assistant',
      toolCalls: new Map(),
      a2uiBlocks: [],
      seenEventIds: new Set(),
    }),
}));
