import { useEffect, useCallback, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Bot,
  Radio,
  Cpu,
  Wrench,
  Circle,
  Wifi,
  WifiOff,
  FolderOpen,
  PanelLeftClose,
} from 'lucide-react';
import { ChatThread } from '@/components/chat/ChatThread';
import { ChatInput } from '@/components/chat/ChatInput';
import { ApprovalCard } from '@/components/hitl/ApprovalCard';
import { EditableDocument } from '@/components/hitl/EditableDocument';
import { FieldRequestForm } from '@/components/hitl/FieldRequestForm';
import { FileExplorer } from '@/components/explorer/FileExplorer';
import { FileViewer } from '@/components/explorer/FileViewer';
import { ConnectionBanner } from '@/components/ui/ConnectionBanner';
import { useConversationStore } from '@/stores/conversation';
import type { Message } from '@/stores/conversation';
import { useInterruptStore } from '@/stores/interrupt';
import { useAgentsStore } from '@/stores/agents';
import { useSSE, useSSEStatus } from '@/lib/useSSE';
import { sendMessage, sendInterrupt, fetchConversations, fetchMessages } from '@/lib/api';
import { cn } from '@/lib/utils';
// ConnectionBanner reads status from the shared SSE store internally

export function ChatPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const agents = useAgentsStore((s) => s.agents);
  const fetchAgents = useAgentsStore((s) => s.fetchAgents);
  const {
    messages,
    isStreaming,
    streamingContent,
    toolCalls,
    a2uiBlocks,
    addUserMessage,
    loadMessages,
    reset,
  } = useConversationStore();
  const interrupt = useInterruptStore((s) => s.pending);
  const clearInterrupt = useInterruptStore((s) => s.clear);
  const sseStatus = useSSEStatus();

  const [explorerOpen, setExplorerOpen] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  useSSE(id);

  useEffect(() => {
    if (agents.length === 0) fetchAgents();
  }, [agents.length, fetchAgents]);

  // Load conversation history on mount
  useEffect(() => {
    if (!id) return;
    let mounted = true;

    async function loadHistory() {
      try {
        const conversations = await fetchConversations(id!);
        if (!mounted || !Array.isArray(conversations) || conversations.length === 0) return;

        // Sort by most recent and pick the latest
        const sorted = [...conversations].sort(
          (a: Record<string, unknown>, b: Record<string, unknown>) =>
            ((b.updatedAt as number) || (b.createdAt as number) || 0) -
            ((a.updatedAt as number) || (a.createdAt as number) || 0),
        );
        const latest = sorted[0];
        const convId = (latest.id as string) || (latest.conversationId as string);
        if (!convId) return;

        const msgs = await fetchMessages(id!, convId);
        if (!mounted || !Array.isArray(msgs) || msgs.length === 0) return;

        const parsed = msgs.map((m: Record<string, unknown>, i: number) => ({
          id: (m.id as string) || `msg-${i}`,
          role: ((m.role as string) || 'assistant') as 'user' | 'assistant' | 'system' | 'tool',
          content: (m.content as string) || '',
          toolCalls: m.toolCalls as Message['toolCalls'],
          a2uiBlocks: m.a2uiBlocks as Message['a2uiBlocks'],
          createdAt: (m.createdAt as string) || new Date().toISOString(),
        }));

        loadMessages(parsed);
      } catch {
        // Silently fail — show empty state
      }
    }

    loadHistory();
    return () => {
      mounted = false;
      reset();
    };
  }, [id, loadMessages, reset]);

  const agent = agents.find((a) => a.id === id);

  const handleSend = useCallback(
    async (content: string) => {
      if (!id) return;
      addUserMessage(content);
      await sendMessage(id, content);
    },
    [id, addUserMessage],
  );

  const handleApprove = useCallback(async () => {
    if (!id) return;
    await sendInterrupt(id, 'approve');
    clearInterrupt();
  }, [id, clearInterrupt]);

  const handleReject = useCallback(async () => {
    if (!id) return;
    await sendInterrupt(id, 'reject');
    clearInterrupt();
  }, [id, clearInterrupt]);

  const handleDocSubmit = useCallback(
    async (content: string) => {
      if (!id) return;
      await sendInterrupt(id, 'submit', { content });
      clearInterrupt();
    },
    [id, clearInterrupt],
  );

  const handleFormSubmit = useCallback(
    async (values: Record<string, string>) => {
      if (!id) return;
      await sendInterrupt(id, 'submit', values);
      clearInterrupt();
    },
    [id, clearInterrupt],
  );

  const handleFileSelect = useCallback((path: string) => {
    setSelectedFile(path);
  }, []);

  const connectionDot = sseStatus === 'connected'
    ? 'bg-emerald-400'
    : sseStatus === 'connecting'
      ? 'bg-amber-400 animate-pulse'
      : 'bg-red-400';

  return (
    <div className="flex h-screen flex-col bg-surface-950">
      {/* Connection banner */}
      <ConnectionBanner />

      {/* Header */}
      <header className="sticky top-0 z-30 border-b border-surface-700/40 bg-surface-900/90 backdrop-blur-md">
        <div className="mx-auto flex h-14 items-center gap-3 px-4 sm:px-6">
          {/* Back */}
          <button
            type="button"
            data-testid="back-button"
            onClick={() => navigate('/')}
            className="rounded-lg p-1.5 text-surface-400 hover:bg-surface-800 hover:text-surface-200 transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>

          {/* Explorer toggle */}
          <button
            type="button"
            data-testid="toggle-explorer"
            onClick={() => setExplorerOpen((prev) => !prev)}
            className={cn(
              'rounded-lg p-1.5 transition-colors',
              explorerOpen
                ? 'bg-brand-600/15 text-brand-400 hover:bg-brand-600/25'
                : 'text-surface-400 hover:bg-surface-800 hover:text-surface-200',
            )}
            title={explorerOpen ? 'Hide file explorer' : 'Show file explorer'}
          >
            {explorerOpen ? (
              <PanelLeftClose className="h-4 w-4" />
            ) : (
              <FolderOpen className="h-4 w-4" />
            )}
          </button>

          {/* Agent identity */}
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="relative flex-shrink-0">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600/20 ring-1 ring-brand-500/30">
                <Bot className="h-4 w-4 text-brand-400" />
              </div>
              <span
                className={cn(
                  'absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-surface-900',
                  connectionDot,
                )}
              />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold text-surface-100 leading-tight">
                {agent?.name ?? 'Agent'}
              </h1>
              {agent && (
                <div className="flex items-center gap-1.5 text-[11px] text-surface-500 leading-tight">
                  <Cpu className="h-3 w-3 flex-shrink-0" />
                  <span className="truncate font-mono">{agent.model}</span>
                </div>
              )}
            </div>
          </div>

          {/* Tools badge */}
          {agent && agent.tools.length > 0 && (
            <div className="ml-auto hidden sm:flex items-center gap-1.5">
              <div className="flex items-center gap-1 rounded-md bg-surface-800 border border-surface-700/50 px-2 py-1">
                <Wrench className="h-3 w-3 text-surface-400" />
                <span className="text-[11px] font-medium text-surface-400">
                  {agent.tools.length} tool{agent.tools.length !== 1 ? 's' : ''}
                </span>
              </div>
            </div>
          )}

          {/* Streaming indicator */}
          {isStreaming && (
            <div
              className={cn(
                'flex items-center gap-1.5 rounded-full bg-brand-600/10 border border-brand-500/20 px-2.5 py-1',
                agent?.tools.length ? '' : 'ml-auto',
              )}
            >
              <Radio className="h-3 w-3 text-brand-400 animate-pulse" />
              <span className="text-[11px] font-medium text-brand-400">Live</span>
            </div>
          )}
        </div>
      </header>

      {/* Main content: sidebar + chat */}
      <div className="flex flex-1 overflow-hidden">
        {/* File Explorer Sidebar */}
        <div
          className={cn(
            'flex-shrink-0 border-r border-surface-700/40 bg-surface-900/60 transition-all duration-300 ease-in-out overflow-hidden',
            explorerOpen ? 'w-[280px]' : 'w-0',
          )}
        >
          {explorerOpen && id && (
            <div className="flex h-full w-[280px] flex-col">
              {/* Explorer tree */}
              <div className={cn('flex-1 overflow-hidden', selectedFile ? 'h-1/2' : 'h-full')}>
                <FileExplorer
                  agentId={id}
                  onFileSelect={handleFileSelect}
                  selectedFile={selectedFile}
                />
              </div>

              {/* File viewer (bottom half of sidebar) */}
              {selectedFile && (
                <div className="h-1/2 border-t border-surface-700/40">
                  <FileViewer
                    agentId={id}
                    filePath={selectedFile}
                    onClose={() => setSelectedFile(null)}
                  />
                </div>
              )}
            </div>
          )}
        </div>

        {/* Chat area */}
        <div className="flex flex-1 flex-col overflow-hidden">
          <ChatThread
            messages={messages}
            streamingContent={streamingContent}
            isStreaming={isStreaming}
            toolCalls={toolCalls}
            a2uiBlocks={a2uiBlocks}
            agentName={agent?.name}
            agentTools={agent?.tools}
          />

          {/* HITL interrupt components */}
          {interrupt && id && (
            <div className="mx-auto w-full max-w-3xl px-4 pb-2">
              {interrupt.toolName === 'edit_document' ? (
                <EditableDocument
                  title={(interrupt.args.title as string) ?? 'Review Document'}
                  content={(interrupt.args.content as string) ?? ''}
                  onSubmit={handleDocSubmit}
                  onCancel={() => clearInterrupt()}
                />
              ) : interrupt.toolName === 'request_fields' ? (
                <FieldRequestForm
                  title={(interrupt.args.title as string) ?? 'Additional Information'}
                  fields={
                    ((interrupt.args.fields as Array<{ name: string; type: 'text' | 'number' | 'date' | 'select' | 'textarea'; label: string; required?: boolean; options?: string[] }>) ?? [])
                  }
                  onSubmit={handleFormSubmit}
                />
              ) : (
                <ApprovalCard
                  title={`Approve: ${interrupt.toolName}`}
                  description={`The agent wants to execute "${interrupt.toolName}".`}
                  action={interrupt.toolName}
                  details={interrupt.args}
                  onApprove={handleApprove}
                  onReject={handleReject}
                />
              )}
            </div>
          )}

          <ChatInput onSend={handleSend} disabled={isStreaming} />
        </div>
      </div>

      {/* Run finished marker for tests */}
      {!isStreaming && messages.length > 0 && (
        <div data-testid="run-finished" className="hidden" />
      )}
    </div>
  );
}
