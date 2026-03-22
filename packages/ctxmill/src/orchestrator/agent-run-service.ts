import { TraceCollector } from '../learning/trace.js';
import type { AGUIEvent } from '../events/types.js';
import type { MessageCommittedEvent } from '@ctxmill/shared';
import type { AgentDefinition, Message } from '../types.js';
import type { SSEManager } from './sse.js';
import type { RunRegistry } from './run-registry.js';
import type { DatabaseRepository } from '../database/repository.js';
import type { LearningPipeline } from '../learning/types.js';
import type { TypedEventBus } from '../events/bus.js';
import type { SandboxRunService } from './sandbox-run-service.js';
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

export interface AgentRunServiceDeps {
  sse: SSEManager;
  db: DatabaseRepository;
  runRegistry: RunRegistry;
  learningPipeline?: LearningPipeline;
  eventBus?: TypedEventBus;
  /** SandboxRunService for executing runs in Docker containers. */
  sandboxRunService: SandboxRunService;
  /** Tool executor for resolving tool definitions for sandbox runs. */
  toolExecutor?: LocalFunctionExecutor;
  toolRegistry?: DefaultToolRegistry;
}

export interface ExecuteRunParams {
  agentDef: AgentDefinition;
  messages: Message[];
  agentId: string;
  conversationId: string;
  runId: string;
  taskDescription: string;
}

/**
 * Extracted business logic for executing an agent run.
 *
 * Streams events from the sandbox, broadcasts ALL events via SSE,
 * persists messages only from MESSAGE_COMMITTED events (sandbox is source of truth),
 * triggers learning pipeline, and completes the run in the registry.
 */
export class AgentRunService {
  private sse: SSEManager;
  private db: DatabaseRepository;
  private runRegistry: RunRegistry;
  private learningPipeline?: LearningPipeline;
  private eventBus?: TypedEventBus;
  private sandboxRunService: SandboxRunService;
  private toolExecutor?: LocalFunctionExecutor;
  private toolRegistry?: DefaultToolRegistry;

  constructor(deps: AgentRunServiceDeps) {
    this.sse = deps.sse;
    this.db = deps.db;
    this.runRegistry = deps.runRegistry;
    this.learningPipeline = deps.learningPipeline;
    this.eventBus = deps.eventBus;
    this.sandboxRunService = deps.sandboxRunService;
    this.toolExecutor = deps.toolExecutor;
    this.toolRegistry = deps.toolRegistry;
  }

  private async resolveTools(agentDef: AgentDefinition) {
    const declaredTools = new Set(agentDef.tools);
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

    return Array.from(allTools.values());
  }

  /**
   * Execute an agent run: iterate over sandbox events, broadcast ALL via SSE,
   * persist messages only from MESSAGE_COMMITTED events, trigger learning,
   * and complete the run in the registry.
   *
   * The sandbox is the source of truth — no delta accumulation occurs here.
   */
  async executeRun(params: ExecuteRunParams): Promise<void> {
    const { agentDef, messages, agentId, conversationId, runId, taskDescription } = params;

    const traceCollector = new TraceCollector(agentId, runId, taskDescription);

    const signal = this.runRegistry.getAbortSignal(runId);

    let encounteredError = false;
    let lastErrorMessage = '';

    const eventSource: AsyncGenerator<AGUIEvent> = this.sandboxRunService.executeSessionTurn(
      agentDef,
      conversationId,
      messages,
      runId,
      signal,
      agentId,
    );

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

        // Persist completed message from sandbox source of truth
        if (event.type === 'MESSAGE_COMMITTED') {
          const committed = event as unknown as MessageCommittedEvent;
          await this.db.addMessage({
            agentId,
            conversationId,
            role: committed.role,
            content: committed.content,
            toolCalls: committed.toolCalls as unknown[] | undefined,
            toolCallId: committed.toolCallId,
          });
        }

        // Emit text chunks to internal event bus (for triggers and monitoring)
        if (event.type === 'TEXT_MESSAGE_CONTENT' && 'content' in event) {
          const textEvent = event as unknown as TextContentEvent;

          if (this.eventBus) {
            this.eventBus.emit('run.text_chunk', {
              runId,
              agentId,
              messageId: textEvent.messageId ?? '',
              content: textEvent.content,
              timestamp: Date.now(),
            });
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
              runId,
              agentId,
              toolCallId: toolStart.toolCallId ?? '',
              toolName: toolStart.toolName,
              args: toolStart.args ?? {},
              timestamp: Date.now(),
            });
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
              runId,
              agentId,
              toolCallId: toolResult.toolCallId ?? '',
              toolName: toolResult.toolName ?? '',
              result: String(toolResult.result).slice(0, 500),
              durationMs: toolResult.durationMs ?? 0,
              timestamp: Date.now(),
            });
          }
        }

        // Handle HITL pause events — pause the run instead of keeping it in running state
        if (event.type === 'HITL_PAUSE') {
          const pauseEvent = event as unknown as HITLPauseEvent;
          const reason = pauseEvent.reason ?? 'hitl_approval';
          await this.runRegistry.pauseRun(runId, reason);
          // Sessions handle restore transparently — no partial content to persist
          return;
        }
      }

      // If cancelled, skip completion (already handled by cancelRun)
      if (signal?.aborted) {
        return;
      }

      // Complete the run — mark as error if we saw error events, with the actual error detail
      if (encounteredError) {
        const errorDetail = lastErrorMessage || 'Run completed with errors (no detail captured)';
        await this.runRegistry.completeRun(runId, errorDetail);
      } else {
        await this.runRegistry.completeRun(runId);
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
      console.error(`[AgentRunService] Run ${runId} error:`, err instanceof Error ? err.stack : err);
      this.sse.broadcast(agentId, {
        type: 'RUN_ERROR',
        timestamp: Date.now(),
        runId,
        error: String(err),
      });

      await this.runRegistry.completeRun(runId, String(err));

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
