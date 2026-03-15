import { join } from 'node:path';
import { TraceCollector } from '../learning/trace.js';
import type { AGUIEvent } from '../events/types.js';
import type { AgentDefinition, Message } from '../types.js';
import type { AgentExecutor } from '../agent/executor.js';
import type { SSEManager } from './sse.js';
import type { RunRegistry } from './run-registry.js';
import type { DatabaseRepository } from '../database/repository.js';
import type { LearningPipeline } from '../learning/types.js';
import { extractA2UIBlocks } from '../a2ui/extract.js';
import type { TypedEventBus } from '../events/bus.js';
import type { A2UIBlock } from '../a2ui/extract.js';

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

export interface AgentRunServiceDeps {
  executor: AgentExecutor;
  sse: SSEManager;
  db: DatabaseRepository;
  runRegistry: RunRegistry;
  learningPipeline?: LearningPipeline;
  eventBus?: TypedEventBus;
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
 * Streams events from the executor, broadcasts via SSE,
 * persists the assistant reply, triggers learning pipeline,
 * and completes the run in the registry.
 */
export class AgentRunService {
  private executor: AgentExecutor;
  private sse: SSEManager;
  private db: DatabaseRepository;
  private runRegistry: RunRegistry;
  private learningPipeline?: LearningPipeline;
  private eventBus?: TypedEventBus;

  constructor(deps: AgentRunServiceDeps) {
    this.executor = deps.executor;
    this.sse = deps.sse;
    this.db = deps.db;
    this.runRegistry = deps.runRegistry;
    this.learningPipeline = deps.learningPipeline;
    this.eventBus = deps.eventBus;
  }

  /**
   * Execute an agent run: iterate over executor events, broadcast via SSE,
   * accumulate assistant text, persist the message, trigger learning, and
   * complete the run in the registry.
   */
  async executeRun(params: ExecuteRunParams): Promise<void> {
    const { agentDef, messages, agentId, conversationId, runId, taskDescription } = params;

    let assistantContent = '';
    const traceCollector = new TraceCollector(agentId, runId, taskDescription);

    // Record the session directory if an environment factory is configured
    if (agentDef.workspaceDir && this.executor.getEnvironmentFactory()) {
      const sessionsDir = join(agentDef.workspaceDir, '..', '..', 'sessions');
      const sessionDir = join(sessionsDir, runId);
      await this.runRegistry.updateSessionDir(runId, sessionDir);
    }

    const signal = this.runRegistry.getAbortSignal(runId);

    try {
      for await (const event of this.executor.run(agentDef, messages, agentId, runId, signal)) {
        if (signal?.aborted) break;
        this.sse.broadcast(agentId, event as Record<string, unknown>);

        // Accumulate assistant text content for persistence
        if (event.type === 'TEXT_MESSAGE_CONTENT' && 'content' in event) {
          const textEvent = event as unknown as TextContentEvent;
          assistantContent += textEvent.content;

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
      }

      // If cancelled, persist partial content but skip completion (already handled by cancelRun)
      if (signal?.aborted) {
        if (assistantContent.length > 0) {
          await this.db.addMessage({
            agentId,
            conversationId,
            role: 'assistant',
            content: assistantContent,
          });
        }
        return;
      }

      // Persist the assistant reply if any text was generated
      if (assistantContent.length > 0) {
        // Extract all A2UI component blocks from the response
        const a2uiBlocks = extractA2UIBlocks(assistantContent);

        await this.db.addMessage({
          agentId,
          conversationId,
          role: 'assistant',
          content: assistantContent,
          // Type narrowed: schema defines a2uiPayload as Record<string, unknown> but runtime stores A2UIBlock[] (JSON column)
          a2uiPayload: a2uiBlocks.length > 0 ? (a2uiBlocks as unknown as Record<string, unknown>) : undefined,
        });
      }

      // Complete the run successfully
      await this.runRegistry.completeRun(runId);

      // Trigger learning pipeline (never block or fail the main run)
      if (this.learningPipeline && assistantContent.length > 0) {
        try {
          const trace = traceCollector.finalize('success');
          await this.learningPipeline.process(trace);
        } catch (learningErr) {
          console.error('Learning pipeline error:', learningErr);
        }
      }
    } catch (err) {
      this.sse.broadcast(agentId, {
        type: 'RUN_ERROR',
        timestamp: Date.now(),
        runId,
        error: String(err),
      });

      // Complete the run with error
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
