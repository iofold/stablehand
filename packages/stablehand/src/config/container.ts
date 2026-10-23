import type { StablehandConfig, ResolvedConfig } from './types.js';
import { createHash } from 'node:crypto';
import { resolveDatabaseUrl } from './resolve.js';
import { createDatabase, type DatabaseConnection } from '../database/connection.js';
import { runMigrations } from '../database/migrations.js';
import { DatabaseRepository } from '../database/repository.js';
import { LocalFunctionExecutor } from '../tool/executor.js';
import {
  HARNESS_CONFIG_SCHEMAS,
  type HarnessConfigSchemas,
} from '@stablehand/sandbox-daemon/harness/schemas';
import { TypedEventBus, type EventMap } from '../events/bus.js';
import { BudgetEnforcer } from '../orchestrator/budget-enforcer.js';
import { SSEManager } from '../orchestrator/sse.js';
import { InterruptManager } from '../orchestrator/interrupt.js';
import { createTriggerSpineConsumer, EventTriggerManager, type TriggerRunCallback } from '../events/trigger-manager.js';
import { SpineConsumerRunner } from '../events/spine-consumer-runner.js';
import { TriggerTargetError } from '../events/trigger-errors.js';
import { AgentTurnService } from '../orchestrator/agent-turn-service.js';
import { CallbackDispatcher } from '../orchestrator/callback-dispatcher.js';
import { createGuardedFetch } from '../util/egress.js';
import { createWebhookRelaySpineConsumer } from '../orchestrator/webhook-relay.js';
import { TurnStartupService } from '../orchestrator/turn-startup-service.js';
import { createTurnQueueAdmission } from '../orchestrator/turn-queue-admission.js';
import { TurnDispatcher } from '../orchestrator/turn-dispatcher.js';
import { TurnSecretEnvelopeCodec } from '../orchestrator/turn-secret-envelope.js';
import { TurnFinalizer } from '../orchestrator/turn-finalizer.js';
import {
  reconcileStrandedTurnsOnStartup,
  type TurnAdoptionSummary,
} from '../orchestrator/turn-reconciler.js';
import { TurnTakeoverService } from '../orchestrator/turn-takeover.js';
import { previousBootTakeover } from '../orchestrator/instance-identity.js';
import { reconcilePendingMessagePublishesOnStartup } from '../orchestrator/message-publisher.js';
import { reconcilePendingTerminalPublishesOnStartup } from '../orchestrator/turn-terminal-publisher.js';
import { CanonicalLog } from '../orchestrator/canonical/canonical-log.js';
import { PostgresSecretProvider } from '../secrets/postgres-provider.js';
import { deriveKey } from '../secrets/crypto.js';
import { resolveSecretMasterKeyPassphrase } from '../secrets/master-key.js';
import type { SecretProvider } from '../secrets/types.js';
import { editDocumentTool } from '../tool/builtin/edit-document.js';
import { readSandboxScopeSecrets } from '../secrets/scopes.js';
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
import type { SandboxSecretsContext } from '../orchestrator/session-manager/types.js';
import { DefaultToolRegistry } from '../tool/registry.js';
import { LocalToolProvider } from '../tool/providers/local.js';
import { ArtifactToolProvider } from '../tool/providers/artifact.js';
import { BrowserToolProvider } from '../tool/providers/browser.js';
import {
  builtinNamesAllowedByPolicy,
  builtinTools,
  builtinToolNames,
} from '../tool/builtin/index.js';
import { createStablehandGuideTool } from '../tool/builtin/stablehand-guide.js';
import { resolveToolLocation } from '../tool/metadata.js';
import {
  zodToJsonSchema,
  type AgentDefinition,
} from '@stablehand/sandbox-daemon';
import { ArtifactStore } from '../artifact/artifact-store.js';
import { VALID_WEBHOOK_EVENTS } from '../orchestrator/webhook-events.js';
import { ToolLocation } from '@stablehand/proto/sandbox/v1';
import type { BuiltinToolPolicy } from '@stablehand/contracts';
import {
  MODEL_GATEWAY_SANDBOX_ENV,
  mergeSandboxSecrets,
  resolveModelGatewayConfig,
} from '../cost-control/model-gateway-config.js';
import { createIssuedGatewayKeys } from '../cost-control/issued-gateway-keys.js';
import { LiteLLMSpendClient } from '../cost-control/litellm-spend-client.js';
import { ModelGatewayReconciler } from '../cost-control/model-gateway-reconciler.js';
import { LiteLLMKeyClient } from '../cost-control/litellm-key-client.js';
import { SessionGatewayKeyManager } from '../cost-control/session-gateway-keys.js';
import type { ModelGatewayStatusConfig } from '../orchestrator/routes/model-gateway.js';
import { createRuntimeDefinitionFingerprint } from '../orchestrator/session-manager/runtime-definition-fingerprint.js';
import { ScheduleService } from '../schedules/index.js';
import type { StartupPhaseRecorder } from '../util/startup-timeline.js';

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
  scheduleService: ScheduleService;
  spineConsumerRunner: SpineConsumerRunner;
  agentTurnService: AgentTurnService;
  harnessSchemas: HarnessConfigSchemas;
  secretProvider: SecretProvider;
  callbackDispatcher: CallbackDispatcher;
  turnStartupService: TurnStartupService;
  turnDispatcher: TurnDispatcher;
  /** Container manager for sandbox lifecycle. */
  containerManager: SandboxContainerManager;
  workspaceDiffService: WorkspaceDiffService;
  settingsService: SystemSettingsService;
  lifecyclePolicy: ContainerLifecyclePolicy;
  /** Non-secret gateway status projection for the HTTP API. */
  modelGateway: ModelGatewayStatusConfig;
  /** Optional deployment-scoped spend reconciler; absent in direct-only mode. */
  modelGatewayReconciler?: ModelGatewayReconciler;
  /** Durable canonical event spine (ADR-015); serves replay when STABLEHAND_CANONICAL_EVENTS=1. */
  canonicalLog: CanonicalLog;
  /**
   * Startup turn reconciliation (ADR-014/ctx-7e3x/ADR 025): take over running
   * turns whose sandboxes are still executing them, fail the rest, and replay
   * durable queued turns. Takeovers finish in the background.
   */
  reconcileStrandedTurns: (bootTimeMs: number) => Promise<{
    failed: number;
    skippedHitlParked: number;
    redispatched: number;
    redispatchComplete: Promise<void>;
    adopting: number;
    adoptionComplete: Promise<TurnAdoptionSummary>;
  }>;
  artifactStore?: ArtifactStore;
  /** Sandbox session manager (typed as implementation for reconciliation). */
  sessionManager: SandboxSessionManagerImpl;
  /** Gracefully close database connections */
  close: () => Promise<void>;
}

export interface AppContainerOptions {
  /** Override sandbox ownership identity for isolated embedders and test runtimes. */
  containerScopeIdentity?: string;
  /** Receives the `migrations` and `services` startup phases (ctx-new8). */
  startupTimeline?: StartupPhaseRecorder;
}

export { VALID_WEBHOOK_EVENTS };

interface TriggerRunCallbackDeps {
  db: Pick<DatabaseRepository, 'getAgent'>;
  turnStartupService: Pick<TurnStartupService, 'prepareTurnStart' | 'requestDispatch'>;
  eventBus: Pick<TypedEventBus, 'emit'>;
}

/**
 * The conversation a keyed trigger firing continues. Derived from the agent
 * and the rendered key, so the same thread always lands in the same
 * conversation and two agents never share one.
 */
export function triggerConversationId(agentId: string, conversationKey: string): string {
  return `thread-${createHash('sha256').update(`${agentId}\n${conversationKey}`).digest('hex').slice(0, 32)}`;
}

export function createTriggerRunCallback({
  db,
  turnStartupService,
  eventBus,
}: TriggerRunCallbackDeps): TriggerRunCallback {
  return async (agentId, task, triggerId, triggerDepth, eventSeq, options) => {
    const agent = await db.getAgent(agentId);
    // ctx-v6ef: these used to log and return, which recorded the firing as a
    // success. They are permanent until someone fixes the agent, so the
    // trigger manager dead-letters them without holding the spine cursor.
    if (!agent) {
      throw new TriggerTargetError(
        'trigger_target_not_found',
        `Agent ${agentId} targeted by trigger ${triggerId} no longer exists`,
      );
    }
    if (!agent.harness) {
      throw new TriggerTargetError(
        'trigger_target_misconfigured',
        `Agent ${agentId} targeted by trigger ${triggerId} has no harness`,
      );
    }
    const requestedTurnId = eventSeq === undefined
      ? undefined
      : `trigger-${createHash('sha256').update(`${triggerId}:${eventSeq}`).digest('hex').slice(0, 24)}`;
    const conversationId = options?.conversationKey
      ? triggerConversationId(agentId, options.conversationKey)
      : undefined;
    let start: Awaited<ReturnType<TurnStartupService['prepareTurnStart']>>;
    try {
      start = await turnStartupService.prepareTurnStart({
        agent,
        agentId,
        content: task,
        mode: 'background',
        emitUserMessageEvent: false,
        ...(requestedTurnId ? { requestedTurnId } : {}),
        ...(conversationId ? { conversationId, createMissingConversationWithRequestedId: true } : {}),
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
    turnStartupService.requestDispatch(start, agentId, {
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
  userConfig: StablehandConfig,
  dataDir: string,
  options: AppContainerOptions = {},
): Promise<AppContainer> {
  const modelGatewayConfig = resolveModelGatewayConfig();
  const config: ResolvedConfig = {
    database: {
      type: 'postgres',
      url: resolveDatabaseUrl(userConfig),
    },
  };
  const secretMasterPassphrase = resolveSecretMasterKeyPassphrase();

  // ── Database ────────────────────────────────────────────
  const dbConn: DatabaseConnection = await createDatabase(config.database.url);

  // Run migrations (skipped when this build's schema pass already completed)
  const migration = await runMigrations(dbConn.pgClient);
  options.startupTimeline?.mark(
    'migrations',
    migration.schema === 'current' ? 'schema current' : 'schema applied',
  );

  const db = new DatabaseRepository(dbConn.db);
  const settingsService = new SystemSettingsService(db);
  const startupSettings = await settingsService.getAll();

  // ── Secrets ─────────────────────────────────────────────
  const secretMasterKey = deriveKey(secretMasterPassphrase);
  const secretProvider: SecretProvider = new PostgresSecretProvider(
    dbConn.pgClient,
    secretMasterKey,
  );
  const turnSecretEnvelopeCodec = new TurnSecretEnvelopeCodec(secretMasterKey);

  // ── Tools ───────────────────────────────────────────────
  const toolExecutor = new LocalFunctionExecutor();
  // Register built-in tools so resolveToolsForAgent() can find them.
  // Without this, builtinToolNames acts as a filter that matches nothing.
  for (const tool of builtinTools) {
    toolExecutor.register(tool);
  }
  const stablehandGuideTool = createStablehandGuideTool({
    listTools: () => toolExecutor.list(),
  });
  toolExecutor.register(stablehandGuideTool);
  // Opt-in (not a builtin): agents that list edit_document get the review card.
  toolExecutor.register(editDocumentTool);
  const toolRegistry = new DefaultToolRegistry();
  toolRegistry.addProvider(new LocalToolProvider(toolExecutor));
  const turnStartupService = new TurnStartupService({
    turnSecretEnvelopeCodec,
    modelGateway: modelGatewayConfig.enabled
      ? {
        enabled: true,
        profile: modelGatewayConfig.profile,
        revision: modelGatewayConfig.revision,
      }
      : { enabled: false },
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
  const s3Bucket = process.env.S3_BUCKET || 'stablehand-artifacts';
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
    toolRegistry.addProvider(new BrowserToolProvider());
  }

  await toolRegistry.refresh();

  // ── Events ──────────────────────────────────────────────
  // The canonical event spine (ADR-015) is the only persistence and the only
  // wire source. The bus defers listener dispatch until ingest resolves, so
  // ADR-006 persist-then-dispatch holds.
  const canonicalLog = new CanonicalLog({ db, logger: console });
  const eventBus = new TypedEventBus({
    persistEvent: async (type, _agentId, payload, parsedPayload, context) => {
      const persisted = await canonicalLog.ingest(
        type,
        parsedPayload ?? JSON.parse(payload) as Record<string, unknown>,
        context,
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
  const interruptManager = new InterruptManager(eventBus, db, async (sessionId, turnId) => {
    if (sessionManagerRef) {
      const fence = sessionManagerRef.getTurnDeliveryFence(turnId);
      if (!fence) {
        console.warn(
          `[InterruptManager] refusing unfenced HITL timeout checkpoint for `
          + `session ${sessionId}, turn ${turnId}`,
        );
        return;
      }
      await sessionManagerRef.suspendSession(sessionId, 'hitl-timeout', {
        allowActiveTurn: true,
        allowedTurnDelivery: { turnId, fence },
      });
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
  const scheduleService = new ScheduleService({
    repository: db,
    triggerManager,
    logger: console,
  });

  // ── Sandbox Run Service ─────────────────────────────────
  const sandboxRuntime = (process.env.STABLEHAND_SANDBOX_RUNTIME ?? 'docker').toLowerCase();
  const containerManager: SandboxContainerManager =
    sandboxRuntime === 'kubernetes' || sandboxRuntime === 'k8s'
      ? new KubernetesContainerManager({
        ...(options.containerScopeIdentity
          ? { scopeIdentity: options.containerScopeIdentity }
          : {}),
        maxGlobalContainers: startupSettings.maxGlobalContainers,
        queueTimeoutMs: startupSettings.queueTimeoutMs,
        defaultCpus: startupSettings.defaultCpus,
        defaultMemoryMb: startupSettings.defaultMemoryMb,
        defaultPidsLimit: startupSettings.defaultPidsLimit,
        defaultTimeoutSec: startupSettings.defaultTimeoutSec,
      })
      : new ContainerManager({
        ...(options.containerScopeIdentity
          ? { scopeIdentity: options.containerScopeIdentity }
          : {}),
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
  // Tag-based budget policies: block at turn admission, warn on threshold
  // crossings observed at turn completion (usage is only known at done), and
  // cap runs mid-flight through per-session gateway keys when available.
  const budgetEnforcer = new BudgetEnforcer({ db, eventBus, logger: console });

  // Per-session gateway keys (ctx-ycek): each sandbox session gets its own
  // LiteLLM key, capped per run, so the gateway stops a run at its spend cap
  // mid-flight. Needs the gateway plus an admin key; otherwise sandboxes share
  // the runtime key and budgets apply at admission only, as before.
  const sessionGatewayKeys = modelGatewayConfig.enabled && modelGatewayConfig.adminKey
    ? new SessionGatewayKeyManager({
      client: new LiteLLMKeyClient({
        baseUrl: modelGatewayConfig.baseUrl,
        adminKey: modelGatewayConfig.adminKey,
      }),
      runtimeKey: modelGatewayConfig.runtimeKey,
      getTurnTags: async (turnId) => (await db.getTurn(turnId))?.tags ?? {},
      resolvePolicyHeadroom: (tags) => budgetEnforcer.costHeadroom(tags),
      logger: {
        info: (msg: string, ...args: unknown[]) => console.log(msg, ...args),
        warn: (msg: string, ...args: unknown[]) => console.warn(msg, ...args),
        error: (msg: string, ...args: unknown[]) => console.error(msg, ...args),
      },
    })
    : undefined;
  if (modelGatewayConfig.enabled && !sessionGatewayKeys) {
    console.warn(
      '[ModelGateway] STABLEHAND_MODEL_GATEWAY_ADMIN_KEY is not set: sandboxes share one runtime key, '
      + 'so budgets are enforced when a run starts but runs are not stopped mid-flight at a spend cap.',
    );
  }
  const releaseSandboxCredentials = sessionGatewayKeys
    ? (sessionId: string) => sessionGatewayKeys.revokeSessionKey(sessionId)
    : undefined;

  const sessionStateStore = new SessionStateStore();
  const sessionStatusCoordinator = new SessionStatusCoordinator({
    db,
    logger: sessionManagerLogger,
    stateStore: sessionStateStore,
    ...(releaseSandboxCredentials
      ? {
        onRuntimeReleased: (sessionId: string) => {
          void releaseSandboxCredentials(sessionId);
        },
      }
      : {}),
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
        const reconciler = sessionManagerRef?.getSessionReconciler();
        if (!reconciler) {
          throw new Error(
            'Session reconciler is unavailable during startup adoption',
          );
        }
        return reconciler.onSessionReconnected(session, grpcClient);
      },
      onSessionEvicted: (sessionId, conversationId) => {
        return sessionManagerRef?.getSessionReconciler().onSessionEvicted(sessionId, conversationId);
      },
      reconcileExpiredSandboxSessionRestore: async (session) => {
        const reconciler = sessionManagerRef?.getSessionReconciler();
        if (!reconciler) {
          throw new Error('Session reconciler is unavailable during startup reconciliation');
        }
        return reconciler.reconcileExpiredSandboxSessionRestore(session);
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

  async function buildSandboxSecrets(
    agentId: string,
    context?: SandboxSecretsContext,
  ): Promise<Readonly<Record<string, string>>> {
    const envSecrets = Object.fromEntries(
      SANDBOX_SECRET_ALLOWLIST
        .filter((key) => process.env[key])
        .map((key) => [key, process.env[key]!]),
    );

    // Sandbox scope only: tools-scope secrets (MCP tokens, HTTP tool keys)
    // stay in the orchestrator.
    const agentSecrets = await readSandboxScopeSecrets(secretProvider, agentId);

    const merged = mergeSandboxSecrets({
      ...envSecrets,
      ...agentSecrets,
    }, modelGatewayConfig.enabled
      ? modelGatewayConfig.sandboxEnvironment
      : undefined);
    if (!sessionGatewayKeys || !context) {
      return merged;
    }
    // The session's own key replaces the shared runtime key; on failure the
    // shared key stays (logged by the manager).
    const sessionKey = await sessionGatewayKeys.mintSessionKey({
      sessionId: context.sessionId,
      agentId,
    });
    return sessionKey
      ? Object.freeze({ ...merged, [MODEL_GATEWAY_SANDBOX_ENV.runtimeKey]: sessionKey })
      : merged;
  }

  async function resolveRuntimeDefinitionHash(
    agentId: string,
    agentDef: AgentDefinition,
  ): Promise<string> {
    const agentSecretRevision = secretProvider.revision
      ? await secretProvider.revision(agentId)
      : 'untracked';
    return createRuntimeDefinitionFingerprint(agentDef, {
      gateway: modelGatewayConfig.enabled
        ? {
            enabled: true,
            profile: modelGatewayConfig.profile,
            revision: modelGatewayConfig.revision,
          }
        : { enabled: false },
      agentSecretRevision,
    });
  }

  const resolveToolsForAgent = (
    toolNames: string[],
    builtinToolPolicy?: BuiltinToolPolicy,
    agentId?: string,
  ) => {
    const declaredTools = new Set(toolNames);
    const allowedBuiltinNames = builtinNamesAllowedByPolicy(builtinToolNames, builtinToolPolicy);
    const allTools = new Map<string, { name: string; description: string; input: unknown; requiresApproval?: boolean; location?: 'sandbox' | 'orchestrator' | 'daemon'; programmatic?: boolean }>();
    for (const tool of toolExecutor.list()) {
      if (declaredTools.has(tool.name) || allowedBuiltinNames.has(tool.name)) {
        allTools.set(tool.name, tool);
      }
    }
    for (const tool of toolRegistry.listForAgent(toolNames, agentId)) {
      allTools.set(tool.name, tool);
    }
    for (const builtinName of builtinToolNames) {
      if (!allowedBuiltinNames.has(builtinName)) {
        allTools.delete(builtinName);
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
        requiresApproval: tool.requiresApproval ?? false,
      };
    });
  };

  const agentTurnServiceHolder: { current?: AgentTurnService } = {};
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
    ...(releaseSandboxCredentials ? { releaseSandboxCredentials } : {}),
    resolveRuntimeDefinitionHash,
    resolveToolsForAgent,
    dataDir,
    workspaceDiffService,
    logger: sessionManagerLogger,
    executeInterruptContinuation: async (input) => {
      if (!agentTurnServiceHolder.current) {
        throw new Error(
          'Agent turn service is unavailable for interrupt continuation',
        );
      }
      await agentTurnServiceHolder.current.executeTurn(input);
    },
    resolveTurnSecrets: async (turnId) => {
      const envelope = await db.getTurnSecretEnvelope(turnId);
      if (!envelope) {
        throw new Error(
          `Encrypted turn credentials are missing for HITL turn ${turnId}`,
        );
      }
      return turnSecretEnvelopeCodec.open(turnId, envelope);
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

  const sessionTurnService = createSessionTurnExecutor({
    sessionManager,
  });

  const agentTurnService = new AgentTurnService({
    db,
    sessionManager: realSessionManager,
    eventBus,
    sessionTurnService,
    ...(sessionGatewayKeys ? { turnSpendCaps: sessionGatewayKeys } : {}),
    turnProjection: canonicalLog,
  });
  // ADR 025: re-adopt turns that were running when the previous process died.
  const turnTakeoverService = new TurnTakeoverService({
    db,
    sessionManager: realSessionManager,
    executeTurn: (params) => agentTurnService.executeTurn(params),
    logger: console,
  });
  agentTurnServiceHolder.current = agentTurnService;
  eventBus.on('turn.completed', (payload) => {
    void budgetEnforcer.onTurnCompleted(payload as EventMap['turn.completed']);
  });
  const modelGatewayReconciler = modelGatewayConfig.enabled
    ? new ModelGatewayReconciler({
      db,
      spendClient: new LiteLLMSpendClient({
        baseUrl: modelGatewayConfig.baseUrl,
        meteringKey: modelGatewayConfig.meteringKey,
        explicitFreeModels: modelGatewayConfig.explicitFreeModels,
      }),
      // ctx-gfp8: fetch only the spend of keys Stablehand issued; another
      // workload sharing the gateway is counted and skipped, not quarantined.
      resolveIssuedKeys: async () => createIssuedGatewayKeys({
        runtimeKey: modelGatewayConfig.runtimeKey,
      }),
      onUsageReconciled: (change) =>
        budgetEnforcer.onTurnUsageReconciled(change),
      logger: console,
    }, {
      profile: modelGatewayConfig.profile,
      revision: modelGatewayConfig.revision,
    })
    : undefined;
  // ctx-z5k0: the durable queue dispatcher. Enqueue paths kick it for
  // sub-poll latency; it drains any pre-restart backlog in the background
  // instead of blocking startup (the old boot barrier).
  const turnDispatcher = new TurnDispatcher({
    db,
    dispatchTurn: (candidate) => turnStartupService.dispatchQueuedTurn(candidate),
    expireTurn: (turn) => turnStartupService.expireQueuedTurn(turn),
    hasSlotHeadroom: () => {
      const metrics = containerManager.getMetrics();
      return metrics.active + metrics.queued < metrics.maxGlobalContainers;
    },
    queuedTurnTimeoutMs: async () => (await settingsService.getAll()).queuedTurnTimeoutMs,
    logger: {
      info: (msg: string) => console.log(msg),
      warn: (msg: string) => console.warn(msg),
      error: (msg: string, err?: unknown) => console.error(msg, err),
    },
  });
  turnStartupService.setDispatchKick(() => turnDispatcher.kick());
  turnDispatcher.start();


  turnStartupService.configureExecution({
    db,
    eventBus,
    sessionManager: realSessionManager,
    agentTurnService,
    budgetEnforcer,
    queueAdmission: createTurnQueueAdmission({
      db,
      settings: async () => {
        const settings = await settingsService.getAll();
        return {
          maxQueuedTurnsGlobal: settings.maxQueuedTurnsGlobal,
          maxQueuedTurnsPerAgent: settings.maxQueuedTurnsPerAgent,
        };
      },
      isDispatchStalled: () => turnDispatcher.isStalled(),
    }),
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
  modelGatewayReconciler?.start();
  options.startupTimeline?.mark('services');

  return {
    config,
    db,
    toolExecutor,
    toolRegistry,
    eventBus,
    sseManager,
    interruptManager,
    triggerManager,
    scheduleService,
    spineConsumerRunner,
    agentTurnService,
    harnessSchemas: HARNESS_CONFIG_SCHEMAS,
    secretProvider,
    callbackDispatcher,
    turnStartupService,
    turnDispatcher,
    containerManager,
    workspaceDiffService,
    settingsService,
    lifecyclePolicy,
    modelGateway: modelGatewayConfig.enabled
      ? {
        enabled: true,
        profile: modelGatewayConfig.profile,
        revision: modelGatewayConfig.revision,
      }
      : { enabled: false },
    ...(modelGatewayReconciler ? { modelGatewayReconciler } : {}),
    canonicalLog,
    reconcileStrandedTurns: (bootTimeMs: number) => reconcileStrandedTurnsOnStartup(
      {
        db,
        eventBus,
        finalizer: new TurnFinalizer({ db, eventBus, logger: console }),
        logger: console,
        resetStrandedSession: (sessionId, lifecycleOperation) =>
          realSessionManager.killSession(sessionId, { lifecycleOperation }),
        adoptRunningTurn: (turn, lease) => turnTakeoverService.adopt(turn, lease),
      },
      bootTimeMs,
      { previousBootTakeover: previousBootTakeover() },
    ),
    artifactStore,
    sessionManager: realSessionManager,
    close: async () => {
      turnDispatcher.stop();
      lifecyclePolicy.stop();
      await modelGatewayReconciler?.stop();
      await scheduleService.stop();
      await canonicalLog.drain();
      spineConsumerRunner.stop();
      callbackDispatcher.stop();
      await dbConn.close();
    },
  };
}
