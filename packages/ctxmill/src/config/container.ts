import type { CTXMillConfig, ResolvedConfig } from './types.js';
import { createHash } from 'node:crypto';
import { resolveDatabaseUrl } from './resolve.js';
import { createDatabase, type DatabaseConnection } from '../database/connection.js';
import { runMigrations } from '../database/migrations.js';
import { DatabaseRepository } from '../database/repository.js';
import { LocalFunctionExecutor } from '../tool/executor.js';
import {
  HARNESS_CONFIG_SCHEMAS,
  type HarnessConfigSchemas,
} from '@ctxmill/sandbox-daemon/harness/schemas';
import { TypedEventBus, type EventMap } from '../events/bus.js';
import { BudgetEnforcer } from '../orchestrator/budget-enforcer.js';
import { SSEManager } from '../orchestrator/sse.js';
import { InterruptManager } from '../orchestrator/interrupt.js';
import { createTriggerSpineConsumer, EventTriggerManager, type TriggerRunCallback } from '../events/trigger-manager.js';
import { SpineConsumerRunner } from '../events/spine-consumer-runner.js';
import { AgentTurnService } from '../orchestrator/agent-turn-service.js';
import { CallbackDispatcher } from '../orchestrator/callback-dispatcher.js';
import { createGuardedFetch } from '../util/egress.js';
import { createWebhookRelaySpineConsumer } from '../orchestrator/webhook-relay.js';
import { TurnStartupService } from '../orchestrator/turn-startup-service.js';
import { TurnFinalizer } from '../orchestrator/turn-finalizer.js';
import { reconcileStrandedTurnsOnStartup } from '../orchestrator/turn-reconciler.js';
import { reconcilePendingMessagePublishesOnStartup } from '../orchestrator/message-publisher.js';
import { reconcilePendingTerminalPublishesOnStartup } from '../orchestrator/turn-terminal-publisher.js';
import { CanonicalLog } from '../orchestrator/canonical/canonical-log.js';
import { PostgresSecretProvider } from '../secrets/postgres-provider.js';
import { deriveKey } from '../secrets/crypto.js';
import { resolveSecretMasterKeyPassphrase } from '../secrets/master-key.js';
import type { SecretProvider } from '../secrets/types.js';
import { ContainerManager, type SandboxContainerManager } from '../sandbox/container-manager.js';
import { KubernetesContainerManager } from '../sandbox/kubernetes-container-manager.js';
import { WorkspaceDiffService } from '../sandbox/workspace-diff.js';
import { SystemSettingsService } from '../settings/service.js';
import { ContainerLifecyclePolicy } from '../orchestrator/container-lifecycle-policy.js';
import { createSessionTurnExecutor } from '../orchestrator/session-turn-service.js';
import type { SandboxSessionManager } from '../orchestrator/sandbox-session-manager.js';
import { SandboxSessionManager as SandboxSessionManagerImpl } from '../orchestrator/sandbox-session-manager.js';
import { SessionStateStore } from '../orchestrator/session-manager/session-state-store.js';
import { SessionStatusCoordinator } from '../orchestrator/session-manager/session-status-coordinator.js';
import { DefaultToolRegistry } from '../tool/registry.js';
import { LocalToolProvider } from '../tool/providers/local.js';
import { ArtifactToolProvider } from '../tool/providers/artifact.js';
import { builtinTools, builtinToolNames } from '../tool/builtin/index.js';
import { createCtxmillGuideTool } from '../tool/builtin/ctxmill-guide.js';
import { resolveToolLocation } from '../tool/metadata.js';
import { zodToJsonSchema } from '@ctxmill/sandbox-daemon';
import { ArtifactStore } from '../artifact/artifact-store.js';
import { VALID_WEBHOOK_EVENTS } from '../orchestrator/webhook-events.js';
import { ToolLocation } from '@ctxmill/proto/sandbox/v1';

const LOCATION_TO_PROTO = {
  sandbox: ToolLocation.SANDBOX,
  orchestrator: ToolLocation.ORCHESTRATOR,
  daemon: ToolLocation.DAEMON,
} as const;

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
  agentTurnService: AgentTurnService;
  harnessSchemas: HarnessConfigSchemas;
  secretProvider: SecretProvider;
  callbackDispatcher: CallbackDispatcher;
  turnStartupService: TurnStartupService;
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
  turnStartupService: Pick<TurnStartupService, 'prepareTurnStart' | 'launchPreparedTurn'>;
  eventBus: Pick<TypedEventBus, 'emit'>;
}

export function createTriggerRunCallback({
  db,
  turnStartupService,
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
    let start: Awaited<ReturnType<TurnStartupService['prepareTurnStart']>>;
    try {
      start = await turnStartupService.prepareTurnStart({
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

    // Fire-and-forget — AgentTurnService handles SSE broadcasting, message.delta events,
    // message persistence, and session completion. trigger.fired preserves the cascade
    // depth that EventTriggerManager already computed for this triggered run.
    void turnStartupService.launchPreparedTurn(start, agentId, {
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
  const config: ResolvedConfig = {
    database: {
      type: 'postgres',
      url: resolveDatabaseUrl(userConfig),
    },
  };
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
  const turnStartupService = new TurnStartupService({
    logger: {
      info: (msg: string, ...args: unknown[]) => console.log('[TurnStartupService]', msg, ...args),
      warn: (msg: string, ...args: unknown[]) => console.warn('[TurnStartupService]', msg, ...args),
      error: (msg: string, ...args: unknown[]) => console.error('[TurnStartupService]', msg, ...args),
      debug: (msg: string, ...args: unknown[]) => console.debug('[TurnStartupService]', msg, ...args),
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
      const persisted = await canonicalLog.ingest(
        type,
        parsedPayload ?? JSON.parse(payload) as Record<string, unknown>,
      );
      return persisted.length > 0;
    },
  });

  // ── SSE + Interrupts ───────────────────────────────────
  const sseManager = new SSEManager(eventBus);
  // Run-channel frames feed the native wire with durable seq ids.
  canonicalLog.subscribe((frames) => {
    for (const frame of frames) {
      if (frame.channel !== 'run') continue;
      sseManager.broadcastFrame(frame.agentId, frame.body, frame.seq);
    }
  });
  const interruptManager = new InterruptManager(eventBus, db, async (sessionId) => {
    if (sessionManagerRef) {
      await sessionManagerRef.suspendSession(sessionId, 'hitl-timeout', { allowActiveTurn: true });
    }
  });
  await interruptManager.loadFromDb();

  let sessionManagerRef: SandboxSessionManagerImpl | null = null;

  // ── Event Triggers ─────────────────────────────────────
  // Webhook/callback delivery targets agent-supplied URLs from the trusted
  // orchestrator process; route them through the SSRF egress guard.
  const callbackDispatcher = new CallbackDispatcher(db, undefined, createGuardedFetch());
  const triggerManager = new EventTriggerManager(
    eventBus,
    db,
    createTriggerRunCallback({ db, turnStartupService, eventBus }),
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
      reconcileStrandedRestoring: async (session) => {
        const reconciler = sessionManagerRef?.getSessionReconciler();
        if (!reconciler) {
          throw new Error('Session reconciler is unavailable during startup reconciliation');
        }
        return reconciler.reconcileStrandedRestoring(session);
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

  const sessionTurnService = createSessionTurnExecutor({
    sessionManager,
    onSessionReady: (turnId, sandboxSessionId) => {
      void db.updateTurn(turnId, { sandboxSessionId });
    },
  });

  const agentTurnService = new AgentTurnService({
    db,
    sessionManager: realSessionManager,
    eventBus,
    sessionTurnService,
  });
  // Tag-based budget policies: block at turn admission, warn on threshold
  // crossings observed at turn completion (usage is only known at done).
  const budgetEnforcer = new BudgetEnforcer({ db, eventBus, logger: console });
  eventBus.on('turn.completed', (payload) => {
    void budgetEnforcer.onTurnCompleted(payload as EventMap['turn.completed']);
  });
  turnStartupService.configureExecution({
    db,
    eventBus,
    sessionManager: realSessionManager,
    agentTurnService,
    budgetEnforcer,
  });
  await triggerManager.start();
  await spineConsumerRunner.start();
  // Crash/event-store recovery must finish before createContainer returns and
  // the HTTP/SSE server starts accepting readers.
  await reconcilePendingMessagePublishesOnStartup({
    db,
    eventBus,
    logger: console,
  });
  await reconcilePendingTerminalPublishesOnStartup({
    db,
    eventBus,
    logger: console,
  });

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
    agentTurnService,
    harnessSchemas: HARNESS_CONFIG_SCHEMAS,
    secretProvider,
    callbackDispatcher,
    turnStartupService,
    containerManager,
    workspaceDiffService,
    settingsService,
    lifecyclePolicy,
    canonicalLog,
    reconcileStrandedTurns: (bootTimeMs: number) => reconcileStrandedTurnsOnStartup(
      {
        db,
        eventBus,
        finalizer: new TurnFinalizer({ db, eventBus, logger: console }),
        logger: console,
        redispatchQueuedTurn: (params, signal) =>
          turnStartupService.redispatchQueuedTurn(params, signal),
        resetStrandedSession: (sessionId) => realSessionManager.killSession(sessionId),
      },
      bootTimeMs,
    ),
    artifactStore,
    sessionManager: realSessionManager,
    close: async () => {
      lifecyclePolicy.stop();
      await canonicalLog.drain();
      spineConsumerRunner.stop();
      callbackDispatcher.stop();
      await dbConn.close();
    },
  };
}
