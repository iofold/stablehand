interface LangSmithTokenUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

interface RunTreeLike {
  postRun(): Promise<void>;
  end(outputs?: Record<string, unknown>): Promise<void>;
  patchRun(): Promise<void>;
  createChild(config: Record<string, unknown>): RunTreeLike;
}

export interface PiTracingContext {
  onEvent(piEvent: Record<string, unknown>): void;
  flush(): Promise<void>;
}

type LangSmithEventHandler = (piEvent: Record<string, unknown>) => Promise<void>;

interface PiMessageData {
  role: string;
  content: string;
  model?: string;
  provider?: string;
  api?: string;
  usage?: {
    input: number;
    output: number;
    totalTokens: number;
  };
  stopReason?: string;
}

interface LlmSpanEndData {
  text?: string;
  stopReason?: string;
  usage?: LangSmithTokenUsage;
}

export async function createPiLangSmithTracer(
  agentId: string,
  conversationId: string,
): Promise<PiTracingContext | null> {
  if (process.env.LANGSMITH_TRACING !== 'true') {
    return null;
  }

  try {
    const langsmithModule = await import('langsmith');
    const { RunTree, Client } = langsmithModule;
    const client = new Client();

    let rootRun: RunTreeLike | null = null;
    let currentTurnRun: RunTreeLike | null = null;
    let activeLlmSpan: RunTreeLike | null = null;
    const activeToolSpans = new Map<string, RunTreeLike>();
    const pendingOperations = new Set<Promise<void>>();
    let eventChain = Promise.resolve();
    let isFlushing = false;
    let currentTurnIndex: number | undefined;
    let lastUserContent = '';
    let llmTextBuffer = '';
    let turnAssistantText = '';
    let currentModel: string | undefined;
    let currentProvider: string | undefined;
    let currentApi: string | undefined;

    const trackOperation = (promise: Promise<void>): Promise<void> => {
      pendingOperations.add(promise);
      void promise.finally(() => {
        pendingOperations.delete(promise);
      });
      return promise;
    };

    const awaitPendingOperations = async (): Promise<void> => {
      if (pendingOperations.size === 0) {
        return;
      }

      const operations = [...pendingOperations];
      await Promise.allSettled(operations);
      if (pendingOperations.size > 0) {
        await awaitPendingOperations();
      }
    };

    const ensureRootRun = (): RunTreeLike => {
      if (!rootRun) {
        rootRun = new RunTree({
          name: `pi-agent-${agentId}`,
          run_type: 'chain',
          inputs: { agentId, conversationId },
          project_name: process.env.LANGSMITH_PROJECT || 'ctxmill',
          extra: {
            metadata: {
              agentId,
              conversationId,
              ls_integration: 'ctxmill-pi-agent',
            },
          },
          client,
        }) as unknown as RunTreeLike;
        trackOperation(rootRun.postRun()).catch((err: unknown) => {
          console.warn('[pi-langsmith] Failed to post root run:', err);
        });
      }
      return rootRun;
    };

    const ensureTurnRun = (): RunTreeLike => {
      if (!currentTurnRun) {
        const root = ensureRootRun();
        const inputs = currentTurnIndex === undefined ? {} : { turnIndex: currentTurnIndex };
        currentTurnRun = root.createChild({
          name: 'pi-turn',
          run_type: 'chain',
          inputs,
        });
        trackOperation(currentTurnRun.postRun()).catch((err: unknown) => {
          console.warn('[pi-langsmith] Failed to post turn run:', err);
        });
      }
      return currentTurnRun;
    };

    const endAndPatch = async (span: RunTreeLike, outputs?: Record<string, unknown>): Promise<void> => {
      await span.end(outputs);
      await span.patchRun();
    };

    const endActiveLlmSpan = async (data?: LlmSpanEndData): Promise<void> => {
      if (!activeLlmSpan) {
        return;
      }

      const span = activeLlmSpan;
      activeLlmSpan = null;
      const text = data?.text ?? llmTextBuffer;
      const outputs: Record<string, unknown> = {};

      if (text) {
        const generation: Record<string, unknown> = { text };
        if (data?.stopReason) {
          generation.generationInfo = { finish_reason: data.stopReason };
          outputs.stopReason = data.stopReason;
        }
        outputs.generations = [generation];
        turnAssistantText = appendCompletedText(turnAssistantText, text);
      } else if (data?.stopReason) {
        outputs.stopReason = data.stopReason;
      }

      if (data?.usage) {
        outputs.usage_metadata = data.usage;
      }

      llmTextBuffer = '';
      currentModel = undefined;
      currentProvider = undefined;
      currentApi = undefined;

      const endPayload = Object.keys(outputs).length > 0 ? outputs : undefined;
      await trackOperation(endAndPatch(span, endPayload)).catch((err: unknown) => {
        console.warn('[pi-langsmith] Failed to end llm span:', err);
      });
    };

    const startLlmSpan = async (messageData?: PiMessageData): Promise<void> => {
      const parent = currentTurnRun ?? ensureTurnRun();
      currentModel = messageData?.model;
      currentProvider = messageData?.provider;
      currentApi = messageData?.api;
      llmTextBuffer = '';

      const inputs: Record<string, unknown> = {
        messages: lastUserContent ? [{ role: 'user', content: lastUserContent }] : [],
      };

      if (currentModel) {
        inputs.model = currentModel;
      }
      if (currentProvider) {
        inputs.provider = currentProvider;
      }
      if (currentApi) {
        inputs.api = currentApi;
      }

      const metadata: Record<string, unknown> = {};
      if (currentModel) {
        metadata.ls_model_name = currentModel;
      }
      if (currentProvider) {
        metadata.ls_provider = currentProvider;
      }

      const childConfig: Record<string, unknown> = {
        name: 'llm-call',
        run_type: 'llm',
        inputs,
      };

      if (Object.keys(metadata).length > 0) {
        childConfig.extra = { metadata };
      }

      activeLlmSpan = parent.createChild({
        ...childConfig,
      });
      await trackOperation(activeLlmSpan.postRun()).catch((err: unknown) => {
        console.warn('[pi-langsmith] Failed to post llm span:', err);
      });
    };

    const endActiveToolSpans = async (): Promise<void> => {
      for (const [toolCallId, span] of activeToolSpans) {
        await trackOperation(endAndPatch(span)).catch((err: unknown) => {
          console.warn('[pi-langsmith] Failed to end dangling tool span:', err);
        });
        activeToolSpans.delete(toolCallId);
      }
    };

    const handleEvent: LangSmithEventHandler = async (piEvent) => {
      switch (piEvent.type) {
        case 'agent_start': {
          ensureRootRun();
          break;
        }

        case 'turn_start': {
          // End the previous turn if still open (multi-turn agentic loops)
          if (currentTurnRun) {
            await trackOperation(endAndPatch(currentTurnRun)).catch((err: unknown) => {
              console.warn('[pi-langsmith] Failed to end previous turn run:', err);
            });
            currentTurnRun = null;
          }
          currentTurnIndex = typeof piEvent.turnIndex === 'number' ? piEvent.turnIndex : undefined;
          turnAssistantText = '';
          const root = ensureRootRun();
          currentTurnRun = root.createChild({
            name: 'pi-turn',
            run_type: 'chain',
            inputs: currentTurnIndex === undefined ? {} : { turnIndex: currentTurnIndex },
          });
          await trackOperation(currentTurnRun.postRun()).catch((err: unknown) => {
            console.warn('[pi-langsmith] Failed to post turn run:', err);
          });
          break;
        }

        case 'message_start': {
          const messageData = extractMessageData(piEvent);
          if (messageData?.role === 'user') {
            lastUserContent = messageData.content;
            break;
          }

          if (messageData?.role === 'assistant') {
            await endActiveLlmSpan();
            await startLlmSpan(messageData);
          }
          break;
        }

        // PI SDK sometimes skips message_start for the first message in a turn,
        // jumping straight to message_update. Create the LLM span lazily.
        case 'message_update': {
          const messageData = extractMessageData(piEvent);
          if (!activeLlmSpan && messageData?.role === 'assistant') {
            await startLlmSpan(messageData);
          }

          const delta = extractAssistantDelta(piEvent);
          if (delta) {
            llmTextBuffer += delta;
          }
          break;
        }

        case 'message_end': {
          const messageData = extractMessageData(piEvent);
          if (messageData?.role === 'user') {
            lastUserContent = messageData.content;
            break;
          }

          if (messageData?.role === 'assistant') {
            await endActiveLlmSpan({
              text: llmTextBuffer || messageData.content,
              stopReason: messageData.stopReason,
              usage: toLangSmithTokenUsage(messageData.usage),
            });
          }
          break;
        }

        case 'tool_execution_start': {
          const parent = currentTurnRun ?? ensureTurnRun();
          const toolCallId = typeof piEvent.toolCallId === 'string' ? piEvent.toolCallId : 'unknown';
          const toolSpan = parent.createChild({
            name: typeof piEvent.toolName === 'string' ? piEvent.toolName : 'unknown-tool',
            run_type: 'tool',
            inputs: { args: piEvent.args, toolCallId },
          });
          await trackOperation(toolSpan.postRun()).catch((err: unknown) => {
            console.warn('[pi-langsmith] Failed to post tool span:', err);
          });
          activeToolSpans.set(toolCallId, toolSpan);
          break;
        }

        case 'tool_execution_end': {
          const toolCallId = typeof piEvent.toolCallId === 'string' ? piEvent.toolCallId : 'unknown';
          const toolSpan = activeToolSpans.get(toolCallId);
          if (toolSpan) {
            await trackOperation(endAndPatch(toolSpan, { result: piEvent.result })).catch((err: unknown) => {
              console.warn('[pi-langsmith] Failed to end tool span:', err);
            });
            activeToolSpans.delete(toolCallId);
          }
          break;
        }

        case 'turn_end': {
          await endActiveToolSpans();

          const messageData = extractMessageData(piEvent);
          if (activeLlmSpan) {
            await endActiveLlmSpan({
              text: messageData?.role === 'assistant' ? llmTextBuffer || messageData.content : undefined,
              stopReason: messageData?.role === 'assistant' ? messageData.stopReason : undefined,
              usage: messageData?.role === 'assistant' ? toLangSmithTokenUsage(messageData.usage) : undefined,
            });
          }

          if (currentTurnRun) {
            const usage = toLangSmithTokenUsage(messageData?.usage);
            const outputs: Record<string, unknown> = {};
            const assistantText = turnAssistantText || (messageData?.role === 'assistant' ? messageData.content : '');

            if (assistantText) {
              outputs.assistantText = assistantText;
            }
            if (messageData?.stopReason) {
              outputs.stopReason = messageData.stopReason;
            }
            if (usage) {
              outputs.usage_metadata = usage;
            }
            if (Array.isArray(piEvent.toolResults)) {
              outputs.toolResults = piEvent.toolResults;
            }

            const endPayload = Object.keys(outputs).length > 0 ? outputs : undefined;
            await trackOperation(endAndPatch(currentTurnRun, endPayload)).catch((err: unknown) => {
              console.warn('[pi-langsmith] Failed to end turn run:', err);
            });
            currentTurnRun = null;
            currentTurnIndex = undefined;
            turnAssistantText = '';
          }
          break;
        }

        case 'agent_end': {
          await endActiveToolSpans();
          await endActiveLlmSpan();

          if (currentTurnRun) {
            await trackOperation(endAndPatch(currentTurnRun)).catch((err: unknown) => {
              console.warn('[pi-langsmith] Failed to end dangling turn run:', err);
            });
            currentTurnRun = null;
          }
          if (rootRun) {
            await trackOperation(endAndPatch(rootRun, { status: 'completed' })).catch((err: unknown) => {
              console.warn('[pi-langsmith] Failed to end root run:', err);
            });
            rootRun = null;
          }
          break;
        }
      }
    };

    ensureRootRun();

    const onEvent = (piEvent: Record<string, unknown>): void => {
      if (isFlushing) {
        return;
      }

      eventChain = eventChain
        .then(() => handleEvent(piEvent))
        .catch((err: unknown) => {
          console.warn('[pi-langsmith] Error handling event:', err);
        });
    };

    const flush = async (): Promise<void> => {
      isFlushing = true;

      await eventChain.catch((err: unknown) => {
        console.warn('[pi-langsmith] Error draining event chain during flush:', err);
      });

      await endActiveToolSpans();
      await endActiveLlmSpan();

      if (currentTurnRun) {
        await trackOperation(endAndPatch(currentTurnRun)).catch((err: unknown) => {
          console.warn('[pi-langsmith] Failed to flush turn run:', err);
        });
        currentTurnRun = null;
      }
      if (rootRun) {
        await trackOperation(endAndPatch(rootRun, { status: 'flushed' })).catch((err: unknown) => {
          console.warn('[pi-langsmith] Failed to flush root run:', err);
        });
        rootRun = null;
      }

      await awaitPendingOperations();

      if (typeof client.awaitPendingTraceBatches === 'function') {
        await client.awaitPendingTraceBatches();
      }
      // Give the langsmith SDK batch queue time to drain HTTP requests
      await new Promise<void>((resolve) => setTimeout(resolve, 1500));
    };

    console.log('[pi-agent] LangSmith tracing enabled');
    return { onEvent, flush };
  } catch (err) {
    console.warn('[pi-agent] LangSmith tracing init failed, continuing without:', err);
    return null;
  }
}

function extractMessageData(piEvent: Record<string, unknown>): PiMessageData | null {
  const msg = isRecord(piEvent.message) ? piEvent.message : null;
  if (!msg) {
    return null;
  }

  const role = typeof msg.role === 'string' ? msg.role : 'unknown';
  const content = extractContentText(msg.content);

  return {
    role,
    content,
    model: typeof msg.model === 'string' ? msg.model : undefined,
    provider: typeof msg.provider === 'string' ? msg.provider : undefined,
    api: typeof msg.api === 'string' ? msg.api : undefined,
    usage: isRecord(msg.usage)
      ? {
          input: typeof msg.usage.input === 'number' ? msg.usage.input : 0,
          output: typeof msg.usage.output === 'number' ? msg.usage.output : 0,
          totalTokens: typeof msg.usage.totalTokens === 'number' ? msg.usage.totalTokens : 0,
        }
      : undefined,
    stopReason: typeof msg.stopReason === 'string' ? msg.stopReason : undefined,
  };
}

function extractContentText(content: unknown): string {
  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .filter((part: unknown) => isRecord(part) && part.type === 'text')
    .map((part: unknown) => {
      if (!isRecord(part)) {
        return '';
      }
      return typeof part.text === 'string' ? part.text : '';
    })
    .join('');
}

function extractAssistantDelta(piEvent: Record<string, unknown>): string {
  const assistantMessageEvent = isRecord(piEvent.assistantMessageEvent) ? piEvent.assistantMessageEvent : null;
  if (!assistantMessageEvent || assistantMessageEvent.type !== 'text_delta') {
    return '';
  }

  return typeof assistantMessageEvent.delta === 'string' ? assistantMessageEvent.delta : '';
}

function toLangSmithTokenUsage(
  usage:
    | {
        input: number;
        output: number;
        totalTokens: number;
      }
    | undefined,
): LangSmithTokenUsage | undefined {
  if (!usage) {
    return undefined;
  }

  return {
    input_tokens: usage.input,
    output_tokens: usage.output,
    total_tokens: usage.totalTokens,
  };
}

function appendCompletedText(existingText: string, newText: string): string {
  if (!newText) {
    return existingText;
  }
  if (!existingText) {
    return newText;
  }
  return `${existingText}\n${newText}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
