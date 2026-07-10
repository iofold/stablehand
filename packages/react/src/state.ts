import {
  createCtxmillId,
  getA2UIBlock,
  getHitlRequest,
  type CtxmillA2UIBlock,
  type CtxmillHitlRequest,
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
  createdAt: string;
}

export interface CtxmillChatState {
  threadId: string;
  messages: CtxmillChatMessage[];
  isRunning: boolean;
  error: string | null;
  pendingHitl: CtxmillHitlRequest | null;
  activeAssistantMessageId: string | null;
}

export type CtxmillChatAction =
  | { type: 'load_messages'; messages: CtxmillMessage[]; threadId?: string }
  | { type: 'append_user_message'; message: CtxmillMessage }
  | { type: 'stream_event'; event: CtxmillStreamEvent }
  | { type: 'hitl_resolved'; interruptId?: string }
  | { type: 'set_error'; error: string | null }
  | { type: 'reset'; threadId: string };

function nowIso(): string {
  return new Date().toISOString();
}

export function createInitialChatState(threadId?: string): CtxmillChatState {
  return {
    threadId: threadId ?? createCtxmillId('thread'),
    messages: [],
    isRunning: false,
    error: null,
    pendingHitl: null,
    activeAssistantMessageId: null,
  };
}

export function toCtxmillMessages(messages: CtxmillChatMessage[]): CtxmillMessage[] {
  return messages
    .filter((message) => message.role === 'user' || message.role === 'assistant' || message.role === 'system' || message.role === 'tool')
    .map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
    }));
}

function normalizeMessage(message: CtxmillMessage): CtxmillChatMessage {
  const content = message.content ?? '';
  return {
    id: message.id,
    role: message.role === 'developer' ? 'system' : message.role,
    content,
    parts: content ? [{ type: 'text', content }] : [],
    createdAt: nowIso(),
  };
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
      role: 'assistant',
      content: '',
      parts: [],
      createdAt: nowIso(),
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
    case 'load_messages':
      return {
        ...state,
        threadId: action.threadId ?? state.threadId,
        messages: action.messages.map(normalizeMessage),
      };

    case 'append_user_message':
      return {
        ...state,
        error: null,
        messages: [...state.messages, normalizeMessage(action.message)],
      };

    case 'hitl_resolved':
      return {
        ...state,
        pendingHitl: action.interruptId && state.pendingHitl?.id !== action.interruptId ? state.pendingHitl : null,
      };

    case 'set_error':
      return {
        ...state,
        isRunning: false,
        error: action.error,
      };

    case 'reset':
      return createInitialChatState(action.threadId);

    case 'stream_event': {
      const { event } = action;
      if (event.type === 'MESSAGES_SNAPSHOT') {
        return {
          ...state,
          threadId: event.threadId,
          messages: event.messages.map(normalizeMessage),
        };
      }
      if (event.type === 'RUN_STARTED') {
        return { ...state, isRunning: true, error: null };
      }
      if (event.type === 'TEXT_MESSAGE_START') {
        return {
          ...state,
          activeAssistantMessageId: event.messageId,
          messages: updateMessage(state.messages, event.messageId, (message) => message),
        };
      }
      if (event.type === 'TEXT_MESSAGE_CONTENT') {
        const messageId = event.messageId || state.activeAssistantMessageId || assistantIdFor(event);
        const delta = event.delta ?? event.content ?? '';
        return {
          ...state,
          activeAssistantMessageId: messageId,
          messages: updateMessage(state.messages, messageId, (message) => appendText(message, delta)),
        };
      }
      if (event.type === 'TOOL_CALL_START') {
        const messageId = state.activeAssistantMessageId ?? assistantIdFor(event);
        const name = event.toolCallName ?? event.toolName ?? 'tool';
        return {
          ...state,
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
        const delta = event.delta ?? (typeof event.args === 'string' ? event.args : JSON.stringify(event.args ?? ''));
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
        const messageId = state.activeAssistantMessageId ?? assistantIdFor(event);
        const result = typeof event.result === 'string' ? event.result : JSON.stringify(event.result ?? '');
        return {
          ...state,
          activeAssistantMessageId: messageId,
          messages: updateMessage(state.messages, messageId, (message) =>
            updateToolPart(message, event.toolCallId, (part) => ({
              ...part,
              result,
              status: 'complete',
            })),
          ),
        };
      }
      if (event.type === 'CUSTOM') {
        const hitlRequest = getHitlRequest(event);
        if (hitlRequest) {
          return { ...state, pendingHitl: hitlRequest };
        }
        if (event.name === 'ctxmill.hitl.resolved' || event.subtype === 'hitl_resolved') {
          return { ...state, pendingHitl: null };
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
          error: event.message ?? 'Run failed',
        };
      }
      if (event.type === 'RUN_FINISHED') {
        return {
          ...state,
          isRunning: false,
          activeAssistantMessageId: null,
        };
      }
      return state;
    }
  }
}
