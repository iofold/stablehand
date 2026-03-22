import { useEffect, useCallback, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Radio,
} from 'lucide-react';
import { ChatThread } from '@/components/chat/ChatThread';
import { ChatInput } from '@/components/chat/ChatInput';
import { ErrorMessage } from '@/components/chat/ErrorMessage';
import { ApprovalCard } from '@/components/hitl/ApprovalCard';
import { EditableDocument } from '@/components/hitl/EditableDocument';
import { FieldRequestForm } from '@/components/hitl/FieldRequestForm';
import { FileExplorer } from '@/components/explorer/FileExplorer';
import { FileViewer } from '@/components/explorer/FileViewer';
import { ConnectionBanner } from '@/components/ui/ConnectionBanner';
import { useConversationStore } from '@/stores/conversation';
import { normalizeConversationMessage } from '@/stores/conversation';
import { useInterruptStore } from '@/stores/interrupt';
import { useAgentsStore } from '@/stores/agents';
import { useSSE, useSSEStatus } from '@/lib/useSSE';
import { sendMessage, sendInterrupt, fetchMessages, fetchConversations, fetchRuns } from '@/lib/api';
import { cn } from '@/lib/utils';
// ConnectionBanner reads status from the shared SSE store internally

export function ChatPage() {
  const { id, conversationId: urlConversationId } = useParams<{ id: string; conversationId?: string }>();
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
    setActiveConversation,
    reset,
  } = useConversationStore();
  const interrupt = useInterruptStore((s) => s.pending);
  const clearInterrupt = useInterruptStore((s) => s.clear);
  const sseStatus = useSSEStatus();

  const [error, setError] = useState<string | null>(null);
  const [pastRunError, setPastRunError] = useState<string | null>(null);
  const [lastFailedContent, setLastFailedContent] = useState<string | null>(null);
  const [explorerOpen, setExplorerOpen] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | undefined>(urlConversationId);

  useSSE(id);

  useEffect(() => {
    if (agents.length === 0) fetchAgents();
  }, [agents.length, fetchAgents]);

  useEffect(() => {
    reset();
    if (!id) {
      setConversationId(undefined);
      loadMessages([]);
      return;
    }

    let mounted = true;

    setConversationId(urlConversationId);
    setActiveConversation(urlConversationId ?? null);
    loadMessages([]);
    setPastRunError(null);

    async function loadHistory() {
      try {
        let convId = urlConversationId;

        if (!convId) {
          const convs = await fetchConversations(id!) as Array<{ id: string }>;
          if (!mounted) return;
          if (Array.isArray(convs) && convs.length > 0) {
            convId = convs[0].id;
          }
        }

        if (!convId) {
          setConversationId(undefined);
          setActiveConversation(null);
          loadMessages([]);
        } else {
          setConversationId(convId);
          setActiveConversation(convId);

          const msgs = await fetchMessages(id!, convId);
          if (!mounted) return;
          if (!Array.isArray(msgs) || msgs.length === 0) {
            loadMessages([]);
          } else {
            const parsed = msgs.map((m: Record<string, unknown>, i: number) =>
              normalizeConversationMessage(m, `msg-${i}`),
            );

            if (mounted) {
              loadMessages(parsed);
            }
          }
        }

        if (mounted) {
          try {
            const runs = await fetchRuns(id!);
            if (mounted && Array.isArray(runs)) {
              const hasActiveRun = runs.some((r: Record<string, unknown>) => r.status === 'running' || r.status === 'queued');
              if (hasActiveRun) {
                useConversationStore.setState({ isStreaming: true });
              }

              if (convId) {
                const convRuns = runs.filter((r: Record<string, unknown>) => r.conversationId === convId);
                convRuns.sort((a: any, b: any) => (b.startedAt || 0) - (a.startedAt || 0));
                const lastRun = convRuns[0];
                if (lastRun && (lastRun.status === 'failed' || lastRun.status === 'error') && lastRun.error) {
                  setPastRunError(lastRun.error as string);
                } else {
                  setPastRunError(null);
                }
              } else {
                setPastRunError(null);
              }
            }
          } catch (err) {
            console.debug('[ChatPage] Failed to fetch runs:', err);
          }
        }
      } catch (err) {
        console.debug('[ChatPage] Failed to load conversation history:', err);
      }
    }

    loadHistory();
    return () => {
      mounted = false;
      reset();
    };
  }, [id, urlConversationId, loadMessages, setActiveConversation, reset]);

  const agent = agents.find((a) => a.id === id);

  const handleSend = useCallback(
    async (content: string) => {
      if (!id) return;
      setError(null);
      setPastRunError(null);
      setLastFailedContent(null);
      addUserMessage(content);
      try {
        const response = await sendMessage(id, content, conversationId);
        if (response?.conversationId && !conversationId) {
          setConversationId(response.conversationId);
          setActiveConversation(response.conversationId);
        }
      } catch (err) {
        console.error('[Chat] Failed to send message:', err);
        setError(err instanceof Error ? err.message : String(err));
        setLastFailedContent(content);
      }
    },
    [id, addUserMessage, conversationId, setActiveConversation],
  );

  const handleApprove = useCallback(async () => {
    if (!id) return;
    setError(null);
    try {
      await sendInterrupt(id, 'approve', undefined, interrupt?.runId);
      clearInterrupt();
    } catch (err) {
      console.error('[Chat] Failed to send approval:', err);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [id, clearInterrupt, interrupt?.runId]);

  const handleReject = useCallback(async () => {
    if (!id) return;
    setError(null);
    try {
      await sendInterrupt(id, 'reject', undefined, interrupt?.runId);
      clearInterrupt();
    } catch (err) {
      console.error('[Chat] Failed to send rejection:', err);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [id, clearInterrupt, interrupt?.runId]);

  const handleDocSubmit = useCallback(
    async (content: string) => {
      if (!id) return;
      setError(null);
      try {
        await sendInterrupt(id, 'submit', { content }, interrupt?.runId);
        clearInterrupt();
      } catch (err) {
        console.error('[Chat] Failed to submit document:', err);
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [id, clearInterrupt, interrupt?.runId],
  );

  const handleFormSubmit = useCallback(
    async (values: Record<string, string>) => {
      if (!id) return;
      setError(null);
      try {
        await sendInterrupt(id, 'submit', values, interrupt?.runId);
        clearInterrupt();
      } catch (err) {
        console.error('[Chat] Failed to submit form:', err);
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [id, clearInterrupt, interrupt?.runId],
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
      <header className="sticky top-0 z-30 border-b border-surface-700 bg-surface-850">
        <div className="mx-auto flex h-14 items-center gap-3 px-4 sm:px-6">
          {/* Back */}
           <button
             type="button"
             data-testid="back-button"
             onClick={() => navigate(-1)}
             className="rounded-lg p-1.5 text-surface-400 hover:bg-surface-800 hover:text-surface-200 transition-colors"
           >
             <ArrowLeft className="h-4 w-4" />
           </button>

          {/* Agent identity */}
          <div className="flex items-center gap-2.5 min-w-0">
            <h1 className="truncate text-sm font-semibold text-surface-200 leading-tight">
              {agent?.name ?? 'Agent'}
            </h1>
            {agent && (
              <span className="truncate font-mono text-sm text-surface-500">
                {(agent.harnessConfig as Record<string, unknown>)?.model as string}
              </span>
            )}
            <span
              className={cn(
                'h-2 w-2 rounded-full',
                connectionDot,
              )}
            />
          </div>

          {/* Streaming indicator */}
          {isStreaming && (
            <div className="ml-auto flex items-center gap-1.5 rounded-full bg-accent-600/10 border border-accent-500/20 px-2.5 py-1">
              <Radio className="h-3 w-3 text-accent-400 animate-pulse" />
              <span className="text-[11px] font-medium text-accent-400">Live</span>
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
            agentId={id}
            conversationId={conversationId}
            pastRunError={pastRunError}
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

          {error && (
            <div
              data-testid="chat-error"
              className="mx-auto w-full max-w-3xl px-4 pb-1"
            >
              <ErrorMessage
                summary="Failed to send message"
                details={error}
                onRetry={lastFailedContent ? () => handleSend(lastFailedContent) : undefined}
                onDismiss={() => { setError(null); setLastFailedContent(null); }}
              />
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
