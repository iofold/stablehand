import { useEffect, useRef, useState, useCallback } from 'react';
import {
  Sparkles,
  Zap,
  FileSearch,
  Code2,
  BarChart3,
  ArrowDown,
} from 'lucide-react';
import { MessageBubble } from './MessageBubble';
import { ToolCallCard } from './ToolCallCard';
import { A2UIBlock } from '@/components/a2ui/A2UIBlock';
import { cn } from '@/lib/utils';
import type { Message, ToolCallState, A2UIBlock as A2UIBlockType } from '@/stores/conversation';

export interface ChatThreadProps {
  messages: Message[];
  streamingContent: string;
  isStreaming: boolean;
  toolCalls?: Map<string, ToolCallState>;
  a2uiBlocks?: A2UIBlockType[];
  agentName?: string;
  agentTools?: string[];
  agentId?: string;
  conversationId?: string;
}

const SUGGESTED_PROMPTS = [
  { icon: FileSearch, label: 'Analyze data', prompt: 'Analyze the data and surface key insights' },
  { icon: Code2, label: 'Generate code', prompt: 'Help me write a function that' },
  { icon: BarChart3, label: 'Create a report', prompt: 'Generate a summary report of' },
  { icon: Zap, label: 'Automate a task', prompt: 'Automate the process of' },
];

export function ChatThread({
  messages,
  streamingContent,
  isStreaming,
  toolCalls = new Map(),
  a2uiBlocks = [],
  agentName,
  agentTools = [],
  agentId,
  conversationId,
}: ChatThreadProps) {
  const endRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setAutoScroll(atBottom);
  }, []);

  useEffect(() => {
    if (autoScroll) {
      endRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, streamingContent, autoScroll, toolCalls.size, a2uiBlocks.length]);

  const scrollToBottom = useCallback(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
    setAutoScroll(true);
  }, []);

  /* ── Empty state ── */
  if (messages.length === 0 && !isStreaming) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8 overflow-y-auto">
        {/* Hero */}
        <div className="flex flex-col items-center gap-5 max-w-lg text-center mb-10">
          <div className="relative">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-surface-800 ring-1 ring-accent-500/20 ">
              <Sparkles className="h-7 w-7 text-accent-400" />
            </div>
            <div className="absolute -inset-3 rounded-3xl bg-accent-500/5 blur-xl -z-10" />
          </div>
          <div>
            <h2 className="text-xl font-semibold text-surface-100 tracking-tight">
              {agentName ? `${agentName} is ready` : 'Agent ready'}
            </h2>
            <p className="mt-1.5 text-sm text-surface-400 leading-relaxed max-w-sm mx-auto">
              Describe what you need. This agent can reason, call tools, and produce structured outputs.
            </p>
          </div>

          {/* Tool chips */}
          {agentTools.length > 0 && (
            <div className="flex flex-wrap justify-center gap-1.5 mt-1">
              {agentTools.slice(0, 8).map((tool) => (
                <span
                  key={tool}
                  className="inline-flex items-center gap-1 rounded-md bg-surface-800/80 border border-surface-700/40 px-2 py-0.5 text-[11px] font-mono text-surface-400"
                >
                  <Zap className="h-2.5 w-2.5 text-surface-500" />
                  {tool}
                </span>
              ))}
              {agentTools.length > 8 && (
                <span className="inline-flex items-center rounded-md bg-surface-800/80 border border-surface-700/40 px-2 py-0.5 text-[11px] text-surface-500">
                  +{agentTools.length - 8} more
                </span>
              )}
            </div>
          )}
        </div>

        {/* Suggested prompts */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 w-full max-w-lg">
          {SUGGESTED_PROMPTS.map(({ icon: Icon, label, prompt }) => (
            <button
              key={label}
              type="button"
              className="group flex items-center gap-3 rounded-lg border border-surface-700/40 bg-surface-800/40 px-4 py-3 text-left transition-all hover:bg-surface-800/80 hover:border-surface-600/60"
            >
              <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-surface-700/50 group-hover:bg-accent-600/15 transition-colors">
                <Icon className="h-4 w-4 text-surface-400 group-hover:text-accent-400 transition-colors" />
              </div>
              <div className="min-w-0">
                <div className="text-sm font-medium text-surface-200 group-hover:text-surface-100 transition-colors">
                  {label}
                </div>
                <div className="text-xs text-surface-500 truncate">{prompt}</div>
              </div>
            </button>
          ))}
        </div>
      </div>
    );
  }

  /* ── Message list ── */
  const activeToolCalls = Array.from(toolCalls.values()) as ToolCallState[];

  return (
    <div className="relative flex-1 overflow-hidden">
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="h-full overflow-y-auto px-4 py-6"
      >
        <div className="mx-auto max-w-3xl space-y-1">
          {messages.map((msg) => (
            <div key={msg.id} className="space-y-1">
              <MessageBubble message={msg} agentId={agentId} conversationId={conversationId} />
              {msg.toolCalls?.map((tc) => (
                <ToolCallCard key={tc.id} toolCall={tc} />
              ))}
              {msg.a2uiBlocks?.map((block) => (
                <A2UIBlock key={block.id} block={block} />
              ))}
            </div>
          ))}

          {/* Active tool calls during streaming */}
          {activeToolCalls.map((tc) => (
            <ToolCallCard key={tc.id} toolCall={tc} />
          ))}

          {/* Active A2UI blocks during streaming */}
          {a2uiBlocks.map((block) => (
            <A2UIBlock key={block.id} block={block} />
          ))}

          {/* Streaming message */}
          {isStreaming && streamingContent && (
            <MessageBubble
              message={{
                id: 'streaming',
                role: 'assistant',
                content: streamingContent,
                createdAt: new Date().toISOString(),
              }}
              isStreaming
            />
          )}

          {/* Typing indicator when streaming but no content yet */}
          {isStreaming && !streamingContent && activeToolCalls.length === 0 && (
            <div className="flex items-start gap-3 py-3 animate-fade-in">
              <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-surface-800 ring-1 ring-surface-700/50">
                <Sparkles className="h-3.5 w-3.5 text-accent-400" />
              </div>
              <div className="flex items-center gap-1 pt-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-surface-400 animate-[pulse_1.4s_ease-in-out_infinite]" />
                <span className="h-1.5 w-1.5 rounded-full bg-surface-400 animate-[pulse_1.4s_ease-in-out_0.2s_infinite]" />
                <span className="h-1.5 w-1.5 rounded-full bg-surface-400 animate-[pulse_1.4s_ease-in-out_0.4s_infinite]" />
              </div>
            </div>
          )}

          <div ref={endRef} />
        </div>
      </div>

      {/* Scroll to bottom button */}
      {!autoScroll && (
        <button
          type="button"
          onClick={scrollToBottom}
          className={cn(
            'absolute bottom-4 left-1/2 -translate-x-1/2 z-10',
            'flex items-center gap-1.5 rounded-full bg-surface-800/90 border border-surface-700/60 px-3 py-1.5',
            'text-xs text-surface-300  ',
            'hover:bg-surface-700 transition-all animate-fade-in',
          )}
        >
          <ArrowDown className="h-3 w-3" />
          New messages
        </button>
      )}
    </div>
  );
}
