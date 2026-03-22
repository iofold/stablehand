import type { CTXMillConfig, ResolvedConfig } from './types.js';
import { resolveConfig } from './resolve.js';
import { createKnowledgeStoreFromConfig, createLLMProviderFromConfig, createEnvironmentFactory } from './factories.js';
import { createDatabase, type DatabaseConnection } from '../database/connection.js';
import { runMigrations } from '../database/migrations.js';
import { DatabaseRepository } from '../database/repository.js';
import type { KnowledgeStore, ContextProvider } from '../knowledge/types.js';
import { InMemoryContextProvider } from '../knowledge/context.js';
import type { LLMProvider } from '../llm/types.js';
import { LocalFunctionExecutor } from '../tool/executor.js';
import { DefaultHarnessRegistry } from '../harness/registry.js';
import { LangGraphHarness } from '../harness/langgraph.js';
import { ClaudeAgentsHarness } from '../harness/claude-agents.js';
import { PIAgentHarness } from '../harness/pi-agent.js';
import type { HarnessRegistry } from '../harness/types.js';
import { TypedEventBus } from '../events/bus.js';
import { SimpleReflector } from '../learning/reflector.js';
import type { LearningPipeline } from '../learning/types.js';
import { DefaultLearningPipeline } from '../learning/pipeline.js';
import { SSEManager } from '../orchestrator/sse.js';
import { SSEBroadcaster } from '../orchestrator/sse-broadcaster.js';
import { InterruptManager } from '../orchestrator/interrupt.js';
import { RunRegistry } from '../orchestrator/run-registry.js';
import { LearningEventSubscriber } from '../learning/event-subscriber.js';
import { SuspendedRunMatcher } from '../orchestrator/suspended-run-matcher.js';
import { EventTriggerManager } from '../events/trigger-manager.js';
import type { EnvironmentFactory } from '../workspace/types.js';
import { AgentRunService } from '../orchestrator/agent-run-service.js';
import { CallbackDispatcher } from '../orchestrator/callback-dispatcher.js';
import type { EnqueueCallbackOpts } from '../orchestrator/callback-dispatcher.js';
import { ManifestService } from '../manifest/index.js';
import { CachedPostgresSecretProvider } from '../secrets/postgres-provider.js';
import { deriveKey } from '../secrets/crypto.js';
import type { SecretProvider } from '../secrets/types.js';
import { ContainerManager } from '../sandbox/container-manager.js';
import { OrphanCleanup } from '../sandbox/orphan-cleanup.js';
import { PauseManager } from '../sandbox/pause-manager.js';
import { SandboxRunService } from '../orchestrator/sandbox-run-service.js';
import type { SandboxSessionManager } from '../orchestrator/sandbox-run-service.js';
import { SandboxSessionManager as SandboxSessionManagerImpl } from '../orchestrator/sandbox-session-manager.js';
import { DefaultToolRegistry } from '../tool/registry.js';
import { builtinTools, builtinToolNames } from '../tool/builtin/index.js';
import { ORCHESTRATOR_TOOLS } from '../tool/metadata.js';
import { zodToJsonSchema } from '../tool/schema-convert.js';

export interface AppContainer {
  config: ResolvedConfig;
  db: DatabaseRepository;
  knowledgeStore: KnowledgeStore;
  contextProvider: ContextProvider;
  llmProvider: LLMProvider | null;
  toolExecutor: LocalFunctionExecutor;
  toolRegistry: DefaultToolRegistry;
  eventBus: TypedEventBus;
  learningPipeline?: LearningPipeline;
  sseManager: SSEManager;
  sseBroadcaster: SSEBroadcaster;
  interruptManager: InterruptManager;
  runRegistry: RunRegistry;
  learningSubscriber?: LearningEventSubscriber;
  suspendedRunMatcher: SuspendedRunMatcher;
  triggerManager: EventTriggerManager;
  envFactory: EnvironmentFactory;
  agentRunService: AgentRunService;
  harnessRegistry: HarnessRegistry;
  manifestService: ManifestService;
  secretProvider: SecretProvider;
  callbackDispatcher: CallbackDispatcher;
  /** Container manager for sandbox container lifecycle. */
  containerManager: ContainerManager;
  /** Orphan container cleanup service. */
  orphanCleanup: OrphanCleanup;
  /** Gracefully close database connections */
  close: () => Promise<void>;
}

export const VALID_WEBHOOK_EVENTS = ['run.started', 'run.completed', 'run.tool_started', 'run.tool_result', 'run.interrupted', 'run.interrupt_resolved'] as const;

async function enqueueIfSubscribed(
  db: DatabaseRepository,
  callbackDispatcher: CallbackDispatcher,
  agentId: string,
  eventType: string,
  payload: Record<string, unknown>,
  runId?: string,
): Promise<void> {
  const deliveries: EnqueueCallbackOpts[] = [];

  const hooks = await db.getWebhooksForAgent(agentId);
  for (const hook of hooks) {
    if ((hook.events as string[]).includes(eventType)) {
      deliveries.push({ agentId, runId, callbackUrl: hook.url, eventType, payload });
    }
  }

  for (const delivery of deliveries) {
    await callbackDispatcher.enqueue(delivery);
  }
}

export function registerCallbackSubscriptions(
  eventBus: TypedEventBus,
  db: DatabaseRepository,
  callbackDispatcher: CallbackDispatcher,
): void {
  eventBus.on('run.completed', async (payload) => {
    try {
      await enqueueIfSubscribed(db, callbackDispatcher, payload.agentId, 'run.completed', {
        runId: payload.runId,
        agentId: payload.agentId,
        conversationId: payload.conversationId,
        status: payload.status,
        error: payload.error,
        durationMs: payload.durationMs,
        timestamp: payload.timestamp,
      }, payload.runId);
    } catch (err) {
      console.error('[CallbackDispatcher] failed to enqueue run.completed callback:', err);
    }
  });

  eventBus.on('run.started', async (payload) => {
    try {
      await enqueueIfSubscribed(db, callbackDispatcher, payload.agentId, 'run.started', {
        runId: payload.runId,
        agentId: payload.agentId,
        conversationId: payload.conversationId,
        mode: payload.mode,
        taskDescription: payload.taskDescription,
        timestamp: payload.timestamp,
      }, payload.runId);
    } catch (err) {
      console.error('[CallbackDispatcher] failed to enqueue run.started callback:', err);
    }
  });

  eventBus.on('run.tool_started', async (payload) => {
    try {
      await enqueueIfSubscribed(db, callbackDispatcher, payload.agentId, 'run.tool_started', {
        runId: payload.runId,
        agentId: payload.agentId,
        toolCallId: payload.toolCallId,
        toolName: payload.toolName,
        args: payload.args,
        timestamp: payload.timestamp,
      }, payload.runId);
    } catch (err) {
      console.error('[CallbackDispatcher] failed to enqueue run.tool_started callback:', err);
    }
  });
}

/**
 * Build the application dependency graph. This is the single composition root
 * that wires every provider. PostgreSQL is always used as the database backend.
 *
 * @param userConfig - Partial config supplied by the user (or defineConfig)
 * @param dataDir    - Root directory for persisted data (knowledge, audit)
 */
export async function createContainer(
  userConfig: CTXMillConfig,
  dataDir: string,
): Promise<AppContainer> {
  const config = resolveConfig(userConfig);

  // ── Database ────────────────────────────────────────────
  const dbConn: DatabaseConnection = await createDatabase(config.database.url);

  // Run migrations
  await runMigrations(dbConn.pgClient);

  const db = new DatabaseRepository(dbConn.db);

  // ── Secrets ─────────────────────────────────────────────
  const secretMasterKey = deriveKey(
    process.env.SECRET_MASTER_KEY || 'ctxmill-dev-key-change-in-prod',
  );
  const secretProvider: SecretProvider = await CachedPostgresSecretProvider.create(
    dbConn.pgClient,
    secretMasterKey,
  );

  // ── Knowledge ───────────────────────────────────────────
  const knowledgeStore = createKnowledgeStoreFromConfig(config, dataDir);
  const contextProvider = new InMemoryContextProvider();

  // ── LLM ──────────────────────────────────────────────────
  // Global LLM provider is only used for the learning reflector.
  // Agent harnesses resolve their own keys from the secrets pipeline.
  const llmProvider = createLLMProviderFromConfig(config);

  // ── Tools ───────────────────────────────────────────────
  const toolExecutor = new LocalFunctionExecutor();
  // Register built-in tools so resolveToolsForAgent() can find them.
  // Without this, builtinToolNames acts as a filter that matches nothing.
  for (const tool of builtinTools) {
    toolExecutor.register(tool);
  }
  const toolRegistry = new DefaultToolRegistry();

  // ── Events ──────────────────────────────────────────────
  const eventBus = new TypedEventBus({
    persistEvent: (type, agentId, payload) => {
      try {
        db.saveEvent(type, agentId, payload);
      } catch (err) {
        console.error('[EventBus] persist error:', err);
      }
    },
  });

  // ── Learning ────────────────────────────────────────────
  // Learning pipeline is optional — disabled when no global LLM key is configured.
  let learningPipeline: LearningPipeline | undefined;
  if (llmProvider) {
    const reflector = new SimpleReflector(llmProvider);
    learningPipeline = new DefaultLearningPipeline(reflector, knowledgeStore, db, eventBus);
  } else {
    console.warn('[Container] Learning pipeline disabled — no global LLM API key configured');
  }

  // ── SSE + Interrupts ───────────────────────────────────
  const sseManager = new SSEManager(eventBus);
  const sseBroadcaster = new SSEBroadcaster(sseManager, eventBus);
  const interruptManager = new InterruptManager(eventBus, db);
  await interruptManager.loadFromDb();

  // ── Event Subscribers ─────────────────────────────────
  const learningSubscriber = learningPipeline
    ? new LearningEventSubscriber(learningPipeline, eventBus, db)
    : undefined;

  // ── Suspend/Resume ──────────────────────────────────────
  const suspendedRunMatcher = new SuspendedRunMatcher(eventBus, db, async (condition, _triggerEvent) => {
    console.log(`[SuspendedRunMatcher] resuming run ${condition.runId} for agent ${condition.agentId} (event: ${condition.eventType})`);
    try {
      await db.updateRun(condition.runId, { status: 'running' });
    } catch (err) {
      console.error(`[SuspendedRunMatcher] failed to update run status for ${condition.runId}:`, err);
    }
  });

  // ── Workspace Environment ────────────────────────────────
  const envFactory: EnvironmentFactory = createEnvironmentFactory(config.execution.type);

  // ── Harness Registry ────────────────────────────────────
  // All harnesses are now stateless — they resolve dependencies from
  // HarnessRunConfig at runtime, so no orchestrator objects are needed.
  const harnessRegistry = new DefaultHarnessRegistry();
  harnessRegistry.register(new LangGraphHarness());
  harnessRegistry.register(new ClaudeAgentsHarness());
  harnessRegistry.register(new PIAgentHarness());

  // ── Agent Execution ─────────────────────────────────────
  const runRegistry = new RunRegistry(db, eventBus);
  await runRegistry.loadFromDb();

  // ── Agent Run Service ────────────────────────────────────
  // Lazy ref so the onFire callback (defined below) can access it after construction.
  let agentRunServiceRef: AgentRunService | null = null;

  // ── Event Triggers ─────────────────────────────────────
  const triggerManager = new EventTriggerManager(eventBus, db, async (agentId, task, triggerId) => {
    const agent = await db.getAgent(agentId);
    if (!agent) {
      console.error(`[EventTriggerManager] agent ${agentId} not found for trigger ${triggerId}`);
      return;
    }
    // Create conversation + run for the triggered background run
    const conv = await db.createConversation(agentId);
    const run = await runRegistry.startRun(agentId, conv.id, 'background', task);

    // Persist the synthetic user message
    await db.addMessage({ agentId, conversationId: conv.id, role: 'user', content: task });
    const allMessages = await db.getMessages(conv.id);
    const messages = allMessages.map((m) => ({
      id: m.id,
      agentId: m.agentId ?? agentId,
      role: m.role as 'user' | 'assistant' | 'system',
      content: m.content,
      toolCallId: m.toolCallId ?? undefined,
      createdAt: new Date(m.createdAt),
    }));

    let parsedHarnessConfig: Record<string, unknown> = {};
    try {
      const rawHarnessConfig = JSON.parse(agent.harnessConfig);
      if (typeof rawHarnessConfig === 'object' && rawHarnessConfig !== null && !Array.isArray(rawHarnessConfig)) {
        parsedHarnessConfig = rawHarnessConfig as Record<string, unknown>;
      }
    } catch (_err) {
      parsedHarnessConfig = {};
    }

    // Extract per-agent resourceLimits from the manifest
    const manifest = agent.manifest as Record<string, unknown> | null;
    const perAgentResourceLimits = manifest?.resourceLimits as import('../types.js').AgentResourceLimits | undefined;

    const agentDef: import('../types.js').AgentDefinition = {
      name: agent.name,
      harness: agent.harness,
      harnessConfig: parsedHarnessConfig,
      systemPrompt: agent.systemPrompt,
      tools: agent.tools,
      description: agent.description ?? undefined,
      metadata: agent.metadata ?? undefined,
      workspaceDir: agent.workspaceDir ?? undefined,
      resourceLimits: perAgentResourceLimits,
    };

    // Fire-and-forget — AgentRunService handles SSE broadcasting, run.text_chunk events,
    // message persistence, run completion, and learning traces.
    void agentRunServiceRef!.executeRun({
      agentDef,
      messages,
      agentId,
      conversationId: conv.id,
      runId: run.id,
      taskDescription: task,
    }).then(() => {
      // Emit trigger.fired event after successful run
      eventBus.emit('trigger.fired', {
        triggerId,
        agentId,
        eventType: 'trigger.fired',
        runId: run.id,
        timestamp: Date.now(),
      });
    }).catch((err) => {
      console.error(`[EventTriggerManager] run error for trigger ${triggerId}:`, err);
    });
  });
  await triggerManager.start();

  // ── Sandbox Run Service ─────────────────────────────────
  const containerManager = new ContainerManager({
    maxGlobalContainers: config.execution.maxGlobalContainers,
  });
  // Ensure the Docker bridge network exists before any containers are created.
  // This is best-effort — if Docker is not available (e.g. in tests), the
  // container manager will still function; sandbox runs will fail at runtime.
  try {
    await containerManager.ensureNetwork();
  } catch (err) {
    console.warn('[Container] Docker network setup failed (sandbox runs will not work):', (err as Error).message);
  }

  const pauseManager = new PauseManager({
    containerManager,
  });

  // ── Sandbox Secrets (allowlisted env vars for container injection) ──
  const SANDBOX_SECRET_ALLOWLIST = [
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'GOOGLE_API_KEY',
    'OPENAI_BASE_URL',
    'OPENAI_MODEL',
  ] as const;

  const sandboxSecrets: Readonly<Record<string, string>> = Object.fromEntries(
    SANDBOX_SECRET_ALLOWLIST
      .filter((key) => process.env[key])
      .map((key) => [key, process.env[key]!]),
  );

  const resolveToolsForAgent = (toolNames: string[]) => {
    const declaredTools = new Set(toolNames);
    const allTools = new Map<string, { name: string; description: string; input: unknown; requiresApproval?: boolean }>();

    for (const tool of toolExecutor.list()) {
      if (declaredTools.has(tool.name) || builtinToolNames.has(tool.name)) {
        allTools.set(tool.name, tool);
      }
    }
    for (const tool of toolRegistry.listForAgent(toolNames)) {
      allTools.set(tool.name, tool);
    }

    return Array.from(allTools.values()).map((tool) => {
      const isOrchestrator = ORCHESTRATOR_TOOLS.has(tool.name) || tool.requiresApproval;
      let inputSchemaJson = '{"type":"object","properties":{}}';
      try {
        const schema = zodToJsonSchema(tool.input as any) as Record<string, unknown>;
        if (schema.type === 'object') {
          inputSchemaJson = JSON.stringify(schema);
        }
      } catch {}
      return {
        name: tool.name,
        description: tool.description,
        inputSchemaJson,
        location: isOrchestrator ? 2 : 1,
      };
    });
  };

  const realSessionManager = new SandboxSessionManagerImpl({
    containerManager,
    db,
    pauseManager,
    sandboxSecrets,
    resolveToolsForAgent,
    logger: {
      info: (msg, ...args) => console.log('[SessionManager]', msg, ...args),
      warn: (msg, ...args) => console.warn('[SessionManager]', msg, ...args),
      error: (msg, ...args) => console.error('[SessionManager]', msg, ...args),
      debug: (msg, ...args) => console.debug('[SessionManager]', msg, ...args),
    },
    config: {
      idleTimeoutMs: 300_000,
      maxQueuedMessages: 100,
    },
  });

  const sessionManager: SandboxSessionManager = realSessionManager;

  const sandboxRunService = new SandboxRunService({
    sessionManager,
    eventBus,
  });

  const agentRunService = new AgentRunService({
    sse: sseManager,
    db,
    runRegistry,
    learningPipeline,
    eventBus,
    sandboxRunService,
    toolExecutor,
    toolRegistry,
  });
  agentRunServiceRef = agentRunService;

  const manifestService = new ManifestService(db);

  // ── Callback Dispatcher ──────────────────────────────────
  const callbackDispatcher = new CallbackDispatcher(db);

  registerCallbackSubscriptions(eventBus, db, callbackDispatcher);

  callbackDispatcher.start();

  // ── Orphan Cleanup ─────────────────────────────────────
  const orphanCleanup = new OrphanCleanup({
    containerManager,
    getActiveRunIds: async () => {
      const activeRuns = await db.getActiveRuns();
      return new Set(activeRuns.map((r) => r.id));
    },
    markRunFailed: async (runId: string, error: string) => {
      await db.updateRun(runId, { status: 'failed', error });
    },
  });

  return {
    config,
    db,
    knowledgeStore,
    contextProvider,
    llmProvider,
    toolExecutor,
    toolRegistry,
    eventBus,
    learningPipeline,
    sseManager,
    sseBroadcaster,
    interruptManager,
    runRegistry,
    learningSubscriber,
    suspendedRunMatcher,
    triggerManager,
    envFactory,
    agentRunService,
    harnessRegistry,
    manifestService,
    secretProvider,
    callbackDispatcher,
    containerManager,
    orphanCleanup,
    close: async () => {
      orphanCleanup.stopPeriodicSweep();
      callbackDispatcher.stop();
      await dbConn.close();
    },
  };
}
