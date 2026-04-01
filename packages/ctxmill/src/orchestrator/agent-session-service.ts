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
import { builtinToolNames } from '../tool/builtin/index.js';
import { DefaultToolRegistry } from '../tool/registry.js';

// AG-UI event types already broadcast by SSEBroadcaster via the internal event bus.
// Skipping direct broadcast here prevents duplicate SSE delivery to clients.
const SSE_BROADCASTER_FORWARDED: ReadonlySet<string> = new Set([
  'TEXT_MESSAGE_CONTENT',
  'TOOL_CALL_START',
  'TOOL_CALL_RESULT',
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
}

/**
  * Extracted business logic for executing an agent session.
 *
 * Streams events from the sandbox, broadcasts ALL events via SSE,
 * persists messages only from MESSAGE_COMMITTED events (sandbox is source of truth),
  * triggers learning pipeline, and completes the session in the registry.
 */
export class AgentSessionService {
  private sse: SSEManager;
  private db: DatabaseRepository;
  private sessionManager: SandboxSessionManager;
  private learningPipeline?: LearningPipeline;
  private eventBus?: TypedEventBus;
  private sessionTurnService: SessionTurnService;
  private toolExecutor?: LocalFunctionExecutor;
  private toolRegistry?: DefaultToolRegistry;

  constructor(deps: AgentSessionServiceDeps) {
    this.sse = deps.sse;
    this.db = deps.db;
    this.sessionManager = deps.sessionManager;
    this.learningPipeline = deps.learningPipeline;
    this.eventBus = deps.eventBus;
    this.sessionTurnService = deps.sessionTurnService;
    this.toolExecutor = deps.toolExecutor;
    this.toolRegistry = deps.toolRegistry;
  }

  private async resolveTools(agentDef: AgentDefinition) {
    const declaredTools = new Set(agentDef.tools);
    const excluded = Array.isArray(agentDef.metadata?.excludeBuiltinTools)
      ? new Set(agentDef.metadata.excludeBuiltinTools as string[])
      : undefined;
    const allTools = new Map<string, (ReturnType<LocalFunctionExecutor['list']>[number])>();

    if (this.toolExecutor) {
      for (const tool of this.toolExecutor.list()) {
        if (declaredTools.has(tool.name) || builtinToolNames.has(tool.name)) {
          allTools.set(tool.name, tool);
        }
      }
    }

    if (this.toolRegistry) {
      if (this.toolRegistry.needsRefresh) {
        await this.toolRegistry.refresh();
      }
      for (const tool of this.toolRegistry.listForAgent(agentDef.tools)) {
        allTools.set(tool.name, tool);
      }
    }

    if (excluded) {
      for (const name of excluded) {
        if (builtinToolNames.has(name)) allTools.delete(name);
      }
    }

    return Array.from(allTools.values());
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

    const traceCollector = new TraceCollector(agentId, turnId, taskDescription);
    const startedAt = Date.now();

    // Session setup — container creation can fail (e.g., missing Docker image).
    // Errors here must be caught separately because the event-loop try/catch
    // below depends on sandboxSessionId which doesn't exist yet.
    let sandboxSession: SessionRecord;
    try {
      sandboxSession = await this.sessionManager.ensureSession(conversationId, agentDef, agentId);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[AgentSessionService] Session ${turnId} setup failed:`, err instanceof Error ? err.stack : err);
      this.sse.broadcast(agentId, {
        type: 'RUN_ERROR',
        timestamp: Date.now(),
        runId: turnId,
        error: errorMsg,
      });
      this.sse.broadcast(agentId, {
        type: 'RUN_FINISHED',
        timestamp: Date.now(),
        runId: turnId,
      });
      await this.db.updateTurn(turnId, {
        completedAt: Date.now(),
        error: errorMsg,
      });
      return;
    }

    const sandboxSessionId = sandboxSession.sessionId;
    await this.db.updateTurn(turnId, { sessionId: sandboxSessionId });
    const signal = this.sessionManager.startTurn(sandboxSessionId, turnId, agentId, conversationId, mode, taskDescription);

    let encounteredError = false;
    let lastErrorMessage = '';
    let hitlPending = false;
    const pendingToolCalls = new Map<string, { id: string; name: string; args: string; result?: string; error?: string; status: string }>();
    let accumulatedText = '';
    let assistantFlushedForBatch = false;
    let flushedAssistantMessageId: string | null = null;

    const normalizeContent = (value: unknown): string => {
      if (typeof value === 'string') return value;
      if (value == null) return '';

      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    };

    const buildPersistedToolCalls = () => Array.from(pendingToolCalls.values()).map((tc) => ({
      id: tc.id,
      name: tc.name,
      args: tc.args,
      status: tc.status,
    }));

    const persistMessage = async (
      role: MessageCommittedEvent['role'],
      content: string,
      options?: { toolCalls?: ReturnType<typeof buildPersistedToolCalls>; toolCallId?: string },
    ): Promise<string> => {
      const msg = await this.db.addMessage({
        agentId,
        conversationId,
        role,
        content,
        toolCalls: options?.toolCalls,
        toolCallId: options?.toolCallId,
      });
      return msg.id;
    };

      const eventSource: AsyncGenerator<AGUIEvent> = this.sessionTurnService.executeSessionTurn(
      agentDef,
      conversationId,
      messages,
      turnId,
      signal,
      agentId,
      sandboxSessionId,
    );

    const finalizeTurn = async (status: 'completed' | 'error' | 'cancelled', error?: string) => {
      const completedAt = Date.now();
      await this.db.updateTurn(turnId, {
        sessionId: sandboxSessionId,
        completedAt,
        error: error ?? null,
      });
      this.sessionManager.completeTurn(
        sandboxSessionId,
        turnId,
        agentId,
        conversationId,
        status,
        completedAt - startedAt,
        error,
      );
    };

    try {
      for await (const event of eventSource) {
        if (signal?.aborted) break;

        // All events broadcast to SSE for UI streaming
        if (!SSE_BROADCASTER_FORWARDED.has(event.type)) {
          this.sse.broadcast(agentId, event as Record<string, unknown>);
        }

        if (event.type === 'RUN_ERROR' || event.type === 'RUN_FAILED') {
          encounteredError = true;
          // Capture the actual error message from the event for descriptive error reporting
          if ('error' in event && typeof event.error === 'string' && event.error.length > 0) {
            lastErrorMessage = event.error;
          }
        }

        if (event.type === 'TOOL_CALL_START') {
          const e = event as Record<string, unknown>;
          const tcId = (e.toolCallId as string) || `tc-${Date.now()}`;
          pendingToolCalls.set(tcId, {
            id: tcId,
            name: (e.toolName as string) || (e.name as string) || 'unknown',
            args: typeof e.args === 'string'
              ? e.args
              : e.args === undefined
                ? ''
                : JSON.stringify(e.args),
            status: 'running',
          });
        }

        if (event.type === 'TOOL_CALL_ARGS') {
          const e = event as Record<string, unknown>;
          const tc = pendingToolCalls.get(e.toolCallId as string);
          if (tc) {
            tc.args += (e.args as string) || (e.delta as string) || '';
          }
        }

        if (event.type === 'TOOL_CALL_END') {
          const e = event as Record<string, unknown>;
          const tc = pendingToolCalls.get(e.toolCallId as string);
          if (tc) tc.status = 'complete';
        }

        if (event.type === 'TOOL_CALL_RESULT') {
          const e = event as Record<string, unknown>;
          const tcId = e.toolCallId as string;
          const tc = pendingToolCalls.get(tcId);
          if (tc) {
            tc.result = normalizeContent(e.result);
            tc.error = e.error as string | undefined;
            tc.status = tc.error ? 'error' : 'complete';
          }

          if (!assistantFlushedForBatch && pendingToolCalls.size > 0) {
            flushedAssistantMessageId = await persistMessage('assistant', accumulatedText, {
              toolCalls: buildPersistedToolCalls(),
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
          if (assistantFlushedForBatch) {
            if (accumulatedText) {
              await persistMessage(committed.role, accumulatedText);
            }
            assistantFlushedForBatch = false;
            pendingToolCalls.clear();
            accumulatedText = '';
          } else {
            await persistMessage(committed.role, committed.content, {
              toolCalls: committed.toolCalls as ReturnType<typeof buildPersistedToolCalls> | undefined,
              toolCallId: committed.toolCallId,
            });
          }
        }

        // Emit text chunks to internal event bus (for triggers and monitoring)
        if (event.type === 'TEXT_MESSAGE_CONTENT' && 'content' in event) {
          const textEvent = event as unknown as TextContentEvent;
          accumulatedText += textEvent.content;

          if (this.eventBus) {
            this.eventBus.emit('run.text_chunk', {
              turnId,
              agentId,
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
          if (!hitlPending) {
            await this.sessionManager.pauseSession(sandboxSessionId, 'hitl');
            hitlPending = true;
          }
        }

        if (hitlPending) {
          hitlPending = false;
          await this.sessionManager.resumeSession(sandboxSessionId);
        }
      }

      if (signal?.aborted) {
        await finalizeTurn('cancelled');
        return;
      }

      if (encounteredError) {
        const errorDetail = lastErrorMessage || 'Session completed with errors (no detail captured)';
        await finalizeTurn('error', errorDetail);
      } else {
        await finalizeTurn('completed');
      }

      // Trigger learning pipeline (never block or fail the main run)
      if (this.learningPipeline) {
        try {
          const trace = traceCollector.finalize('success');
          await this.learningPipeline.process(trace);
        } catch (learningErr) {
          console.error('Learning pipeline error:', learningErr);
        }
      }
    } catch (err) {
      console.error(`[AgentSessionService] Session ${turnId} error:`, err instanceof Error ? err.stack : err);
      this.sse.broadcast(agentId, {
        type: 'RUN_ERROR',
        timestamp: Date.now(),
        runId: turnId,
        error: String(err),
      });

      await finalizeTurn('error', String(err));

      // Trigger learning pipeline even on failure to learn from errors
      if (this.learningPipeline) {
        try {
          const trace = traceCollector.finalize('failure');
          await this.learningPipeline.process(trace);
        } catch (learningErr) {
          console.error('Learning pipeline error:', learningErr);
        }
      }
    }
  }
}
