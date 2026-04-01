import type { CTXMillConfig, ResolvedConfig } from './types.js';
import { resolveConfig } from './resolve.js';
import { createKnowledgeStoreFromConfig, createLLMProviderFromConfig } from './factories.js';
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
import { LearningEventSubscriber } from '../learning/event-subscriber.js';
import { SuspendedSessionMatcher } from '../orchestrator/suspended-session-matcher.js';
import { EventTriggerManager } from '../events/trigger-manager.js';
import { AgentSessionService } from '../orchestrator/agent-session-service.js';
import { CallbackDispatcher } from '../orchestrator/callback-dispatcher.js';
import { ManifestService } from '../manifest/index.js';
import { CachedPostgresSecretProvider } from '../secrets/postgres-provider.js';
import { deriveKey } from '../secrets/crypto.js';
import type { SecretProvider } from '../secrets/types.js';
import { ContainerManager } from '../sandbox/container-manager.js';
import { WorkspaceDiffService } from '../sandbox/workspace-diff.js';
import { SystemSettingsService } from '../settings/service.js';
import { ContainerLifecyclePolicy } from '../orchestrator/container-lifecycle-policy.js';
import { SessionTurnService } from '../orchestrator/session-turn-service.js';
import type { SandboxSessionManager } from '../orchestrator/session-turn-service.js';
import { SandboxSessionManager as SandboxSessionManagerImpl } from '../orchestrator/sandbox-session-manager.js';
import { DefaultToolRegistry } from '../tool/registry.js';
import { LocalToolProvider } from '../tool/providers/local.js';
import { ArtifactToolProvider } from '../tool/providers/artifact.js';
import { builtinTools, builtinToolNames } from '../tool/builtin/index.js';
import { createCtxmillGuideTool } from '../tool/builtin/ctxmill-guide.js';
import { ORCHESTRATOR_TOOLS, DAEMON_TOOLS } from '../tool/metadata.js';
import { zodToJsonSchema } from '../tool/schema-convert.js';
import { ArtifactStore } from '../artifact/artifact-store.js';

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
  learningSubscriber?: LearningEventSubscriber;
  suspendedSessionMatcher: SuspendedSessionMatcher;
  triggerManager: EventTriggerManager;
  agentSessionService: AgentSessionService;
  harnessRegistry: HarnessRegistry;
  manifestService: ManifestService;
  secretProvider: SecretProvider;
  callbackDispatcher: CallbackDispatcher;
  /** Container manager for sandbox container lifecycle. */
  containerManager: ContainerManager;
  workspaceDiffService: WorkspaceDiffService;
  settingsService: SystemSettingsService;
  lifecyclePolicy: ContainerLifecyclePolicy;
  artifactStore?: ArtifactStore;
  /** Sandbox session manager (typed as implementation for reconciliation). */
  sessionManager: SandboxSessionManagerImpl;
  /** Gracefully close database connections */
  close: () => Promise<void>;
}

export const VALID_WEBHOOK_EVENTS = ['turn.started', 'turn.completed', 'run.tool_started', 'run.tool_result', 'run.interrupted', 'run.interrupt_resolved'] as const;

type EnqueueCallbackArgs = Parameters<CallbackDispatcher['enqueue']>[0];

async function enqueueIfSubscribed(
  db: DatabaseRepository,
  callbackDispatcher: CallbackDispatcher,
  agentId: string,
  eventType: string,
  payload: Record<string, unknown>,
  sessionId?: string,
): Promise<void> {
  const deliveries: EnqueueCallbackArgs[] = [];

  const hooks = await db.getWebhooksForAgent(agentId);
  for (const hook of hooks) {
    if ((hook.events as string[]).includes(eventType)) {
      deliveries.push({ agentId, sessionId, callbackUrl: hook.url, eventType, payload });
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
  eventBus.on('turn.completed', async (payload) => {
    try {
      await enqueueIfSubscribed(db, callbackDispatcher, payload.agentId, 'turn.completed', {
        turnId: payload.turnId,
        sessionId: payload.sessionId,
        agentId: payload.agentId,
        conversationId: payload.conversationId,
        status: payload.status,
        error: payload.error,
        durationMs: payload.durationMs,
        timestamp: payload.timestamp,
      }, payload.turnId);
    } catch (err) {
      console.error('[CallbackDispatcher] failed to enqueue turn.completed callback:', err);
    }
  });

  eventBus.on('turn.started', async (payload) => {
    try {
      await enqueueIfSubscribed(db, callbackDispatcher, payload.agentId, 'turn.started', {
        turnId: payload.turnId,
        sessionId: payload.sessionId,
        agentId: payload.agentId,
        conversationId: payload.conversationId,
        mode: payload.mode,
        taskDescription: payload.taskDescription,
        timestamp: payload.timestamp,
      }, payload.turnId);
    } catch (err) {
      console.error('[CallbackDispatcher] failed to enqueue turn.started callback:', err);
    }
  });

  eventBus.on('run.tool_started', async (payload) => {
    try {
      await enqueueIfSubscribed(db, callbackDispatcher, payload.agentId, 'run.tool_started', {
        turnId: payload.turnId,
        agentId: payload.agentId,
        toolCallId: payload.toolCallId,
        toolName: payload.toolName,
        args: payload.args,
        timestamp: payload.timestamp,
      }, payload.turnId);
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
  const settingsService = new SystemSettingsService(db);
  const startupSettings = await settingsService.getAll();

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
  const ctxmillGuideTool = createCtxmillGuideTool({
    listTools: () => toolExecutor.list(),
  });
  toolExecutor.register(ctxmillGuideTool);
  const toolRegistry = new DefaultToolRegistry();
  toolRegistry.addProvider(new LocalToolProvider(toolExecutor));

  let artifactStore: ArtifactStore | undefined;
  const s3Endpoint = process.env.S3_ENDPOINT;
  const s3PublicEndpoint = process.env.S3_PUBLIC_ENDPOINT;
  const s3AccessKey = process.env.S3_ACCESS_KEY;
  const s3SecretKey = process.env.S3_SECRET_KEY;
  const s3Bucket = process.env.S3_BUCKET || 'ctxmill-artifacts';
  const s3Region = process.env.S3_REGION || 'us-east-1';

  if (s3Endpoint && s3AccessKey && s3SecretKey) {
    artifactStore = new ArtifactStore({
      s3Endpoint,
      s3PublicEndpoint,
      s3Region,
      s3AccessKey,
      s3SecretKey,
      bucket: s3Bucket,
    });
    await artifactStore.ensureBucket();
    toolRegistry.addProvider(new ArtifactToolProvider());
  }

  await toolRegistry.refresh();

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
  const suspendedSessionMatcher = new SuspendedSessionMatcher(eventBus, db, async (condition, _triggerEvent) => {
    console.log(`[SuspendedSessionMatcher] resuming session ${condition.sessionId} for agent ${condition.agentId} (event: ${condition.eventType})`);
  });

  // ── Harness Registry ────────────────────────────────────
  // All harnesses are now stateless — they resolve dependencies from
  // HarnessRunConfig at runtime, so no orchestrator objects are needed.
  const harnessRegistry = new DefaultHarnessRegistry();
  harnessRegistry.register(new LangGraphHarness());
  harnessRegistry.register(new ClaudeAgentsHarness());
  harnessRegistry.register(new PIAgentHarness());

  // ── Agent Execution ─────────────────────────────────────
  // ── Agent Run Service ────────────────────────────────────
  // Lazy ref so the onFire callback (defined below) can access it after construction.
  let agentSessionServiceRef: AgentSessionService | null = null;

  // ── Event Triggers ─────────────────────────────────────
  const triggerManager = new EventTriggerManager(eventBus, db, async (agentId, task, triggerId) => {
    const agent = await db.getAgent(agentId);
    if (!agent) {
      console.error(`[EventTriggerManager] agent ${agentId} not found for trigger ${triggerId}`);
      return;
    }
    // Create conversation + session for the triggered background session
    const conv = await db.createConversation(agentId);
    sessionManagerRef?.checkConcurrencyLimit(agentId);
    const session = await db.createTurn({
      agentId,
      conversationId: conv.id,
      mode: 'background',
      taskDescription: task,
    });

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
    } catch {
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

    // Fire-and-forget — AgentSessionService handles SSE broadcasting, run.text_chunk events,
    // message persistence, session completion, and learning traces.
    void agentSessionServiceRef!.executeSession({
      agentDef,
      messages,
        agentId,
        conversationId: conv.id,
        sessionId: session.id,
        mode: 'background',
        taskDescription: task,
      }).then(() => {
      // Emit trigger.fired event after successful run
      eventBus.emit('trigger.fired', {
        triggerId,
        agentId,
        eventType: 'trigger.fired',
        turnId: session.id,
        timestamp: Date.now(),
      });
    }).catch((err) => {
      console.error(`[event-trigger] executeSession failed for agent ${agentId}:`, err);
    });
  }, startupSettings.maxTriggerDepth);
  await triggerManager.start();

  // ── Sandbox Run Service ─────────────────────────────────
  const containerManager = new ContainerManager({
    maxGlobalContainers: startupSettings.maxGlobalContainers,
    queueTimeoutMs: startupSettings.queueTimeoutMs,
    defaultCpus: startupSettings.defaultCpus,
    defaultMemoryMb: startupSettings.defaultMemoryMb,
    defaultPidsLimit: startupSettings.defaultPidsLimit,
    defaultTimeoutSec: startupSettings.defaultTimeoutSec,
  });
  // Ensure the Docker bridge network exists before any containers are created.
  // This is best-effort — if Docker is not available (e.g. in tests), the
  // container manager will still function; sandbox runs will fail at runtime.
  try {
    await containerManager.ensureNetwork();
  } catch (err) {
    console.warn('[Container] Docker network setup failed (sandbox runs will not work):', (err as Error).message);
  }
  const workspaceDiffService = new WorkspaceDiffService({
    containerManager,
    settingsService,
  });

  let sessionManagerRef: SandboxSessionManagerImpl | null = null;

  const lifecyclePolicy = new ContainerLifecyclePolicy({
    containerManager,
    db,
    logger: {
      info: (msg, ...args) => console.log('[LifecyclePolicy]', msg, ...args),
      warn: (msg, ...args) => console.warn('[LifecyclePolicy]', msg, ...args),
      error: (msg, ...args) => console.error('[LifecyclePolicy]', msg, ...args),
      debug: (msg, ...args) => console.debug('[LifecyclePolicy]', msg, ...args),
    },
    config: {
      reconciliationIntervalMs: startupSettings.reconciliationIntervalMs,
      pauseDelayMs: startupSettings.pauseDelayMs,
      maxPauseDurationMs: startupSettings.maxPauseDurationMs,
      idleTimeoutMs: startupSettings.idleTimeoutMs,
      freezePromotionMs: startupSettings.freezePromotionMs,
    },
    onPromoteToCheckpoint: async (sessionId: string) => {
      if (!sessionManagerRef) {
        throw new Error('onPromoteToCheckpoint: session manager not initialized');
      }
      await sessionManagerRef.suspendSession(sessionId, 'hitl-promotion');
      interruptManager.resolveForSession(sessionId, 'timeout', 'Approval timed out — session checkpointed by lifecycle policy');
    },
    reconciliationCallbacks: {
      onSessionReconnected: (session, grpcClient) => {
        if (sessionManagerRef) {
          sessionManagerRef.onSessionReconnected(session.conversationId, {
            sessionId: session.id,
            conversationId: session.conversationId,
            agentId: session.agentId,
            containerName: session.containerName ?? '',
            containerId: session.containerId ?? '',
            status: (session.status as 'ACTIVE' | 'PAUSED' | 'CHECKPOINTED' | 'RESTORING' | 'TERMINATED') ?? 'ACTIVE',
            harnessName: session.harnessName,
            ...(grpcClient ? { grpcClient } : {}),
          });
        }
      },
      onSessionEvicted: (sessionId, conversationId) => {
        if (sessionManagerRef) {
          sessionManagerRef.onSessionEvicted(sessionId, conversationId);
        }
      }
    },
  });

  // ── Sandbox Secrets (allowlisted env vars for container injection) ──
  const SANDBOX_SECRET_ALLOWLIST = [
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'GOOGLE_API_KEY',
    'OPENAI_BASE_URL',
    'OPENAI_MODEL',
    'S3_ENDPOINT',
    'S3_ACCESS_KEY',
    'S3_SECRET_KEY',
    'S3_BUCKET',
    'S3_REGION',
    'LANGSMITH_TRACING',
    'LANGSMITH_API_KEY',
    'LANGSMITH_PROJECT',
    'LANGSMITH_WORKSPACE_ID',
  ] as const;

  const sandboxSecrets: Readonly<Record<string, string>> = Object.fromEntries(
    SANDBOX_SECRET_ALLOWLIST
      .filter((key) => process.env[key])
      .map((key) => [key, process.env[key]!]),
  );

  const resolveToolsForAgent = (toolNames: string[], excludeBuiltins?: string[]) => {
    const declaredTools = new Set(toolNames);
    const excluded = excludeBuiltins ? new Set(excludeBuiltins) : undefined;
    const allTools = new Map<string, { name: string; description: string; input: unknown; requiresApproval?: boolean; location?: 'sandbox' | 'orchestrator' | 'daemon'; programmatic?: boolean }>();

    for (const tool of toolExecutor.list()) {
      if (declaredTools.has(tool.name) || builtinToolNames.has(tool.name)) {
        allTools.set(tool.name, tool);
      }
    }
    for (const tool of toolRegistry.listForAgent(toolNames)) {
      allTools.set(tool.name, tool);
    }

    if (excluded) {
      for (const name of excluded) {
        if (builtinToolNames.has(name)) allTools.delete(name);
      }
    }

  return Array.from(allTools.values()).map((tool) => {
      const isDaemon = DAEMON_TOOLS.has(tool.name) || tool.location === 'daemon';
      const isOrchestrator = !isDaemon && (tool.location === 'orchestrator' || ORCHESTRATOR_TOOLS.has(tool.name) || tool.requiresApproval);
      let inputSchemaJson = '{"type":"object","properties":{}}';
      try {
        const schema = zodToJsonSchema(tool.input as any) as Record<string, unknown>;
        if (schema.type === 'object') {
          inputSchemaJson = JSON.stringify(schema);
        }
      } catch {
        inputSchemaJson = '{"type":"object","properties":{}}';
      }
      return {
        name: tool.name,
        description: tool.description,
        inputSchemaJson,
        location: isDaemon ? 3 : isOrchestrator ? 2 : 1,
        programmatic: tool.programmatic ?? false,
      };
    });
  };

  const realSessionManagerDeps: ConstructorParameters<typeof SandboxSessionManagerImpl>[0] = {
    containerManager,
    db,
    lifecyclePolicy,
    eventBus,
    maxConcurrentSessionsPerAgent: startupSettings.maxConcurrentRunsPerAgent,
    interruptManager,
    sandboxSecrets,
    resolveToolsForAgent,
    dataDir,
    workspaceDiffService,
    logger: {
      info: (msg: string, ...args: unknown[]) => console.log('[SessionManager]', msg, ...args),
      warn: (msg: string, ...args: unknown[]) => console.warn('[SessionManager]', msg, ...args),
      error: (msg: string, ...args: unknown[]) => console.error('[SessionManager]', msg, ...args),
      debug: (msg: string, ...args: unknown[]) => console.debug('[SessionManager]', msg, ...args),
    },
    config: {
      idleTimeoutMs: startupSettings.idleTimeoutMs,
      maxQueuedMessages: 100,
      turnTimeoutMs: startupSettings.turnTimeoutMs,
    },
  };

  const realSessionManager = new SandboxSessionManagerImpl(realSessionManagerDeps);

  const sessionManager: SandboxSessionManager = realSessionManager;
  sessionManagerRef = realSessionManager;

  const sessionTurnService = new SessionTurnService({
    sessionManager,
    eventBus,
    onSessionReady: (agentSessionId, sandboxSessionId) => {
      void db.updateTurn(agentSessionId, { sessionId: sandboxSessionId });
    },
  });

  const agentSessionService = new AgentSessionService({
    sse: sseManager,
    db,
    sessionManager: realSessionManager,
    learningPipeline,
    eventBus,
    sessionTurnService,
    toolExecutor,
    toolRegistry,
  });
  agentSessionServiceRef = agentSessionService;

  const manifestService = new ManifestService(db, dataDir);

  // ── Callback Dispatcher ──────────────────────────────────
  const callbackDispatcher = new CallbackDispatcher(db);

  registerCallbackSubscriptions(eventBus, db, callbackDispatcher);

  callbackDispatcher.start();

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
    learningSubscriber,
    suspendedSessionMatcher,
    triggerManager,
    agentSessionService,
    harnessRegistry,
    manifestService,
    secretProvider,
    callbackDispatcher,
    containerManager,
    workspaceDiffService,
    settingsService,
    lifecyclePolicy,
    artifactStore,
    sessionManager: realSessionManager,
    close: async () => {
      lifecyclePolicy.stop();
      callbackDispatcher.stop();
      await dbConn.close();
    },
  };
}
