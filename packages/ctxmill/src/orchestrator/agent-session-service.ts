import { TraceCollector } from '../learning/trace.js';
import type { AGUIEvent } from '../events/types.js';
import type { MessageCommittedEvent } from '@ctxmill/shared';
import type { AgentDefinition, Message } from '../types.js';
import type { SSEManager } from './sse.js';
import type { DatabaseRepository } from '../database/repository.js';
import type { LearningPipeline } from '../learning/types.js';
import type { EventMap, TypedEventBus } from '../events/bus.js';
import type { SessionTurnService } from './session-turn-service.js';
import type { SandboxSessionManager, SessionRecord } from './sandbox-session-manager.js';
import type { LocalFunctionExecutor } from '../tool/executor.js';
import { DefaultToolRegistry } from '../tool/registry.js';
import { sanitizeDbText } from '../util/sanitize.js';
import { traceToDbRow } from '../learning/trace-convert.js';
import { withRuntimeSandboxSecrets, type RuntimeSandboxSecrets } from './session-manager/runtime-sandbox-secrets.js';

const INDIVIDUALLY_HANDLED = new Set([
  'MESSAGE_COMMITTED',
  'TEXT_MESSAGE_CONTENT',
  'TOOL_CALL_START',
  'TOOL_CALL_RESULT',
  'RUN_ERROR',
  'RUN_FINISHED',
]);

/** Extended AG-UI event fields used when extracting tool/message data. */
interface TextContentEvent {
  type: 'TEXT_MESSAGE_CONTENT';
  content: string;
  messageId?: string;
}

interface ToolCallStartEvent {
  type: 'TOOL_CALL_START';
  toolName: string;
  toolCallId?: string;
  args?: Record<string, unknown>;
}

interface ToolCallResultEvent {
  type: 'TOOL_CALL_RESULT';
  result: unknown;
  toolCallId?: string;
  toolName?: string;
  durationMs?: number;
}

interface HITLPauseEvent {
  type: 'HITL_PAUSE';
  reason?: string;
}

type StreamingPart =
  | { type: 'text'; content: string }
  | { type: 'tool_call'; id: string; name: string; args: string; result?: string; error?: string; status: string };

export interface AgentSessionServiceDeps {
  sse: SSEManager;
  db: DatabaseRepository;
  sessionManager: SandboxSessionManager;
  learningPipeline?: LearningPipeline;
  eventBus?: TypedEventBus;
  /** SessionTurnService for executing sessions in Docker containers. */
  sessionTurnService: SessionTurnService;
  /** Tool executor for resolving tool definitions for sandbox sessions. */
  toolExecutor?: LocalFunctionExecutor;
  toolRegistry?: DefaultToolRegistry;
}

export interface ExecuteSessionParams {
  agentDef: AgentDefinition;
  messages: Message[];
  agentId: string;
  conversationId: string;
  sessionId: string;
  mode: 'interactive' | 'background';
  taskDescription: string;
  sandboxSecrets?: RuntimeSandboxSecrets;
}

/**
  * Extracted business logic for executing an agent session.
 *
 * Streams events from the sandbox, broadcasts ALL events via SSE,
 * persists messages only from MESSAGE_COMMITTED events (sandbox is source of truth),
  * triggers learning pipeline, and completes the session in the registry.
 */
export class AgentSessionService {
  private db: DatabaseRepository;
  private sessionManager: SandboxSessionManager;
  private learningPipeline?: LearningPipeline;
  private eventBus?: TypedEventBus;
  private sessionTurnService: SessionTurnService;

  constructor(deps: AgentSessionServiceDeps) {
    this.db = deps.db;
    this.sessionManager = deps.sessionManager;
    this.learningPipeline = deps.learningPipeline;
    this.eventBus = deps.eventBus;
    this.sessionTurnService = deps.sessionTurnService;
  }

  /**
   * Execute an agent run: iterate over sandbox events, broadcast ALL via SSE,
   * persist messages only from MESSAGE_COMMITTED events, trigger learning,
   * and complete the run in the registry.
   *
   * The sandbox is the source of truth — no delta accumulation occurs here.
   */
  async executeSession(params: ExecuteSessionParams): Promise<void> {
    const { agentDef, messages, agentId, conversationId, sessionId: turnId, mode, taskDescription } = params;
    const runtimeAgentDef = withRuntimeSandboxSecrets(agentDef, params.sandboxSecrets);

    const traceCollector = new TraceCollector(agentId, turnId, taskDescription);
    const startedAt = Date.now();

    let sandboxSessionId: string | undefined;
    let signal: AbortSignal | undefined;
    let runError: Error | undefined;
    let wasCancelled = false;
    let encounteredError = false;
    let lastErrorMessage = '';

    const pendingToolCalls = new Map<string, { id: string; name: string; args: string; result?: string; error?: string; status: string }>();
    let streamingParts: StreamingPart[] = [];
    let accumulatedText = '';
    let assistantFlushedForBatch = false;
    let flushedAssistantMessageId: string | null = null;
    let lastCommittedMessageSeq = -1;

    const normalizeContent = (value: unknown): string => {
      if (typeof value === 'string') return sanitizeDbText(value, 'normalizeContent');
      if (value == null) return '';

      try {
        return sanitizeDbText(JSON.stringify(value), 'normalizeContent');
      } catch {
        return sanitizeDbText(String(value), 'normalizeContent');
      }
    };

    const buildPersistedToolCalls = () => Array.from(pendingToolCalls.values()).map((tc) => ({
      id: tc.id,
      name: tc.name,
      args: tc.args,
      status: tc.status,
    }));

    const buildCommittedParts = (committed: MessageCommittedEvent): StreamingPart[] => {
      if (streamingParts.length > 0) {
        return [...streamingParts];
      }

      const fallbackParts: StreamingPart[] = [];
      if (committed.content) {
        fallbackParts.push({
          type: 'text',
          content: committed.content,
        });
      }

      if (Array.isArray(committed.toolCalls)) {
        fallbackParts.push(...committed.toolCalls.map((toolCall) => ({
          type: 'tool_call' as const,
          id: toolCall.id,
          name: toolCall.name,
          args: toolCall.args,
          status: toolCall.status,
        })));
      }

      return fallbackParts;
    };

    const persistMessage = async (
      role: MessageCommittedEvent['role'],
      content: string,
      options?: { toolCalls?: ReturnType<typeof buildPersistedToolCalls>; toolCallId?: string; parts?: StreamingPart[] },
    ): Promise<string> => {
      const msg = await this.db.addMessage({
        agentId,
        conversationId,
        role,
        content,
        parts: options?.parts,
        toolCalls: options?.toolCalls,
        toolCallId: options?.toolCallId,
      });
      return msg.id;
    };

    const emitCommittedMessage = (
      role: MessageCommittedEvent['role'],
      content: string,
      options?: {
        toolCalls?: ReturnType<typeof buildPersistedToolCalls>;
        toolCallId?: string;
        parts?: StreamingPart[];
        messageId?: string;
        messageSeq?: number;
      },
    ): void => {
      if (!this.eventBus) {
        return;
      }

      const messageSeq = options?.messageSeq ?? (lastCommittedMessageSeq + 1);
      lastCommittedMessageSeq = Math.max(lastCommittedMessageSeq, messageSeq);

      this.eventBus.emit('message.committed', {
        turnId,
        agentId,
        conversationId,
        messageId: options?.messageId,
        messageSeq,
        role,
        content,
        parts: options?.parts,
        toolCalls: options?.toolCalls as unknown as EventMap['message.committed']['toolCalls'],
        toolCallId: options?.toolCallId,
        timestamp: Date.now(),
      } as unknown as EventMap['message.committed']);
    };

    const finalizeTurn = async (status: 'completed' | 'error' | 'cancelled', error?: string) => {
      const completedAt = Date.now();
      await this.db.updateTurn(turnId, {
        ...(sandboxSessionId ? { sessionId: sandboxSessionId } : {}),
        completedAt,
        error: error ?? null,
      });

      if (sandboxSessionId) {
        this.sessionManager.completeTurn(
          sandboxSessionId,
          turnId,
          agentId,
          conversationId,
          status,
          completedAt - startedAt,
          error,
        );
        return;
      }

      if (this.eventBus) {
        this.eventBus.emit('turn.completed', {
          turnId,
          sessionId: '',
          agentId,
          conversationId,
          status,
          error,
          durationMs: completedAt - startedAt,
          timestamp: Date.now(),
        });
      }
    };

    const flushUncommittedMessages = async () => {
      if (pendingToolCalls.size > 0 && !assistantFlushedForBatch) {
        const parts = [...streamingParts];
        const toolCalls = buildPersistedToolCalls();
        const messageId = await persistMessage('assistant', accumulatedText, {
          parts,
          toolCalls,
        });
        emitCommittedMessage('assistant', accumulatedText, {
          parts,
          toolCalls,
          messageId,
        });
        accumulatedText = '';
        assistantFlushedForBatch = true;
      } else if (pendingToolCalls.size > 0 && assistantFlushedForBatch && flushedAssistantMessageId) {
        await this.db.updateMessageToolCalls(flushedAssistantMessageId, buildPersistedToolCalls());
      } else if (accumulatedText) {
        const parts = [...streamingParts];
        const messageId = await persistMessage('assistant', accumulatedText, {
          parts,
        });
        emitCommittedMessage('assistant', accumulatedText, {
          parts,
          messageId,
        });
        accumulatedText = '';
      }
    };

    try {
      const sandboxSession: SessionRecord = await this.sessionManager.ensureSession(conversationId, runtimeAgentDef, agentId);
      sandboxSessionId = sandboxSession.sessionId;

      await this.db.updateTurn(turnId, { sessionId: sandboxSessionId });
      signal = this.sessionManager.startTurn(sandboxSessionId, turnId, agentId, conversationId, mode, taskDescription);

      const eventSource: AsyncGenerator<AGUIEvent> = this.sessionTurnService.executeSessionTurn(
        runtimeAgentDef,
        conversationId,
        messages,
        turnId,
        signal,
        agentId,
        sandboxSessionId,
      );

      for await (const event of eventSource) {
        if (signal?.aborted) break;

        if (!INDIVIDUALLY_HANDLED.has(event.type) && this.eventBus) {
          this.eventBus.emit('run.ag_ui_event', {
            turnId,
            agentId,
            conversationId,
            event: event as Record<string, unknown>,
            timestamp: Date.now(),
          });
        }

        if (event.type === 'RUN_ERROR') {
          encounteredError = true;
          // Capture the actual error message from the event for descriptive error reporting
          if ('error' in event && typeof event.error === 'string' && event.error.length > 0) {
            lastErrorMessage = event.error;
          }
        }

        if (event.type === 'TOOL_CALL_START') {
          const e = event as Record<string, unknown>;
          const tcId = (e.toolCallId as string) || `tc-${Date.now()}`;
          const toolArgs = typeof e.args === 'string'
            ? e.args
            : e.args === undefined
              ? ''
              : JSON.stringify(e.args);
          pendingToolCalls.set(tcId, {
            id: tcId,
            name: (e.toolName as string) || (e.name as string) || 'unknown',
            args: toolArgs,
            status: 'running',
          });
          streamingParts.push({
            type: 'tool_call',
            id: tcId,
            name: (e.toolName as string) || (e.name as string) || 'unknown',
            args: toolArgs,
            status: 'running',
          });
        }

        if (event.type === 'TOOL_CALL_ARGS') {
          const e = event as Record<string, unknown>;
          const tc = pendingToolCalls.get(e.toolCallId as string);
          const toolArgsDelta = (e.args as string) || (e.delta as string) || '';
          if (tc) {
            tc.args += toolArgsDelta;
          }
          const part = streamingParts.find((streamingPart) => streamingPart.type === 'tool_call' && streamingPart.id === (e.toolCallId as string));
          if (part && part.type === 'tool_call') {
            part.args += toolArgsDelta;
          }
        }

        if (event.type === 'TOOL_CALL_END') {
          const e = event as Record<string, unknown>;
          const tc = pendingToolCalls.get(e.toolCallId as string);
          if (tc) tc.status = 'complete';
          const part = streamingParts.find((streamingPart) => streamingPart.type === 'tool_call' && streamingPart.id === (e.toolCallId as string));
          if (part && part.type === 'tool_call') part.status = 'complete';
        }

        if (event.type === 'TOOL_CALL_RESULT') {
          const e = event as Record<string, unknown>;
          const tcId = e.toolCallId as string;
          const tc = pendingToolCalls.get(tcId);
          const part = streamingParts.find((streamingPart) => streamingPart.type === 'tool_call' && streamingPart.id === tcId);
          if (tc) {
            tc.result = normalizeContent(e.result);
            tc.error = e.error as string | undefined;
            tc.status = tc.error ? 'error' : 'complete';
          }
          if (part && part.type === 'tool_call') {
            part.result = normalizeContent(e.result);
            part.error = e.error as string | undefined;
            part.status = part.error ? 'error' : 'complete';
          }

          if (!assistantFlushedForBatch && pendingToolCalls.size > 0) {
            const parts = [...streamingParts];
            const toolCalls = buildPersistedToolCalls();
            flushedAssistantMessageId = await persistMessage('assistant', accumulatedText, {
              parts,
              toolCalls,
            });
            emitCommittedMessage('assistant', accumulatedText, {
              parts,
              toolCalls,
              messageId: flushedAssistantMessageId ?? undefined,
            });
            accumulatedText = '';
            assistantFlushedForBatch = true;
          } else if (assistantFlushedForBatch && flushedAssistantMessageId) {
            await this.db.updateMessageToolCalls(flushedAssistantMessageId, buildPersistedToolCalls());
          }

          await persistMessage('tool', normalizeContent(e.result), {
            toolCallId: tcId,
          });
        }

        if (event.type === 'MESSAGE_COMMITTED') {
          const committed = event as unknown as MessageCommittedEvent;
          lastCommittedMessageSeq = Math.max(lastCommittedMessageSeq, committed.messageSeq);
          const finalParts = buildCommittedParts(committed);
          if (assistantFlushedForBatch) {
            if (accumulatedText) {
              flushedAssistantMessageId = await persistMessage(committed.role, accumulatedText, {
                parts: finalParts,
              });
            }
            assistantFlushedForBatch = false;
            pendingToolCalls.clear();
            accumulatedText = '';
          } else {
            flushedAssistantMessageId = await persistMessage(committed.role, committed.content, {
              parts: finalParts,
              toolCalls: committed.toolCalls as ReturnType<typeof buildPersistedToolCalls> | undefined,
              toolCallId: committed.toolCallId,
            });
            accumulatedText = '';
          }

          emitCommittedMessage(committed.role, committed.content, {
            parts: finalParts,
            toolCalls: committed.toolCalls as ReturnType<typeof buildPersistedToolCalls> | undefined,
            toolCallId: committed.toolCallId,
            messageId: flushedAssistantMessageId ?? undefined,
            messageSeq: committed.messageSeq,
          });

          streamingParts = [];
        }

        // Emit text chunks to internal event bus (for triggers and monitoring)
        if (event.type === 'TEXT_MESSAGE_CONTENT' && 'content' in event) {
          const textEvent = event as unknown as TextContentEvent;
          accumulatedText += textEvent.content;

          const lastPart = streamingParts[streamingParts.length - 1];
          if (lastPart?.type === 'text') {
            lastPart.content += textEvent.content;
          } else {
            streamingParts.push({
              type: 'text',
              content: textEvent.content,
            });
          }

          if (this.eventBus) {
            this.eventBus.emit('run.text_chunk', {
              turnId,
              agentId,
              conversationId,
              messageId: textEvent.messageId ?? '',
              content: textEvent.content,
              timestamp: Date.now(),
            } as unknown as EventMap['run.text_chunk']);
          }
        }

        // Collect trace steps from tool events
        if (event.type === 'TOOL_CALL_START' && 'toolName' in event) {
          const toolStart = event as unknown as ToolCallStartEvent;
          traceCollector.addStep('tool_call', toolStart.toolName, 0, {
            toolCallId: toolStart.toolCallId,
            args: toolStart.args ?? {},
          });

          if (this.eventBus) {
            this.eventBus.emit('run.tool_started', {
              turnId,
              agentId,
              conversationId,
              toolCallId: toolStart.toolCallId ?? '',
              toolName: toolStart.toolName,
              args: toolStart.args ?? {},
              timestamp: Date.now(),
            } as unknown as EventMap['run.tool_started']);
          }
        }
        if (event.type === 'TOOL_CALL_RESULT' && 'result' in event) {
          const toolResult = event as unknown as ToolCallResultEvent;
          traceCollector.addStep(
            'tool_result',
            String(toolResult.result).slice(0, 500),
            toolResult.durationMs ?? 0,
            { toolCallId: toolResult.toolCallId },
          );

          if (this.eventBus) {
            this.eventBus.emit('run.tool_result', {
              turnId,
              agentId,
              conversationId,
              toolCallId: toolResult.toolCallId ?? '',
              toolName: toolResult.toolName ?? '',
              result: String(toolResult.result).slice(0, 500),
              durationMs: toolResult.durationMs ?? 0,
              timestamp: Date.now(),
            } as unknown as EventMap['run.tool_result']);
          }
        }

        if (event.type === 'HITL_PAUSE') {
          void (event as unknown as HITLPauseEvent);
        }
      }

      if (signal?.aborted) {
        wasCancelled = true;
        runError = new Error('Session cancelled');
      } else if (encounteredError) {
        runError = new Error(lastErrorMessage || 'Session completed with errors (no detail captured)');
      }
    } catch (err) {
      runError = err instanceof Error ? err : new Error(String(err));
      console.error(`[AgentSessionService] Session ${turnId} error:`, runError.stack ?? runError.message);
    } finally {
      const status: 'completed' | 'error' | 'cancelled' =
        wasCancelled
          ? 'cancelled'
          : runError
            ? 'error'
            : 'completed';

      let flushError: Error | undefined;
      try {
        await flushUncommittedMessages();
      } catch (err) {
        flushError = err instanceof Error ? err : new Error(String(err));
        console.error(`[AgentSessionService] Failed to flush uncommitted messages for turn ${turnId}:`, flushError);
      }

      const finalError = runError && flushError
        ? `${runError.message}; additionally flush failed: ${flushError.message}`
        : runError?.message ?? flushError?.message;
      const finalStatus = finalError ? (status === 'completed' ? 'error' : status) : status;

      const finalTrace = this.learningPipeline
        ? traceCollector.finalize(finalStatus === 'completed' ? 'success' : 'failure')
        : undefined;

      if (finalTrace && this.eventBus) {
        try {
          await this.db.saveTrace(traceToDbRow(finalTrace));
        } catch (traceErr) {
          console.error(`[AgentSessionService] Failed to persist trace before turn.completed for turn ${turnId}:`, traceErr);
        }
      }

      try {
        await finalizeTurn(finalStatus, finalError);
      } catch (finalizeErr) {
        console.error(`[AgentSessionService] finalizeTurn failed for turn ${turnId}:`, finalizeErr);
        try {
          await this.db.updateTurn(turnId, {
            ...(sandboxSessionId ? { sessionId: sandboxSessionId } : {}),
            completedAt: Date.now(),
            error: finalError ?? String(finalizeErr),
          });
          if (this.eventBus) {
            this.eventBus.emit('turn.completed', {
              turnId,
              sessionId: sandboxSessionId ?? '',
              agentId,
              conversationId,
              status: finalError ? 'error' : 'completed',
              error: finalError ?? String(finalizeErr),
              durationMs: Date.now() - startedAt,
              timestamp: Date.now(),
            });
          }
        } catch (dbErr) {
          console.error(`[AgentSessionService] Failed to update turn ${turnId} even directly:`, dbErr);
        }
      }

      if (this.learningPipeline && finalTrace && !this.eventBus) {
        try {
          await this.learningPipeline.process(finalTrace);
        } catch (learningErr) {
          console.error('Learning pipeline error:', learningErr);
        }
      }
    }
  }
}
