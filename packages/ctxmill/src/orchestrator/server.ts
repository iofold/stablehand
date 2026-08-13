import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { fastifyConnectPlugin } from '@connectrpc/connect-fastify';
import { agUiCompatRoutes } from './ag-ui-compat/index.js';
import {
  activeConversationRoutes,
  activeSandboxSessionRoutes,
  agentRoutes,
} from './routes/agents.js';
import { artifactRoutes } from './routes/artifacts.js';
import { catalogRoutes } from './routes/catalogs.js';
import { eventRoutes } from './routes/events.js';
import { interruptRoutes } from './routes/interrupts.js';
import { settingsRoutes } from './routes/settings.js';
import { budgetRoutes } from './routes/budgets.js';
import { apiKeyRoutes } from './routes/keys.js';
import { queueRoutes } from './routes/queue.js';
import type { TurnDispatcher } from './turn-dispatcher.js';
import { analyticsRoutes } from './routes/analytics.js';
import {
  modelGatewayRoutes,
  type ModelGatewayStatusConfig,
} from './routes/model-gateway.js';
import { triggerRoutes } from './routes/triggers.js';
import { scheduleRoutes } from './routes/schedules.js';
import { sandboxRoutes } from './routes/sandbox.js';
import type { EventTriggerManager } from '../events/trigger-manager.js';
import type { ScheduleService } from '../schedules/index.js';
import type { SSEManager } from './sse.js';
import type { InterruptManager } from './interrupt.js';
import type { DatabaseRepository } from '../database/repository.js';
import type { TurnStartupService } from './turn-startup-service.js';
import type { TypedEventBus } from '../events/bus.js';
import type { HarnessConfigSchemas } from '@ctxmill/sandbox-daemon/harness/schemas';
import type { SecretProvider } from '../secrets/types.js';
import { createGrpcRoutes } from './grpc/router.js';
import {
  createGrpcCallbackAuthInterceptor,
  resolveGrpcCallbackAuthConfig,
} from './grpc/callback-auth.js';
import type { OrchestratorToolRegistry } from './grpc/orchestrator-service.js';
import type { SandboxContainerManager } from '../sandbox/container-manager.js';
import type { LocalFunctionExecutor } from '../tool/executor.js';
import type { DefaultToolRegistry } from '../tool/registry.js';
import type { ArtifactStore } from '../artifact/index.js';
import { ArtifactRegistrationService } from '../artifact/registration-service.js';
import { registerExistingAgentHttpTools } from './http-tools.js';
import type { SystemSettingsService } from '../settings/service.js';
import type { SandboxSessionManager } from './sandbox-session-manager.js';
import type { ContainerLifecyclePolicy } from './container-lifecycle-policy.js';
import type { CanonicalLog } from './canonical/canonical-log.js';
import {
  registerApiAuth,
  resolveApiAuthConfig,
  serializeRequestForLog,
  type ApiAuthConfig,
  type ApiRouteRecord,
} from './auth.js';

export interface ServerOptions {
  port?: number;
  host?: string;
  db: DatabaseRepository;
  harnessSchemas: HarnessConfigSchemas;
  eventBus: TypedEventBus;
  /** Path to the .ctxmill data directory for agent workspaces. */
  dataDir?: string;
  /** Event trigger manager for pub/sub trigger system. */
  triggerManager?: EventTriggerManager;
  turnDispatcher?: TurnDispatcher;
  scheduleService?: ScheduleService;
  sse: SSEManager;
  interrupts: InterruptManager;
  /** Pre-wired SecretProvider for per-agent encrypted secrets. */
  secretProvider?: SecretProvider;
  /** Pre-wired OrchestratorToolRegistry for gRPC tool callbacks from sandboxes. */
  toolRegistry?: OrchestratorToolRegistry;
  toolDefinitionRegistry: DefaultToolRegistry;
  /** Pre-wired LocalFunctionExecutor with built-in and user-defined tools. */
  toolExecutor?: LocalFunctionExecutor;
  /** Pre-wired sandbox manager for sandbox concurrency stats. */
  containerManager?: SandboxContainerManager;
  artifactStore?: ArtifactStore;
  /** S3 bucket name for artifact storage. Required when artifactStore is provided. */
  artifactBucket?: string;
  turnStartupService: TurnStartupService;
  sessionManager?: SandboxSessionManager;
  settingsService?: SystemSettingsService;
  lifecyclePolicy?: ContainerLifecyclePolicy;
  /** Durable canonical event spine (ADR-015). */
  canonicalLog?: CanonicalLog;
  /** Non-secret optional gateway deployment status configuration. */
  modelGateway?: ModelGatewayStatusConfig;
}

/**
 * Create and configure the Fastify orchestrator server.
 *
 * The server is the composition root that wires together
 * the database, SSE manager, interrupt manager, and agent routes.
 */
export async function createServer(opts: ServerOptions): Promise<FastifyInstance> {
  const {
    db,
    eventBus,
    harnessSchemas,
    interrupts,
    sse,
    toolDefinitionRegistry,
    dataDir,
    triggerManager,
  } = opts;

  const app = Fastify({
    logger: {
      serializers: {
        req: serializeRequestForLog,
      },
    },
  });

  // Allow binary uploads (application/gzip, application/x-gzip) for workspace tarball endpoint.
  // The route handler reads from request.raw directly, so we skip body parsing.
  app.addContentTypeParser(
    ['application/gzip', 'application/x-gzip'],
    function (_request, _payload, done) { done(null); },
  );

  // CORS — configurable via CORS_ORIGINS env var, defaults to Docker UI ports
  await app.register(cors, {
    origin: process.env.CORS_ORIGINS
      ? process.env.CORS_ORIGINS.split(',')
      : ['http://localhost:3200', 'http://127.0.0.1:3200'],
  });

  // Chrome Private Network Access: pages on public origins (e.g. a hosted
  // artifact console) fetching a tailnet/private-address deployment must see
  // this header on the preflight or the browser drops the request. Only
  // meaningful when the origin already passed the CORS allowlist above.
  app.addHook('onSend', async (request, reply) => {
    if (
      request.method === 'OPTIONS'
      && request.headers['access-control-request-private-network'] === 'true'
      && reply.getHeader('access-control-allow-origin')
    ) {
      reply.header('access-control-allow-private-network', 'true');
    }
  });

  await app.register(multipart, {
    limits: {
      fileSize: 50 * 1024 * 1024, // 50 MB
    },
  });

  registerApiAuth(app, resolveApiAuthConfig(), {
    findLiveKeyByTokenHash: async (tokenHash) => {
      const row = await db.findLiveApiKeyByTokenHash(tokenHash);
      return row ? { keyId: row.id, name: row.name, capabilities: row.capabilities } : null;
    },
    isLiveKey: (keyId) => db.isLiveApiKey(keyId),
    touchLastUsed: (keyId) => db.touchApiKeyLastUsed(keyId),
  });

  // Decorate the app instance so other plugins can access shared state
  app.decorate('sse', sse);
  app.decorate('interrupts', interrupts);
  app.decorate('db', db);
  app.decorate('toolDefinitionRegistry', toolDefinitionRegistry);

  await registerExistingAgentHttpTools(db, toolDefinitionRegistry, opts.secretProvider);

  const artifactRegistration = new ArtifactRegistrationService({
    repository: db,
    eventBus,
  });

  // ── ConnectRPC (gRPC) plugin ───────────────────────────
  // Registers OrchestratorService so sandbox containers can call back
  // into the orchestrator for tool execution and event emission.
  // REST routes coexist on the same port — ConnectRPC only handles
  // its own paths (e.g. /ctxmill.sandbox.v1.OrchestratorService/*).
  const callbackAuthConfig = resolveGrpcCallbackAuthConfig();
  const callbackAuthInterceptor =
    createGrpcCallbackAuthInterceptor(callbackAuthConfig);
  await app.register(fastifyConnectPlugin, {
    routes: createGrpcRoutes({
      eventBus,
      toolRegistry: opts.toolRegistry,
      interruptManager: interrupts,
      toolExecutor: opts.toolExecutor,
      toolDefinitionRegistry,
      repository: db,
      callbackAuthConfig,
      artifactRegistration,
    }),
    interceptors: callbackAuthInterceptor ? [callbackAuthInterceptor] : [],
  });

  // ── Health check ───────────────────────────────────────
  const healthHandler = async () => {
    const response: Record<string, unknown> = {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };

    // Include sandbox container metrics
    if (opts.containerManager) {
      const metrics = opts.containerManager.getMetrics();
      response.sandbox = {
        execution_mode: 'sandbox',
        containers: {
          active: metrics.active,
          queued: metrics.queued,
          peak: metrics.peak,
          total_created: metrics.totalCreated,
        },
        limits: {
          max_global_containers: metrics.maxGlobalContainers,
        },
      };
    }

    return response;
  };
  // Register at both paths: /health for direct orchestrator access,
  // /api/health for nginx-proxied or prefix-based access
  app.get('/health', { config: { public: true } }, healthHandler);
  app.get('/api/health', { config: { public: true } }, healthHandler);

  // ── Sandbox metrics route ──────────────────────────────
  if (opts.containerManager) {
    await app.register(sandboxRoutes, {
      prefix: '/api/sandbox',
      containerManager: opts.containerManager,
    });
  }

  // ── Config endpoint ──────────────────────────────────────
  app.get('/api/config', async () => {
    const startTime = process.uptime() * 1000;
    return {
      system: {
        version: process.env.npm_package_version ?? '0.1.0',
        uptime: startTime,
        dbPath: opts.dataDir ?? '.ctxmill',
      },
      agentDefaults: {
        harness: 'langgraph',
        temperature: 0.7,
        maxTokens: 4096,
      },
    };
  });

  // ── Route plugins ──────────────────────────────────────
  await app.register(agentRoutes, { prefix: '/api/agents', db, sse, interrupts, harnessSchemas, eventBus, dataDir, secretProvider: opts.secretProvider, toolRegistry: toolDefinitionRegistry, containerManager: opts.containerManager, sessionManager: opts.sessionManager, settingsService: opts.settingsService, turnStartupService: opts.turnStartupService, canonicalLog: opts.canonicalLog, scheduleService: opts.scheduleService, triggerManager: opts.triggerManager });
  await app.register(activeConversationRoutes, {
    prefix: '/api/conversations',
    db,
    lifecyclePolicy: opts.lifecyclePolicy,
    sessionManager: opts.sessionManager,
  });
  await app.register(activeSandboxSessionRoutes, {
    prefix: '/api/sandbox-sessions',
    db,
    lifecyclePolicy: opts.lifecyclePolicy,
    sessionManager: opts.sessionManager,
  });
  if (eventBus) {
    await app.register(agUiCompatRoutes, {
      prefix: '/api/ag-ui',
      db,
      eventBus,
      turnStartupService: opts.turnStartupService,
      canonicalLog: opts.canonicalLog,
    });
  }
  await app.register(catalogRoutes, { prefix: '/api/catalogs' });
  await app.register(eventRoutes, { prefix: '/api/events', db });
  await app.register(interruptRoutes, { prefix: '/api/interrupts', db });
  await app.register(budgetRoutes, { prefix: '/api/budgets', db });
  await app.register(apiKeyRoutes, { prefix: '/api/keys', db });
  await app.register(queueRoutes, { prefix: '/api/queue', db, ...(opts.turnDispatcher ? { dispatcher: opts.turnDispatcher } : {}) });
  await app.register(analyticsRoutes, { prefix: '/api/analytics', db });
  await app.register(modelGatewayRoutes, {
    prefix: '/api/model-gateway',
    db,
    config: opts.modelGateway ?? { enabled: false },
  });
  if (!opts.modelGateway?.enabled) {
    // Losing the gateway overlay env silently strands priced-usage turns
    // (ctx-fpi1). Make the misconfiguration loud at boot instead.
    try {
      const awaiting = await db.getGatewayTurnsAwaitingReconciliation();
      if (awaiting.count > 0) {
        app.log.warn(
          `Model gateway spend ingestion is disabled, but ${awaiting.count} completed gateway turn(s) `
          + 'are awaiting prices — budgets and analytics under-count until '
          + 'CTXMILL_MODEL_GATEWAY_* configuration is restored.',
        );
      }
    } catch (error) {
      app.log.debug({ err: error }, 'Gateway reconciliation backlog check failed at startup');
    }
  }
  if (triggerManager) {
    await app.register(triggerRoutes, { prefix: '/api/triggers', triggerManager, db });
  }
  if (opts.scheduleService) {
    await app.register(scheduleRoutes, {
      prefix: '/api/schedules',
      service: opts.scheduleService,
    });
  }
  if (opts.settingsService) {
    await app.register(settingsRoutes, {
      prefix: '/api/settings',
      settingsService: opts.settingsService,
      onSettingsUpdated: (settings) => {
        opts.lifecyclePolicy?.updateConfig({
          idleTimeoutMs: settings.idleTimeoutMs,
          reconciliationIntervalMs: settings.reconciliationIntervalMs,
        });
        opts.containerManager?.applySettings?.({
          maxGlobalContainers: settings.maxGlobalContainers,
          queueTimeoutMs: settings.queueTimeoutMs,
          defaultCpus: settings.defaultCpus,
          defaultMemoryMb: settings.defaultMemoryMb,
          defaultPidsLimit: settings.defaultPidsLimit,
          defaultTimeoutSec: settings.defaultTimeoutSec,
        });
      },
    });
  }
  if (opts.artifactStore && opts.artifactBucket) {
    await app.register(artifactRoutes, {
      prefix: '/api/artifacts',
      artifactStore: opts.artifactStore,
      repository: db,
      bucket: opts.artifactBucket,
      eventBus,
      registrationService: artifactRegistration,
    });
  }

  // ── Graceful shutdown ──────────────────────────────────
  app.addHook('onClose', async () => {
    sse.shutdown();
    interrupts.shutdown();
    if (triggerManager) triggerManager.shutdown();
  });

  return app;
}

// Fastify type augmentation for decorated properties
declare module 'fastify' {
  interface FastifyInstance {
    sse: SSEManager;
    interrupts: InterruptManager;
    db: DatabaseRepository;
    toolDefinitionRegistry: DefaultToolRegistry;
    apiAuth: ApiAuthConfig;
    apiRouteTable: ApiRouteRecord[];
  }

  interface FastifyContextConfig {
    public?: boolean;
    allowTokenQuery?: boolean;
  }
}
