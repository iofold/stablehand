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
  const parts: MessagePart[] = [];
  if (state.streamingContent) parts.push({ type: 'text', content: state.streamingContent });
  for (const tc of toolCalls) {
    parts.push({ type: 'tool_call', ...tc });
  }

  return {
    id: msgId,
    role: 'assistant',
    content,
    parts: parts.length > 0 ? parts : undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    createdAt: new Date().toISOString(),
  };
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

export const useConversationStore = create<ConversationStore>((set, get) => ({
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
    const { activeConversationId } = get();
    if (activeConversationId && eventConvId && eventConvId !== activeConversationId) {
      return;
    }

    switch (type) {
      case 'TURN_PENDING': {
        toolCallsWithStartArgs.clear();
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
        set({
          isStreaming: true,
          currentTurnId: (event.runId as string) || null,
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
        }
        break;
      }

      case 'TOOL_CALL_START': {
        flushPendingDelta(set);
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
        toolCallsWithStartArgs.delete(tcId);
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
          const status = event.status as string;
          const convId = event.conversationId as string;
          const activeConv = get().activeConversationId;
          if (convId && convId === activeConv) {
            set({
              isStreaming: status === 'ACTIVE' || status === 'RESTORING',
              currentTurnId: (event.sessionId as string) || null,
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

      case 'MESSAGE_COMMITTED': {
        flushPendingDelta(set);
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
          id: nextId(),
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
            toolCallsWithStartArgs.delete(toolCallId);
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
        flushPendingDelta(set);
        const state = get();
        const hasPendingPreview = state.streamingContent.length > 0 || state.toolCalls.size > 0;

        // Fallback only: the canonical path is MESSAGE_COMMITTED. If the run ends
        // with unconsumed preview state, emit one last assistant message so crashes
        // or truncated streams do not drop visible output.
        if (hasPendingPreview) {
          const msg = buildAssistantMessage(state);
          set((prev) => ({
            messages: msg ? [...prev.messages, msg] : prev.messages,
            streamingContent: '',
            streamingRole: 'assistant',
            toolCalls: new Map(),
          }));
        } else if (state.committedMessageCount > 0) {
          toolCallsWithStartArgs.clear();
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
        toolCallsWithStartArgs.clear();
        break;
      }

      case 'RUN_ERROR': {
        const errorMsg = (event.message as string) || (event.error as string) || 'Unknown error';
        useInterruptStore.getState().clear();
        const msg: Message = {
          id: nextId(),
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
    pendingDelta = '';
    flushScheduled = false;
    flushCallback = null;
    toolCallsWithStartArgs.clear();
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
}));
