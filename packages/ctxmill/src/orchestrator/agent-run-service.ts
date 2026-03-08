import { TraceCollector } from '../learning/trace.js';
import type { AGUIEvent } from '../events/types.js';
import type { AgentDefinition, Message } from '../types.js';
import type { AgentExecutor } from '../agent/executor.js';
import type { SSEManager } from './sse.js';
import type { RunRegistry } from './run-registry.js';
import type { DatabaseRepository } from '../database/repository.js';
import type { LearningPipeline } from '../learning/types.js';
import { extractA2UIBlocks } from '../a2ui/extract.js';

export interface AgentRunServiceDeps {
  executor: AgentExecutor;
  sse: SSEManager;
  db: DatabaseRepository;
  runRegistry: RunRegistry;
  learningPipeline?: LearningPipeline;
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

  constructor(deps: AgentRunServiceDeps) {
    this.executor = deps.executor;
    this.sse = deps.sse;
    this.db = deps.db;
    this.runRegistry = deps.runRegistry;
    this.learningPipeline = deps.learningPipeline;
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

    try {
      for await (const event of this.executor.run(agentDef, messages, agentId)) {
        this.sse.broadcast(agentId, event as Record<string, unknown>);

        // Accumulate assistant text content for persistence
        if (event.type === 'TEXT_MESSAGE_CONTENT' && 'content' in event) {
          assistantContent += (event as unknown as { content: string }).content;
        }

        // Collect trace steps from tool events
        if (event.type === 'TOOL_CALL_START' && 'toolName' in event) {
          traceCollector.addStep('tool_call', (event as any).toolName, 0, {
            toolCallId: (event as any).toolCallId,
          });
        }
        if (event.type === 'TOOL_CALL_RESULT' && 'result' in event) {
          traceCollector.addStep(
            'tool_result',
            String((event as any).result).slice(0, 500),
            (event as any).durationMs ?? 0,
            { toolCallId: (event as any).toolCallId },
          );
        }
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
          a2uiPayload: a2uiBlocks.length > 0 ? (a2uiBlocks as any) : undefined,
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
        runId: conversationId,
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
