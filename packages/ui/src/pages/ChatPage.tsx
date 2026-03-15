import { useEffect, useCallback, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Radio,
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

  const [error, setError] = useState<string | null>(null);
  const [explorerOpen, setExplorerOpen] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | undefined>();

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
        if (mounted) setConversationId(convId);

        const msgs = await fetchMessages(id!, convId);
        if (!mounted || !Array.isArray(msgs) || msgs.length === 0) return;

        const parsed = msgs.map((m: Record<string, unknown>, i: number) => {
          // Reconstruct a2uiBlocks from DB's a2uiPayload field, or parse from content
          let blocks = (m.a2uiBlocks || m.a2uiPayload) as Message['a2uiBlocks'];
          if (!blocks && m.role === 'assistant' && m.content) {
            const content = m.content as string;
            const extracted: Array<{ id: string; component: string; props: Record<string, unknown> }> = [];
            const pattern = /\{\s*"component"\s*:\s*"[^"]+"\s*,\s*"props"\s*:\s*\{[\s\S]*?\}\s*\}/g;
            let match;
            while ((match = pattern.exec(content)) !== null) {
              try {
                const p = JSON.parse(match[0]);
                if (typeof p.component === 'string' && p.props) {
                  extracted.push({ id: `a2ui-${i}-${extracted.length}`, component: p.component, props: p.props });
                }
              } catch { /* skip */ }
            }
            if (extracted.length > 0) blocks = extracted;
          }
          // Normalize: if blocks came from DB as array of {component, props}, add ids
          if (Array.isArray(blocks)) {
            blocks = blocks.map((b: any, bi: number) => ({
              id: b.id || `a2ui-${i}-${bi}`,
              component: b.component,
              props: b.props,
            }));
          }
          return {
            id: (m.id as string) || `msg-${i}`,
            role: ((m.role as string) || 'assistant') as 'user' | 'assistant' | 'system' | 'tool',
            content: (m.content as string) || '',
            toolCalls: m.toolCalls as Message['toolCalls'],
            a2uiBlocks: blocks,
            createdAt: (m.createdAt as string) || new Date().toISOString(),
          };
        });

        loadMessages(parsed);
      } catch (err) {
        console.debug('[ChatPage] Failed to load conversation history:', err);
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
      setError(null);
      addUserMessage(content);
      try {
        await sendMessage(id, content, conversationId);
      } catch (err) {
        console.error('[Chat] Failed to send message:', err);
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [id, addUserMessage, conversationId],
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
            onClick={() => navigate('/')}
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
                {agent.model}
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
              <div className="rounded-md bg-red-900/30 border border-red-700/40 px-3 py-2 text-sm text-red-400">
                {error}
              </div>
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
