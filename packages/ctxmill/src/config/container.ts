import type { CTXMillConfig, ResolvedConfig } from './types.js';
import { createHash } from 'node:crypto';
import { resolveConfig } from './resolve.js';
import { createDatabase, type DatabaseConnection } from '../database/connection.js';
import { runMigrations } from '../database/migrations.js';
import { DatabaseRepository } from '../database/repository.js';
import { LocalFunctionExecutor } from '../tool/executor.js';
import { DefaultHarnessRegistry } from '../harness/registry.js';
import { LangGraphHarness } from '../harness/langgraph.js';
import { ClaudeAgentsHarness } from '../harness/claude-agents.js';
import { PIAgentHarness } from '../harness/pi-agent.js';
import type { HarnessRegistry } from '../harness/types.js';
import { TypedEventBus } from '../events/bus.js';
import { SSEManager } from '../orchestrator/sse.js';
import { InterruptManager } from '../orchestrator/interrupt.js';
import { createTriggerSpineConsumer, EventTriggerManager, type TriggerRunCallback } from '../events/trigger-manager.js';
import { SpineConsumerRunner } from '../events/spine-consumer-runner.js';
import { AgentSessionService } from '../orchestrator/agent-session-service.js';
import { CallbackDispatcher } from '../orchestrator/callback-dispatcher.js';
import { createGuardedFetch } from '../util/egress.js';
import { createWebhookRelaySpineConsumer } from '../orchestrator/webhook-relay.js';
import { RunStartupService } from '../orchestrator/run-startup-service.js';
import { TurnFinalizer } from '../orchestrator/turn-finalizer.js';
import { reconcileStrandedTurnsOnStartup } from '../orchestrator/turn-reconciler.js';
import { CanonicalLog } from '../orchestrator/canonical/canonical-log.js';
import { formatNativeLegacy } from '../orchestrator/canonical/format-native-legacy.js';
import { PostgresSecretProvider } from '../secrets/postgres-provider.js';
import { deriveKey } from '../secrets/crypto.js';
import { resolveSecretMasterKeyPassphrase } from '../secrets/master-key.js';
import type { SecretProvider } from '../secrets/types.js';
import { ContainerManager, type SandboxContainerManager } from '../sandbox/container-manager.js';
import { KubernetesContainerManager } from '../sandbox/kubernetes-container-manager.js';
import { WorkspaceDiffService } from '../sandbox/workspace-diff.js';
import { SystemSettingsService } from '../settings/service.js';
import { ContainerLifecyclePolicy } from '../orchestrator/container-lifecycle-policy.js';
import { SessionTurnService } from '../orchestrator/session-turn-service.js';
import type { SandboxSessionManager } from '../orchestrator/session-turn-service.js';
import { SandboxSessionManager as SandboxSessionManagerImpl } from '../orchestrator/sandbox-session-manager.js';
import { SessionStateStore } from '../orchestrator/session-manager/session-state-store.js';
import { SessionStatusCoordinator } from '../orchestrator/session-manager/session-status-coordinator.js';
import { DefaultToolRegistry } from '../tool/registry.js';
import { LocalToolProvider } from '../tool/providers/local.js';
import { ArtifactToolProvider } from '../tool/providers/artifact.js';
import { builtinTools, builtinToolNames } from '../tool/builtin/index.js';
import { createCtxmillGuideTool } from '../tool/builtin/ctxmill-guide.js';
import { resolveToolLocation } from '../tool/metadata.js';
import { zodToJsonSchema } from '../tool/schema-convert.js';
import { ArtifactStore } from '../artifact/artifact-store.js';
import { VALID_WEBHOOK_EVENTS } from '../orchestrator/webhook-events.js';

export interface AppContainer {
  config: ResolvedConfig;
  db: DatabaseRepository;
  toolExecutor: LocalFunctionExecutor;
  toolRegistry: DefaultToolRegistry;
  eventBus: TypedEventBus;
  sseManager: SSEManager;
  interruptManager: InterruptManager;
  triggerManager: EventTriggerManager;
  spineConsumerRunner: SpineConsumerRunner;
  agentSessionService: AgentSessionService;
  harnessRegistry: HarnessRegistry;
  secretProvider: SecretProvider;
  callbackDispatcher: CallbackDispatcher;
  runStartupService: RunStartupService;
  /** Container manager for sandbox lifecycle. */
  containerManager: SandboxContainerManager;
  workspaceDiffService: WorkspaceDiffService;
  settingsService: SystemSettingsService;
  lifecyclePolicy: ContainerLifecyclePolicy;
  /** Durable canonical event spine (ADR-015); serves replay when CTXMILL_CANONICAL_EVENTS=1. */
  canonicalLog: CanonicalLog;
  /** Startup turn reconciliation (ADR-014/ctx-7e3x): fail stranded turns and replay durable queued turns. */
  reconcileStrandedTurns: (bootTimeMs: number) => Promise<{
    failed: number;
    skippedHitlParked: number;
    redispatched: number;
    redispatchComplete: Promise<void>;
  }>;
  artifactStore?: ArtifactStore;
  /** Sandbox session manager (typed as implementation for reconciliation). */
  sessionManager: SandboxSessionManagerImpl;
  /** Gracefully close database connections */
  close: () => Promise<void>;
}

export { VALID_WEBHOOK_EVENTS };

interface TriggerRunCallbackDeps {
  db: Pick<DatabaseRepository, 'getAgent'>;
  runStartupService: Pick<RunStartupService, 'prepareRunStart' | 'launchPreparedRun'>;
  eventBus: Pick<TypedEventBus, 'emit'>;
}

export function createTriggerRunCallback({
  db,
  runStartupService,
  eventBus,
}: TriggerRunCallbackDeps): TriggerRunCallback {
  return async (agentId, task, triggerId, triggerDepth, eventSeq) => {
    const agent = await db.getAgent(agentId);
    if (!agent) {
      console.error(`[EventTriggerManager] agent ${agentId} not found for trigger ${triggerId}`);
      return;
    }
    const requestedTurnId = eventSeq === undefined
      ? undefined
      : `trigger-${createHash('sha256').update(`${triggerId}:${eventSeq}`).digest('hex').slice(0, 24)}`;
    let start: Awaited<ReturnType<RunStartupService['prepareRunStart']>>;
    try {
      start = await runStartupService.prepareRunStart({
        agent,
        agentId,
        content: task,
        mode: 'background',
        emitUserMessageEvent: false,
        ...(requestedTurnId ? { requestedTurnId } : {}),
      });
    } catch (err) {
      if (requestedTurnId && err instanceof Error && err.message.includes(`Turn already exists for id ${requestedTurnId}`)) {
        console.warn(`[EventTriggerManager] trigger ${triggerId} event seq ${eventSeq} already prepared turn ${requestedTurnId}`);
        return;
      }
      throw err;
    }

    // Fire-and-forget — AgentSessionService handles SSE broadcasting, run.text_chunk events,
    // message persistence, and session completion. trigger.fired preserves the cascade
    // depth that EventTriggerManager already computed for this triggered run.
    void runStartupService.launchPreparedRun(start, agentId, {
      onSuccess: () => {
        eventBus.emit('trigger.fired', {
          triggerId,
          agentId,
          eventType: 'trigger.fired',
          turnId: start.turnId,
          ...(triggerDepth === undefined ? {} : { _triggerDepth: triggerDepth }),
          timestamp: Date.now(),
        });
      },
    });
  };
}

/**
 * Build the application dependency graph. This is the single composition root
 * that wires every provider. PostgreSQL is always used as the database backend.
 *
 * @param userConfig - Partial config supplied by the user (or defineConfig)
 * @param dataDir    - Root directory for persisted data and workspaces
 */
export async function createContainer(
  userConfig: CTXMillConfig,
  dataDir: string,
): Promise<AppContainer> {
  const config = resolveConfig(userConfig);
  const secretMasterPassphrase = resolveSecretMasterKeyPassphrase();

  // ── Database ────────────────────────────────────────────
  const dbConn: DatabaseConnection = await createDatabase(config.database.url);

  // Run migrations
  await runMigrations(dbConn.pgClient);

  const db = new DatabaseRepository(dbConn.db);
  const settingsService = new SystemSettingsService(db);
  const startupSettings = await settingsService.getAll();

  // ── Secrets ─────────────────────────────────────────────
  const secretMasterKey = deriveKey(secretMasterPassphrase);
  const secretProvider: SecretProvider = new PostgresSecretProvider(
    dbConn.pgClient,
    secretMasterKey,
  );

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
  const runStartupService = new RunStartupService({
    logger: {
      info: (msg: string, ...args: unknown[]) => console.log('[RunStartupService]', msg, ...args),
      warn: (msg: string, ...args: unknown[]) => console.warn('[RunStartupService]', msg, ...args),
      error: (msg: string, ...args: unknown[]) => console.error('[RunStartupService]', msg, ...args),
      debug: (msg: string, ...args: unknown[]) => console.debug('[RunStartupService]', msg, ...args),
    },
  });

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
  // The canonical event spine (ADR-015) is the only persistence and the only
  // wire source. The bus defers listener dispatch until ingest resolves, so
  // ADR-006 persist-then-dispatch holds.
  const canonicalLog = new CanonicalLog({ db, logger: console });
  const eventBus = new TypedEventBus({
    persistEvent: async (type, _agentId, payload, parsedPayload) => {
      await canonicalLog.ingest(type, parsedPayload ?? JSON.parse(payload) as Record<string, unknown>);
    },
  });

  // ── SSE + Interrupts ───────────────────────────────────
  const sseManager = new SSEManager(eventBus);
  // Run-channel frames feed the native wire with durable seq ids; each client
  // receives its negotiated vocabulary (canonical default, ?wire=legacy).
  canonicalLog.subscribe((frames) => {
    for (const frame of frames) {
      if (frame.channel !== 'run') continue;
      sseManager.broadcastFrame(frame.agentId, {
        legacy: formatNativeLegacy(frame),
        canonical: frame.body,
      }, frame.seq);
    }
  });
  const interruptManager = new InterruptManager(eventBus, db, async (sessionId) => {
    if (sessionManagerRef) {
      await sessionManagerRef.suspendSession(sessionId, 'hitl-timeout', { allowActiveTurn: true });
    }
  });
  await interruptManager.loadFromDb();

  let sessionManagerRef: SandboxSessionManagerImpl | null = null;

  // ── Harness Registry ────────────────────────────────────
  // All harnesses are now stateless — they resolve dependencies from
  // HarnessRunConfig at runtime, so no orchestrator objects are needed.
  const harnessRegistry = new DefaultHarnessRegistry();
  harnessRegistry.register(new LangGraphHarness());
  harnessRegistry.register(new ClaudeAgentsHarness());
  harnessRegistry.register(new PIAgentHarness());

  // ── Event Triggers ─────────────────────────────────────
  // Webhook/callback delivery targets agent-supplied URLs from the trusted
  // orchestrator process; route them through the SSRF egress guard.
  const callbackDispatcher = new CallbackDispatcher(db, undefined, createGuardedFetch());
  const triggerManager = new EventTriggerManager(
    eventBus,
    db,
    createTriggerRunCallback({ db, runStartupService, eventBus }),
    startupSettings.maxTriggerDepth,
  );
  const spineConsumerRunner = new SpineConsumerRunner({
    canonicalLog,
    db,
    consumers: [
      createTriggerSpineConsumer(triggerManager),
      createWebhookRelaySpineConsumer({ db, callbackDispatcher }),
    ],
    logger: console,
  });

  // ── Sandbox Run Service ─────────────────────────────────
  const sandboxRuntime = (process.env.CTXMILL_SANDBOX_RUNTIME ?? 'docker').toLowerCase();
  const containerManager: SandboxContainerManager =
    sandboxRuntime === 'kubernetes' || sandboxRuntime === 'k8s'
      ? new KubernetesContainerManager({
        maxGlobalContainers: startupSettings.maxGlobalContainers,
        queueTimeoutMs: startupSettings.queueTimeoutMs,
        defaultCpus: startupSettings.defaultCpus,
        defaultMemoryMb: startupSettings.defaultMemoryMb,
        defaultPidsLimit: startupSettings.defaultPidsLimit,
        defaultTimeoutSec: startupSettings.defaultTimeoutSec,
      })
      : new ContainerManager({
        maxGlobalContainers: startupSettings.maxGlobalContainers,
        queueTimeoutMs: startupSettings.queueTimeoutMs,
        defaultCpus: startupSettings.defaultCpus,
        defaultMemoryMb: startupSettings.defaultMemoryMb,
        defaultPidsLimit: startupSettings.defaultPidsLimit,
        defaultTimeoutSec: startupSettings.defaultTimeoutSec,
      });
  // Docker needs an explicit bridge network. Kubernetes supplies pod networking.
  try {
    await containerManager.ensureNetwork();
  } catch (err) {
    console.warn(`[Container] ${sandboxRuntime} sandbox runtime setup failed (sandbox runs will not work):`, (err as Error).message);
  }
  const workspaceDiffService = new WorkspaceDiffService({
    containerManager,
    settingsService,
  });

  const sessionManagerLogger = {
    info: (msg: string, ...args: unknown[]) => console.log('[SessionManager]', msg, ...args),
    warn: (msg: string, ...args: unknown[]) => console.warn('[SessionManager]', msg, ...args),
    error: (msg: string, ...args: unknown[]) => console.error('[SessionManager]', msg, ...args),
    debug: (msg: string, ...args: unknown[]) => console.debug('[SessionManager]', msg, ...args),
  };
  const lifecyclePolicyLogger = {
    info: (msg: string, ...args: unknown[]) => console.log('[LifecyclePolicy]', msg, ...args),
    warn: (msg: string, ...args: unknown[]) => console.warn('[LifecyclePolicy]', msg, ...args),
    error: (msg: string, ...args: unknown[]) => console.error('[LifecyclePolicy]', msg, ...args),
    debug: (msg: string, ...args: unknown[]) => console.debug('[LifecyclePolicy]', msg, ...args),
  };
  const sessionStateStore = new SessionStateStore();
  const sessionStatusCoordinator = new SessionStatusCoordinator({
    db,
    logger: sessionManagerLogger,
    stateStore: sessionStateStore,
  });

  const lifecyclePolicy = new ContainerLifecyclePolicy({
    containerManager,
    db,
    logger: lifecyclePolicyLogger,
    config: {
      reconciliationIntervalMs: startupSettings.reconciliationIntervalMs,
      idleTimeoutMs: startupSettings.idleTimeoutMs,
    },
    reconciliationCallbacks: {
      onSessionReconnected: (session, grpcClient) => {
        sessionManagerRef?.getSessionReconciler().onSessionReconnected(session, grpcClient);
      },
      onSessionEvicted: (sessionId, conversationId) => {
        return sessionManagerRef?.getSessionReconciler().onSessionEvicted(sessionId, conversationId);
      },
    },
    statusCoordinator: sessionStatusCoordinator,
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

  async function buildSandboxSecrets(agentId: string): Promise<Readonly<Record<string, string>>> {
    const envSecrets = Object.fromEntries(
      SANDBOX_SECRET_ALLOWLIST
        .filter((key) => process.env[key])
        .map((key) => [key, process.env[key]!]),
    );

    const keys = await secretProvider.list(agentId);
    const entries = await Promise.all(
      keys.map(async (key): Promise<[string, string | null]> => [key, await secretProvider.get(agentId, key)]),
    );
    const agentSecrets = Object.fromEntries(
      entries.filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );

    return {
      ...envSecrets,
      ...agentSecrets,
    };
  }

  const resolveToolsForAgent = (toolNames: string[], excludeBuiltins?: string[], agentId?: string) => {
    const declaredTools = new Set(toolNames);
    const excluded = excludeBuiltins ? new Set(excludeBuiltins) : undefined;
    const allTools = new Map<string, { name: string; description: string; input: unknown; requiresApproval?: boolean; location?: 'sandbox' | 'orchestrator' | 'daemon'; programmatic?: boolean }>();
    const LOCATION_TO_PROTO = { sandbox: 1, orchestrator: 2, daemon: 3 } as const;

    for (const tool of toolExecutor.list()) {
      if (declaredTools.has(tool.name) || builtinToolNames.has(tool.name)) {
        allTools.set(tool.name, tool);
      }
    }
    for (const tool of toolRegistry.listForAgent(toolNames, agentId)) {
      allTools.set(tool.name, tool);
    }

    if (excluded) {
      for (const name of excluded) {
        if (builtinToolNames.has(name)) allTools.delete(name);
      }
    }

    return Array.from(allTools.values()).map((tool) => {
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
        location: LOCATION_TO_PROTO[resolveToolLocation(tool)],
        programmatic: tool.programmatic ?? false,
      };
    });
  };

  const realSessionManagerDeps: ConstructorParameters<typeof SandboxSessionManagerImpl>[0] = {
    containerManager,
    db,
    lifecyclePolicy,
    stateStore: sessionStateStore,
    statusCoordinator: sessionStatusCoordinator,
    eventBus,
    maxConcurrentSessionsPerAgent: startupSettings.maxConcurrentSessionsPerAgent,
    interruptManager,
    buildSandboxSecrets,
    resolveToolsForAgent,
    dataDir,
    workspaceDiffService,
    logger: sessionManagerLogger,
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
    eventBus,
    sessionTurnService,
    toolExecutor,
    toolRegistry,
  });
  runStartupService.configureExecution({
    db,
    eventBus,
    sessionManager: realSessionManager,
    agentSessionService,
  });
  await triggerManager.start();
  await spineConsumerRunner.start();

  callbackDispatcher.start();

  return {
    config,
    db,
    toolExecutor,
    toolRegistry,
    eventBus,
    sseManager,
    interruptManager,
    triggerManager,
    spineConsumerRunner,
    agentSessionService,
    harnessRegistry,
    secretProvider,
    callbackDispatcher,
    runStartupService,
    containerManager,
    workspaceDiffService,
    settingsService,
    lifecyclePolicy,
    canonicalLog,
    reconcileStrandedTurns: (bootTimeMs: number) => reconcileStrandedTurnsOnStartup(
      {
        db,
        finalizer: new TurnFinalizer({ db, eventBus, logger: console }),
        logger: console,
        redispatchQueuedTurn: (params) => runStartupService.redispatchQueuedRun(params),
        resetStrandedSession: (sessionId) => realSessionManager.killSession(sessionId),
      },
      bootTimeMs,
    ),
    artifactStore,
    sessionManager: realSessionManager,
    close: async () => {
      lifecyclePolicy.stop();
      spineConsumerRunner.stop();
      callbackDispatcher.stop();
      await dbConn.close();
    },
  };
}
