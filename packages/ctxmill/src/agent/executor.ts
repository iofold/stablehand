import { randomUUID } from 'node:crypto';
import type { AgentDefinition, Message } from '../types.js';
import type { AGUIEvent } from '../events/types.js';
import type { KnowledgeStore } from '../knowledge/types.js';
import type { LLMProvider } from '../llm/types.js';
import { LocalFunctionExecutor } from '../tool/executor.js';
import type { InterruptManager } from '../orchestrator/interrupt.js';
import type { EnvironmentFactory } from '../workspace/types.js';
import type { TypedEventBus } from '../events/bus.js';
import type { HarnessRegistry, HarnessRunConfig, AgentEvent } from '../harness/types.js';
import { DefaultHarnessRegistry } from '../harness/registry.js';
import { LangGraphHarness } from '../harness/langgraph.js';
import { builtinToolNames } from '../tool/builtin/index.js';
import { extractA2UIBlocks } from '../a2ui/extract.js';

/**
 * Normalize text deltas from various LLM response shapes.
 * Exported for backward compatibility and tests.
 */
export function normalizeStreamTextDeltas(content: unknown): string[] {
  if (typeof content === 'string') {
    return content.length > 0 ? [content] : [];
  }

  if (Array.isArray(content)) {
    return content.flatMap((block) => normalizeStreamTextDeltas(block));
  }

  if (!content || typeof content !== 'object') {
    return [];
  }

  const block = content as Record<string, unknown>;
  const type = typeof block.type === 'string' ? block.type : undefined;
  const textLikeType = !type || type === 'text' || type === 'text_delta';

  if (textLikeType) {
    if (typeof block.text === 'string' && block.text.length > 0) {
      return [block.text];
    }
    if (typeof block.delta === 'string' && block.delta.length > 0) {
      return [block.delta];
    }
    if (typeof block.value === 'string' && block.value.length > 0) {
      return [block.value];
    }
  }

  if (Array.isArray(block.content)) {
    return normalizeStreamTextDeltas(block.content);
  }

  if (typeof block.content === 'string' && textLikeType && block.content.length > 0) {
    return [block.content];
  }

  return [];
}

/**
 * Thin dispatcher that delegates to a registered AgentHarness.
 *
 * The executor resolves which harness to use from `agentDef.harness`
 * (default: 'langgraph'), builds a HarnessRunConfig, delegates to
 * `harness.run()`, and converts the normalized AgentEvent stream
 * back to AGUIEvent for backward compatibility with existing consumers
 * (SSE broadcaster, AgentRunService, etc.).
 */
export class AgentExecutor {
  private harnessRegistry: HarnessRegistry;
  private toolExecutor: LocalFunctionExecutor;
  private knowledgeStore: KnowledgeStore;
  private interruptManager: InterruptManager | null;
  private envFactory: EnvironmentFactory | null;
  private eventBus: TypedEventBus | null;

  constructor(
    llmProvider: LLMProvider,
    toolExecutor: LocalFunctionExecutor,
    knowledgeStore: KnowledgeStore,
    interruptManager?: InterruptManager,
    envFactory?: EnvironmentFactory,
    eventBus?: TypedEventBus,
    harnessRegistry?: HarnessRegistry,
  ) {
    this.toolExecutor = toolExecutor;
    this.knowledgeStore = knowledgeStore;
    this.interruptManager = interruptManager ?? null;
    this.envFactory = envFactory ?? null;
    this.eventBus = eventBus ?? null;

    // Use provided registry or build a default one with the LangGraph harness
    if (harnessRegistry) {
      this.harnessRegistry = harnessRegistry;
    } else {
      const registry = new DefaultHarnessRegistry();
      const langGraphHarness = new LangGraphHarness(
        llmProvider,
        toolExecutor,
        knowledgeStore,
        interruptManager,
        envFactory,
      );
      registry.register(langGraphHarness);
      this.harnessRegistry = registry;
    }
  }

  /** Get the configured EnvironmentFactory (if any). */
  getEnvironmentFactory(): EnvironmentFactory | null {
    return this.envFactory;
  }

  /** Get the harness registry for external registration. */
  getHarnessRegistry(): HarnessRegistry {
    return this.harnessRegistry;
  }

  /**
   * Run a conversation turn. Yields AG-UI events as they happen.
   *
   * Looks up the harness from agentDef.harness (default: 'langgraph'),
   * builds a HarnessRunConfig, delegates to harness.run(), and converts
   * the normalized AgentEvent stream back to AGUIEvent.
   */
  async *run(
    agentDef: AgentDefinition,
    messages: Message[],
    agentId?: string,
    externalRunId?: string,
    signal?: AbortSignal,
  ): AsyncGenerator<AGUIEvent> {
    const runId = externalRunId ?? randomUUID();
    const knowledgeKey = agentId || agentDef.name;
    const harnessName = agentDef.harness ?? 'langgraph';
    const harness = this.harnessRegistry.get(harnessName);

    yield { type: 'RUN_STARTED', timestamp: Date.now(), runId };

    try {
      // Resolve tool definitions: filter by agentDef.tools + builtins
      const allToolDefs = this.toolExecutor.list();
      const declaredTools = new Set(agentDef.tools);
      const filteredTools = allToolDefs.filter(
        (def) => declaredTools.has(def.name) || builtinToolNames.has(def.name),
      );

      // Build the harness run config
      const config: HarnessRunConfig = {
        modelConfig: agentDef.modelConfig ?? {
          provider: 'openai',
          model: agentDef.model,
        },
        systemPrompt: agentDef.systemPrompt,
        messages,
        tools: filteredTools,
        secrets: {},
        agentId: knowledgeKey,
        runId,
        conversationId: runId,
        workspaceDir: agentDef.workspaceDir ?? process.cwd(),
        eventBus: this.eventBus ?? undefined,
        signal,
      };

      // Delegate to the harness and convert AgentEvent → AGUIEvent
      const messageId = randomUUID();
      let textStarted = false;
      let currentTextContent = '';

      for await (const event of harness.run(config)) {
        for (const aguiEvent of this.convertToAGUI(event, runId, messageId, textStarted, currentTextContent)) {
          // Track text state for proper message framing
          if (aguiEvent.type === 'TEXT_MESSAGE_START') {
            textStarted = true;
          }
          if (aguiEvent.type === 'TEXT_MESSAGE_END') {
            textStarted = false;
            currentTextContent = '';
          }
          if (aguiEvent.type === 'TEXT_MESSAGE_CONTENT' && 'content' in aguiEvent) {
            currentTextContent += aguiEvent.content as string;
          }
          yield aguiEvent;
        }
      }

      // Ensure any trailing text block is closed
      if (textStarted) {
        const a2uiBlocks = extractA2UIBlocks(currentTextContent);
        for (const block of a2uiBlocks) {
          yield {
            type: 'CUSTOM',
            timestamp: Date.now(),
            runId,
            subtype: 'a2ui',
            payload: block,
          };
        }
        yield {
          type: 'TEXT_MESSAGE_END',
          timestamp: Date.now(),
          runId,
          messageId,
        };
      }

      yield { type: 'RUN_FINISHED', timestamp: Date.now(), runId };
    } catch (err) {
      yield {
        type: 'RUN_ERROR',
        timestamp: Date.now(),
        runId,
        error: String(err),
      };
    }
  }

  /**
   * Convert a normalized AgentEvent to one or more AGUIEvents.
   * Handles the text message framing (START/CONTENT/END) that AG-UI requires.
   */
  private *convertToAGUI(
    event: AgentEvent,
    runId: string,
    messageId: string,
    textStarted: boolean,
    currentTextContent: string,
  ): Generator<AGUIEvent> {
    switch (event.type) {
      case 'text_delta': {
        if (!textStarted) {
          yield {
            type: 'TEXT_MESSAGE_START',
            timestamp: Date.now(),
            runId,
            messageId,
          };
        }
        yield {
          type: 'TEXT_MESSAGE_CONTENT',
          timestamp: Date.now(),
          runId,
          messageId,
          content: event.content,
        };
        break;
      }

      case 'tool_call_start': {
        // End text block if one is open before starting tool call
        if (textStarted) {
          const a2uiBlocks = extractA2UIBlocks(currentTextContent);
          for (const block of a2uiBlocks) {
            yield {
              type: 'CUSTOM',
              timestamp: Date.now(),
              runId,
              subtype: 'a2ui',
              payload: block,
            };
          }
          yield {
            type: 'TEXT_MESSAGE_END',
            timestamp: Date.now(),
            runId,
            messageId,
          };
        }
        yield {
          type: 'TOOL_CALL_START',
          timestamp: Date.now(),
          runId,
          toolCallId: event.id,
          toolName: event.name,
        };
        if (event.args) {
          yield {
            type: 'TOOL_CALL_ARGS',
            timestamp: Date.now(),
            runId,
            toolCallId: event.id,
            args: typeof event.args === 'string' ? event.args : JSON.stringify(event.args),
          };
        }
        break;
      }

      case 'tool_call_end': {
        yield {
          type: 'TOOL_CALL_RESULT',
          timestamp: Date.now(),
          runId,
          toolCallId: event.id,
          result: event.result,
          durationMs: event.durationMs,
        };
        break;
      }

      case 'approval_needed': {
        yield {
          type: 'CUSTOM',
          timestamp: Date.now(),
          runId,
          subtype: 'interrupted',
          toolCallId: event.id,
          toolName: event.tool,
          args: event.args,
        };
        break;
      }

      case 'approval_resolved': {
        yield {
          type: 'CUSTOM',
          timestamp: Date.now(),
          runId,
          subtype: 'interrupt_resolved',
          toolCallId: event.id,
          action: event.action,
        };
        break;
      }

      case 'error': {
        yield {
          type: 'RUN_ERROR',
          timestamp: Date.now(),
          runId,
          error: event.error,
        };
        break;
      }

      case 'done': {
        // End text if still open
        if (textStarted) {
          const a2uiBlocks = extractA2UIBlocks(currentTextContent);
          for (const block of a2uiBlocks) {
            yield {
              type: 'CUSTOM',
              timestamp: Date.now(),
              runId,
              subtype: 'a2ui',
              payload: block,
            };
          }
          yield {
            type: 'TEXT_MESSAGE_END',
            timestamp: Date.now(),
            runId,
            messageId,
          };
        }
        // done event is handled by the caller (RUN_FINISHED)
        break;
      }
    }
  }
}
