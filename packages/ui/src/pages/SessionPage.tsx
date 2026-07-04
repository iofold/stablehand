import { useEffect, useCallback, useState } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import {
  ArrowLeft,
  Radio,
  AlertTriangle,
} from 'lucide-react';
import { SessionThread } from '@/components/session/SessionThread';
import { SessionInput } from '@/components/session/SessionInput';
import { ErrorDisplay } from '@/components/session/ErrorDisplay';
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
import { sendMessage, sendInterrupt, fetchMessages, fetchConversations, fetchSessions, fetchTurns, fetchInterrupts } from '@/lib/api';
import { cn } from '@/lib/utils';
import { isNewConversationPath } from '@/lib/routes';

function humanizeError(raw: string): { summary: string; details: string } {
  if (raw.includes('ConnectError') || raw.includes('stream closed')) {
    return { summary: 'Connection to agent was interrupted', details: raw };
  }
  if (raw.includes('CANCEL') || raw.includes('canceled')) {
    return { summary: 'Agent session was cancelled', details: raw };
  }
  if (raw.includes('timeout') || raw.includes('Timeout')) {
    return { summary: 'Agent session timed out', details: raw };
  }
  if (raw.includes('not found') || raw.includes('404')) {
    return { summary: 'Resource not found', details: raw };
  }
  if (raw.includes('Sandbox handler')) {
    return { summary: 'Tool execution error', details: raw };
  }
  if (raw.length > 100) {
    return { summary: 'An error occurred during the agent session', details: raw };
  }
  return { summary: raw, details: '' };
}

export function SessionPage() {
  const { id, conversationId: routeConversationId } = useParams<{ id: string; conversationId?: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const agents = useAgentsStore((s) => s.agents);
  const fetchAgents = useAgentsStore((s) => s.fetchAgents);
  const {
    messages,
    isStreaming,
    streamingContent,
    toolCalls,
    addUserMessage,
    loadMessages,
    setActiveConversation,
    reset,
  } = useConversationStore();
  const interrupt = useInterruptStore((s) => s.pending);
  const clearInterrupt = useInterruptStore((s) => s.clear);
  const sseStatus = useSSEStatus();

  const [error, setError] = useState<string | null>(null);
  const [isReadOnly, setIsReadOnly] = useState(false);
  const [pastRunError, setPastRunError] = useState<string | null>(null);
  const [lastFailedContent, setLastFailedContent] = useState<string | null>(null);
  const [explorerOpen] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | undefined>(routeConversationId);


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

    setConversationId(routeConversationId);
    setActiveConversation(routeConversationId ?? null);
    loadMessages([]);
    setPastRunError(null);
    setIsReadOnly(false);  

    async function loadHistory() {
      try {
        let resolvedConversationId = routeConversationId;
        const isNewSession = isNewConversationPath(location.pathname);

        if (!resolvedConversationId && !isNewSession) {
          const convs = await fetchConversations(id!) as Array<{ id: string }>;
          if (!mounted) return;
          if (Array.isArray(convs) && convs.length > 0) {
            resolvedConversationId = convs[0].id;
          }
        }

        if (!resolvedConversationId) {
          setConversationId(undefined);
          setActiveConversation(null);
          loadMessages([]);
        } else {
          setConversationId(resolvedConversationId);
          setActiveConversation(resolvedConversationId);

          const msgs = await fetchMessages(id!, resolvedConversationId);
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
            const [sessionsRaw, turnsRaw] = await Promise.all([
              fetchSessions(id!),
              fetchTurns(id!),
            ]);
            if (!mounted) return;

            const sessions = ((sessionsRaw as { sessions?: Record<string, unknown>[] }).sessions ?? []);
            const turns = Array.isArray(turnsRaw) ? turnsRaw : [] as Record<string, unknown>[];

            const isRuntimeActiveStatus = (status: unknown) =>
              status === 'ACTIVE' || status === 'RESTORING';
            const matchingSessions = resolvedConversationId
              ? sessions.filter((s: Record<string, unknown>) => s.conversationId === resolvedConversationId)
              : sessions;
            const hasActiveContainer = matchingSessions.some(
              (s: Record<string, unknown>) => isRuntimeActiveStatus(s.status),
            );
            // Container being ACTIVE is not enough — we also need an incomplete turn.
            // Sandbox sessions stay ACTIVE even after a turn completes (container persists).
            const hasActiveTurn = resolvedConversationId
              ? turns.some(
                  (t: Record<string, unknown>) =>
                    t.conversationId === resolvedConversationId &&
                    t.completedAt == null &&
                    !t.error,
                )
              : turns.some(
                  (t: Record<string, unknown>) =>
                    t.completedAt == null && !t.error,
                );
            useConversationStore.setState({ isStreaming: hasActiveContainer && hasActiveTurn });

            if (resolvedConversationId) {
              const convTurns = turns
                .filter((t: Record<string, unknown>) => t.conversationId === resolvedConversationId)
                .sort(
                  (a: Record<string, unknown>, b: Record<string, unknown>) =>
                    ((b.startedAt as number) || 0) - ((a.startedAt as number) || 0),
                );
              const lastTurn = convTurns[0];
              if (lastTurn?.error) {
                setPastRunError(lastTurn.error as string);
              } else {
                setPastRunError(null);
              }

              // Only lock read-only when the unified session status is TERMINATED
              // (no checkpoint to restore). ACTIVE/CHECKPOINTED/RESTORING sessions can resume.
              const isTerminated = matchingSessions.length > 0 &&
                matchingSessions.every((s: Record<string, unknown>) => s.status === 'TERMINATED');
              if (isTerminated && !hasActiveTurn && convTurns.length > 0) {
                setIsReadOnly(true);
              }
            } else {
              setPastRunError(null);
            }
          } catch (err) {
            console.debug('[SessionPage] Failed to fetch sessions/turns:', err);
          }

          try {
            const pendingInterrupts = await fetchInterrupts(id!);
            if (mounted && Array.isArray(pendingInterrupts) && pendingInterrupts.length > 0) {
              const first = [...pendingInterrupts].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))[0];
              useInterruptStore.getState().setPending({
                agentId: id!,
                toolName: first.toolName,
                args: first.args,
                toolCallId: first.toolCallId,
                sessionId: first.sessionId,
              });
            }
          } catch (err) {
            console.debug('[SessionPage] Failed to fetch interrupts:', err);
          }
        }
      } catch (err) {
        console.debug('[SessionPage] Failed to load session history:', err);
      }
    }

    loadHistory();
    return () => {
      mounted = false;
      reset();
    };
  }, [id, routeConversationId, loadMessages, setActiveConversation, reset, location.pathname]);

  const agent = agents.find((a) => a.id === id);

  const agentsLoaded = agents.length > 0;
  const agentNotFound = agentsLoaded && id && !agent;

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
          navigate(`/agents/${id}/conversations/${response.conversationId}`, { replace: true });
        }
      } catch (err) {
        console.error('[Session] Failed to send message:', err);
        setError(err instanceof Error ? err.message : String(err));
        setLastFailedContent(content);
      }
    },
    [id, addUserMessage, conversationId, setActiveConversation, navigate],
  );

  const handleApprove = useCallback(async () => {
    if (!id) return;
    setError(null);
    try {
      const toolName = interrupt?.toolName || '';
      useConversationStore.getState().addSystemMessage(
        `✓ Approved${toolName ? `: ${toolName}` : ''}`,
      );
      await sendInterrupt(id, 'approve', undefined, interrupt?.sessionId);
      clearInterrupt();
    } catch (err) {
      console.error('[Session] Failed to send approval:', err);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [id, clearInterrupt, interrupt?.sessionId, interrupt?.toolName]);

  const handleReject = useCallback(async () => {
    if (!id) return;
    setError(null);
    try {
      const toolName = interrupt?.toolName || '';
      useConversationStore.getState().addSystemMessage(
        `✗ Rejected${toolName ? `: ${toolName}` : ''}`,
      );
      await sendInterrupt(id, 'reject', undefined, interrupt?.sessionId);
      clearInterrupt();
    } catch (err) {
      console.error('[Session] Failed to send rejection:', err);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [id, clearInterrupt, interrupt?.sessionId, interrupt?.toolName]);

  const handleDocSubmit = useCallback(
    async (content: string) => {
      if (!id) return;
      setError(null);
      try {
        await sendInterrupt(id, 'submit', { content }, interrupt?.sessionId);
        clearInterrupt();
      } catch (err) {
        console.error('[Session] Failed to submit document:', err);
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [id, clearInterrupt, interrupt?.sessionId],
  );

  const handleFormSubmit = useCallback(
    async (values: Record<string, string>) => {
      if (!id) return;
      setError(null);
      try {
        await sendInterrupt(id, 'submit', values, interrupt?.sessionId);
        clearInterrupt();
      } catch (err) {
        console.error('[Session] Failed to submit form:', err);
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [id, clearInterrupt, interrupt?.sessionId],
  );

  const handleFileSelect = useCallback((path: string) => {
    setSelectedFile(path);
  }, []);

  const connectionDot = sseStatus === 'connected'
    ? 'bg-emerald-400'
    : sseStatus === 'connecting'
      ? 'bg-amber-400 animate-pulse'
      : 'bg-red-400';

  if (!agentsLoaded) {
    return (
      <div className="flex h-screen items-center justify-center bg-surface-950">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-surface-600 border-t-accent-400" />
      </div>
    );
  }

  if (agentNotFound) {
    return (
      <div className="flex h-screen flex-col items-center justify-center bg-surface-950 gap-4">
        <AlertTriangle className="h-12 w-12 text-surface-500" />
        <h1 className="text-lg font-semibold text-surface-200">Agent not found</h1>
        <p className="text-sm text-surface-400">
          The agent you're looking for doesn't exist or has been deleted.
        </p>
        <button
          type="button"
          onClick={() => navigate('/')}
          className="btn-primary mt-2"
        >
          Back to Dashboard
        </button>
      </div>
    );
  }

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
              <span className="hidden truncate font-mono text-sm text-surface-500 sm:inline">
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

        <div className="flex flex-1 flex-col overflow-hidden">
          <SessionThread
            messages={messages}
            streamingContent={streamingContent}
            isStreaming={isStreaming}
            toolCalls={toolCalls}
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
                data-testid="session-error"
                className="mx-auto w-full max-w-3xl px-4 pb-1"
              >
              <ErrorDisplay
                summary={humanizeError(error).summary}
                details={humanizeError(error).details || undefined}
                onRetry={lastFailedContent ? () => handleSend(lastFailedContent) : undefined}
                onDismiss={() => { setError(null); setLastFailedContent(null); }}
              />
            </div>
          )}
          {isReadOnly ? (
            <div className="mx-auto w-full max-w-3xl px-4 pb-4">
              <div className="rounded-lg border border-surface-700 bg-surface-800/50 p-4 text-center">
                <p className="text-sm text-surface-400">This session has ended. Start a new conversation to continue.</p>
              </div>
            </div>
          ) : (
            <SessionInput onSend={handleSend} disabled={isStreaming} />
          )}
        </div>
      </div>

      {/* Run finished marker for tests */}
      {!isStreaming && messages.length > 0 && (
        <div data-testid="run-finished" className="hidden" />
      )}
    </div>
  );
}
