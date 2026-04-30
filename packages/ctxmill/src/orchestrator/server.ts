import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { fastifyConnectPlugin } from '@connectrpc/connect-fastify';
import { agUiCompatRoutes } from './ag-ui-compat/index.js';
import { agentRoutes, sessionsRoutes } from './routes/agents.js';
import { artifactRoutes } from './routes/artifacts.js';
import { catalogRoutes } from './routes/catalogs.js';
import { eventRoutes } from './routes/events.js';
import { knowledgeRoutes } from './routes/knowledge.js';
import { settingsRoutes } from './routes/settings.js';
import { triggerRoutes } from './routes/triggers.js';
import { sandboxRoutes } from './routes/sandbox.js';
import type { EventTriggerManager } from '../events/trigger-manager.js';
import { SSEManager } from './sse.js';
import { InterruptManager } from './interrupt.js';
import type { AgentSessionService } from './agent-session-service.js';
import type { DatabaseRepository } from '../database/repository.js';
import type { KnowledgeStore } from '../knowledge/types.js';
import type { RunStartupService } from './run-startup-service.js';
import type { TypedEventBus } from '../events/bus.js';
import type { SecretProvider } from '../secrets/types.js';
import { createGrpcRoutes } from './grpc/router.js';
import type { OrchestratorToolRegistry } from './grpc/orchestrator-service.js';
import type { SandboxContainerManager } from '../sandbox/container-manager.js';
import type { LocalFunctionExecutor } from '../tool/executor.js';
import { DefaultToolRegistry } from '../tool/registry.js';
import type { ArtifactStore } from '../artifact/index.js';
import { registerExistingAgentHttpTools } from './http-tools.js';
import { DefaultHarnessRegistry } from '../harness/registry.js';
import { LangGraphHarness } from '../harness/langgraph.js';
import { ClaudeAgentsHarness } from '../harness/claude-agents.js';
import { PIAgentHarness } from '../harness/pi-agent.js';
import type { HarnessRegistry } from '../harness/types.js';
import type { SystemSettingsService } from '../settings/service.js';
import type { SandboxSessionManager } from './sandbox-session-manager.js';

export interface ServerOptions {
  port?: number;
  host?: string;
  db: DatabaseRepository;
  harnessRegistry?: HarnessRegistry;
  knowledgeStore?: KnowledgeStore;
  eventBus?: TypedEventBus;
  /** Path to the .ctxmill data directory for agent workspaces. */
  dataDir?: string;
  /** Event trigger manager for pub/sub trigger system. */
  triggerManager?: EventTriggerManager;
  /** Pre-wired SSEManager (e.g. from DI container). Falls back to a new instance. */
  sse?: SSEManager;
  /** Pre-wired InterruptManager (e.g. from DI container). Falls back to a new instance. */
  interrupts?: InterruptManager;
  /** Pre-wired SecretProvider for per-agent encrypted secrets. */
  secretProvider?: SecretProvider;
  /** Pre-wired OrchestratorToolRegistry for gRPC tool callbacks from sandboxes. */
  toolRegistry?: OrchestratorToolRegistry;
  toolDefinitionRegistry?: DefaultToolRegistry;
  /** Pre-wired LocalFunctionExecutor with built-in and user-defined tools. */
  toolExecutor?: LocalFunctionExecutor;
  /** Pre-wired sandbox manager for sandbox concurrency stats. */
  containerManager?: SandboxContainerManager;
  artifactStore?: ArtifactStore;
  /** S3 bucket name for artifact storage. Required when artifactStore is provided. */
  artifactBucket?: string;
  /** Pre-wired AgentSessionService from DI container. */
  agentSessionService: AgentSessionService;
  runStartupService: RunStartupService;
  sessionManager?: SandboxSessionManager;
  settingsService?: SystemSettingsService;
}

function createDefaultHarnessRegistry(): HarnessRegistry {
  const harnessRegistry = new DefaultHarnessRegistry();
  harnessRegistry.register(new LangGraphHarness());
  harnessRegistry.register(new ClaudeAgentsHarness());
  harnessRegistry.register(new PIAgentHarness());
  return harnessRegistry;
}

/**
 * Create and configure the Fastify orchestrator server.
 *
 * The server is the composition root that wires together
 * the database, SSE manager, interrupt manager, and agent routes.
 */
export async function createServer(opts: ServerOptions): Promise<FastifyInstance> {
  const { db, harnessRegistry: optHarnessRegistry, knowledgeStore, eventBus, dataDir, triggerManager } = opts;
  const harnessRegistry = optHarnessRegistry ?? createDefaultHarnessRegistry();
  const toolDefinitionRegistry = opts.toolDefinitionRegistry ?? new DefaultToolRegistry();

  const app = Fastify({ logger: true });

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

  await app.register(multipart, {
    limits: {
      fileSize: 50 * 1024 * 1024, // 50 MB
    },
  });

  // Shared infrastructure — prefer injected instances from the DI container
  const sse = opts.sse ?? new SSEManager();
  const interrupts = opts.interrupts ?? new InterruptManager();

  // Decorate the app instance so other plugins can access shared state
  app.decorate('sse', sse);
  app.decorate('interrupts', interrupts);
  app.decorate('db', db);
  app.decorate('toolDefinitionRegistry', toolDefinitionRegistry);

  await registerExistingAgentHttpTools(db, toolDefinitionRegistry, opts.secretProvider);

  // ── ConnectRPC (gRPC) plugin ───────────────────────────
  // Registers OrchestratorService so sandbox containers can call back
  // into the orchestrator for tool execution and event emission.
  // REST routes coexist on the same port — ConnectRPC only handles
  // its own paths (e.g. /ctxmill.sandbox.v1.OrchestratorService/*).
  if (eventBus) {
    await app.register(fastifyConnectPlugin, {
      routes: createGrpcRoutes({
        eventBus,
        toolRegistry: opts.toolRegistry,
        interruptManager: interrupts,
        toolExecutor: opts.toolExecutor,
        toolDefinitionRegistry: toolDefinitionRegistry,
        repository: db,
        artifactStore: opts.artifactStore,
      }),
    });
  }

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
  app.get('/health', healthHandler);
  app.get('/api/health', healthHandler);

  // ── Sandbox metrics route ──────────────────────────────
  if (opts.containerManager) {
    await app.register(sandboxRoutes, {
      prefix: '/api/sandbox',
      containerManager: opts.containerManager,
    });
  }

  // ── AgentSessionService ───────────────────────────────────
  const agentSessionService = opts.agentSessionService;

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
        harness: process.env.DEFAULT_HARNESS ?? 'langgraph',
        temperature: Number(process.env.DEFAULT_TEMPERATURE ?? '0.7'),
        maxTokens: Number(process.env.DEFAULT_MAX_TOKENS ?? '4096'),
      },
    };
  });

  // ── Route plugins ──────────────────────────────────────
  await app.register(agentRoutes, { prefix: '/api/agents', db, sse, interrupts, harnessRegistry, knowledgeStore, agentSessionService, eventBus, dataDir, secretProvider: opts.secretProvider, toolRegistry: toolDefinitionRegistry, containerManager: opts.containerManager, sessionManager: opts.sessionManager, settingsService: opts.settingsService, runStartupService: opts.runStartupService });
  await app.register(sessionsRoutes, { prefix: '/api/sessions', db });
  if (eventBus) {
    await app.register(agUiCompatRoutes, {
      prefix: '/api/ag-ui',
      db,
      eventBus,
      runStartupService: opts.runStartupService,
    });
  }
  await app.register(catalogRoutes, { prefix: '/api/catalogs' });
  await app.register(eventRoutes, { prefix: '/api/events', db });
  await app.register(knowledgeRoutes, { prefix: '/api/knowledge', knowledgeStore });
  if (triggerManager) {
    await app.register(triggerRoutes, { prefix: '/api/triggers', triggerManager, db });
  }
  if (opts.settingsService) {
    await app.register(settingsRoutes, {
      prefix: '/api/settings',
      settingsService: opts.settingsService,
    });
  }
  if (opts.artifactStore && opts.artifactBucket) {
    await app.register(artifactRoutes, {
      prefix: '/api/artifacts',
      artifactStore: opts.artifactStore,
      repository: db,
      bucket: opts.artifactBucket,
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
  }
}
