import { create } from 'zustand';
import type { ApiToolCallState, ApiA2UIBlock } from '@ctxmill/shared';

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

interface ConversationStore {
  messages: Message[];
  currentRunId: string | null;
  isStreaming: boolean;
  streamingContent: string;
  streamingRole: 'user' | 'assistant';
  toolCalls: Map<string, ToolCallState>;
  a2uiBlocks: A2UIBlock[];

  addUserMessage: (content: string) => void;
  handleSSEEvent: (event: Record<string, unknown>) => void;
  loadMessages: (msgs: Message[]) => void;
  reset: () => void;
}

let messageCounter = 0;
function nextId() {
  messageCounter += 1;
  return `msg-${Date.now()}-${messageCounter}`;
}

export const useConversationStore = create<ConversationStore>((set, get) => ({
  messages: [],
  currentRunId: null,
  isStreaming: false,
  streamingContent: '',
  streamingRole: 'assistant',
  toolCalls: new Map(),
  a2uiBlocks: [],

  addUserMessage: (content: string) => {
    const msg: Message = {
      id: nextId(),
      role: 'user',
      content,
      createdAt: new Date().toISOString(),
    };
    set((state) => ({ messages: [...state.messages, msg] }));
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

    switch (type) {
      case 'RUN_STARTED': {
        set({
          isStreaming: true,
          currentRunId: (event.runId as string) || null,
          streamingContent: '',
          toolCalls: new Map(),
          a2uiBlocks: [],
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
        set((state) => ({
          streamingContent: state.streamingContent + delta,
        }));
        break;
      }

      case 'TEXT_MESSAGE_END': {
        const state = get();
        // Skip user message echoes — they were already added via addUserMessage()
        if (state.streamingRole === 'user') {
          set({ streamingContent: '', streamingRole: 'assistant' });
          break;
        }
        const toolCallsArr = Array.from(state.toolCalls.values());
        const msg: Message = {
          id: nextId(),
          role: 'assistant',
          content: state.streamingContent,
          toolCalls: toolCallsArr.length > 0 ? toolCallsArr : undefined,
          a2uiBlocks: state.a2uiBlocks.length > 0 ? [...state.a2uiBlocks] : undefined,
          createdAt: new Date().toISOString(),
        };
        set((prev) => ({
          messages: [...prev.messages, msg],
          streamingContent: '',
          streamingRole: 'assistant',
          toolCalls: new Map(),
          a2uiBlocks: [],
        }));
        break;
      }

      case 'TOOL_CALL_START': {
        const tc: ToolCallState = {
          id: (event.toolCallId as string) || nextId(),
          name: (event.name as string) || (event.toolName as string) || 'unknown',
          args: '',
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
          const block: A2UIBlock = {
            id: (event.id as string) || nextId(),
            component: (payload.component as string) || (event.component as string) || '',
            props: (payload.props as Record<string, unknown>) || (event.props as Record<string, unknown>) || {},
          };
          if (block.component) {
            set((state) => ({ a2uiBlocks: [...state.a2uiBlocks, block] }));
          }
        }
        // interrupt events are handled by the interrupt store
        break;
      }

      case 'RUN_FINISHED': {
        // Finalize any remaining streaming content
        const state = get();
        if (state.streamingContent) {
          const msg: Message = {
            id: nextId(),
            role: 'assistant',
            content: state.streamingContent,
            createdAt: new Date().toISOString(),
          };
          set((prev) => ({
            messages: [...prev.messages, msg],
            streamingContent: '',
          }));
        }
        set({ isStreaming: false, currentRunId: null });
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
      isStreaming: false,
      streamingContent: '',
      streamingRole: 'assistant',
      toolCalls: new Map(),
      a2uiBlocks: [],
    }),
}));
