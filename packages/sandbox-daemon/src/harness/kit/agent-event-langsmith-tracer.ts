import type { AgentEvent, TokenUsage } from '../types.js';
import type { AgentEventTracer } from './trace-agent-events.js';

interface RunTreeLike {
  postRun(): Promise<void>;
  end(outputs?: Record<string, unknown>): Promise<void>;
  patchRun(): Promise<void>;
  createChild(config: Record<string, unknown>): RunTreeLike;
}

interface RunTreeConstructor {
  new(config: Record<string, unknown>): RunTreeLike;
}

interface LangSmithClientLike {
  awaitPendingTraceBatches?(): Promise<void>;
}

interface LangSmithClientConstructor {
  new(): LangSmithClientLike;
}

interface LangSmithRuntime {
  RunTree: RunTreeConstructor;
  Client: LangSmithClientConstructor;
  projectName?: string;
}

export interface CreateAgentEventLangSmithTracerOptions {
  enabled?: boolean;
  agentId: string;
  conversationId: string;
  harnessName: string;
  turnId: string;
  langsmith?: LangSmithRuntime;
}

function toLangSmithUsage(usage: TokenUsage | undefined): Record<string, unknown> | undefined {
  if (!usage) {
    return undefined;
  }

  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
    ...(usage.costUsd !== undefined ? { cost: usage.costUsd } : {}),
  };
}

async function loadLangSmithRuntime(): Promise<LangSmithRuntime> {
  const langsmithModule = await import('langsmith');
  return {
    RunTree: langsmithModule.RunTree as unknown as RunTreeConstructor,
    Client: langsmithModule.Client as unknown as LangSmithClientConstructor,
  };
}

function appendText(existing: string, next: string): string {
  if (!existing) {
    return next;
  }
  return `${existing}${next}`;
}

export async function createAgentEventLangSmithTracer(
  options: CreateAgentEventLangSmithTracerOptions,
): Promise<AgentEventTracer | null> {
  const enabled = options.enabled ?? process.env.LANGSMITH_TRACING === 'true';
  if (!enabled) {
    return null;
  }

  const runtime = options.langsmith ?? await loadLangSmithRuntime();
  const client = new runtime.Client();
  const pendingOperations = new Set<Promise<void>>();
  let eventChain = Promise.resolve();
  let rootRun: RunTreeLike | undefined;
  let turnRun: RunTreeLike | undefined;
  let llmRun: RunTreeLike | undefined;
  const toolRuns = new Map<string, RunTreeLike>();
  let assistantText = '';
  let committedText = '';
  let committedToolCalls: Extract<AgentEvent, { type: 'message_committed' }>['toolCalls'] | undefined;
  let usage: TokenUsage | undefined;
  let terminalStatus: 'completed' | 'errored' | 'flushed' = 'flushed';
  let terminalError: string | undefined;

  const trackOperation = (operation: Promise<void>): void => {
    pendingOperations.add(operation);
    void operation.finally(() => pendingOperations.delete(operation));
  };

  const endAndPatch = async (run: RunTreeLike, outputs?: Record<string, unknown>): Promise<void> => {
    await run.end(outputs);
    await run.patchRun();
  };

  const ensureRootRun = (): RunTreeLike => {
    if (!rootRun) {
      rootRun = new runtime.RunTree({
        name: `${options.harnessName}-agent-${options.agentId}`,
        run_type: 'chain',
        inputs: {
          agentId: options.agentId,
          conversationId: options.conversationId,
          harnessName: options.harnessName,
        },
        project_name: runtime.projectName ?? process.env.LANGSMITH_PROJECT ?? 'stablehand',
        extra: {
          metadata: {
            agentId: options.agentId,
            conversationId: options.conversationId,
            harnessName: options.harnessName,
            ls_integration: 'stablehand-agent-events',
          },
        },
        client,
      });
      trackOperation(rootRun.postRun());
    }
    return rootRun;
  };

  const ensureTurnRun = (): RunTreeLike => {
    if (!turnRun) {
      turnRun = ensureRootRun().createChild({
        name: `${options.harnessName}-turn`,
        run_type: 'chain',
        inputs: { turnId: options.turnId },
      });
      trackOperation(turnRun.postRun());
    }
    return turnRun;
  };

  const ensureLlmRun = (): RunTreeLike => {
    if (!llmRun) {
      llmRun = ensureTurnRun().createChild({
        name: 'llm-call',
        run_type: 'llm',
        inputs: { turnId: options.turnId },
      });
      trackOperation(llmRun.postRun());
    }
    return llmRun;
  };

  const endActiveLlmRun = (): void => {
    if (!llmRun) {
      return;
    }

    const text = committedText || assistantText;
    const outputs: Record<string, unknown> = {};
    if (text) {
      outputs.generations = [{ text }];
    }
    if (committedToolCalls?.length) {
      outputs.toolCalls = committedToolCalls;
    }
    trackOperation(endAndPatch(llmRun, Object.keys(outputs).length > 0 ? outputs : undefined));
    llmRun = undefined;
  };

  const endActiveToolRuns = (): void => {
    for (const [toolCallId, run] of toolRuns) {
      trackOperation(endAndPatch(run, { status: 'unfinished', toolCallId }));
      toolRuns.delete(toolCallId);
    }
  };

  const endTurnAndRoot = (): void => {
    endActiveToolRuns();
    endActiveLlmRun();

    if (turnRun) {
      const outputs: Record<string, unknown> = {};
      const text = committedText || assistantText;
      if (text) {
        outputs.assistantText = text;
      }
      if (committedToolCalls?.length) {
        outputs.toolCalls = committedToolCalls;
      }
      const usageMetadata = toLangSmithUsage(usage);
      if (usageMetadata) {
        outputs.usage_metadata = usageMetadata;
      }
      if (terminalError) {
        outputs.error = terminalError;
      }
      trackOperation(endAndPatch(turnRun, Object.keys(outputs).length > 0 ? outputs : undefined));
      turnRun = undefined;
    }

    if (rootRun) {
      trackOperation(endAndPatch(rootRun, terminalError
        ? { status: terminalStatus, error: terminalError }
        : { status: terminalStatus }));
      rootRun = undefined;
    }
  };

  const handleEvent = async (event: AgentEvent): Promise<void> => {
    switch (event.type) {
      case 'text_delta':
        ensureLlmRun();
        assistantText = appendText(assistantText, event.content);
        break;

      case 'tool_call_start': {
        ensureLlmRun();
        const toolRun = ensureTurnRun().createChild({
          name: event.name,
          run_type: 'tool',
          inputs: {
            args: event.args,
            toolCallId: event.id,
          },
        });
        toolRuns.set(event.id, toolRun);
        trackOperation(toolRun.postRun());
        break;
      }

      case 'tool_call_end': {
        const toolRun = toolRuns.get(event.id);
        if (toolRun) {
          const outputs: Record<string, unknown> = {
            result: event.result,
            durationMs: event.durationMs,
          };
          if (event.error) {
            outputs.error = event.error;
          }
          trackOperation(endAndPatch(toolRun, outputs));
          toolRuns.delete(event.id);
        }
        break;
      }

      case 'message_committed':
        if (event.role === 'assistant') {
          ensureLlmRun();
          committedText = event.content;
          committedToolCalls = event.toolCalls;
          endActiveLlmRun();
        }
        break;

      case 'done':
        usage = event.usage;
        terminalStatus = 'completed';
        endTurnAndRoot();
        break;

      case 'error':
        terminalStatus = 'errored';
        terminalError = event.error;
        endTurnAndRoot();
        break;

      default:
        break;
    }
  };

  ensureRootRun();

  const awaitPendingOperations = async (): Promise<void> => {
    while (pendingOperations.size > 0) {
      await Promise.allSettled([...pendingOperations]);
    }
  };

  return {
    onEvent(event: AgentEvent): void {
      eventChain = eventChain
        .then(() => handleEvent(event))
        .catch((err: unknown) => {
          console.warn('[harness-trace] Error handling AgentEvent:', err);
        });
    },

    async flush(): Promise<void> {
      await eventChain;
      if (rootRun || turnRun || llmRun || toolRuns.size > 0) {
        endTurnAndRoot();
      }
      await awaitPendingOperations();
      if (typeof client.awaitPendingTraceBatches === 'function') {
        await client.awaitPendingTraceBatches();
      }
    },
  };
}
