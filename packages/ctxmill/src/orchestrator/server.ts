import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { fastifyConnectPlugin } from '@connectrpc/connect-fastify';
import { agentRoutes, runsRoutes } from './routes/agents.js';
import { catalogRoutes } from './routes/catalogs.js';
import { eventRoutes } from './routes/events.js';
import { knowledgeRoutes } from './routes/knowledge.js';
import { triggerRoutes } from './routes/triggers.js';
import { sandboxRoutes } from './routes/sandbox.js';
import type { EventTriggerManager } from '../events/trigger-manager.js';
import { SSEManager } from './sse.js';
import { InterruptManager } from './interrupt.js';
import type { AgentRunService } from './agent-run-service.js';
import type { DatabaseRepository } from '../database/repository.js';
import type { LearningPipeline } from '../learning/types.js';
import type { KnowledgeStore } from '../knowledge/types.js';
import type { TypedEventBus } from '../events/bus.js';
import { RunRegistry } from './run-registry.js';
import type { EnvironmentFactory } from '../workspace/types.js';
import { ManifestService } from '../manifest/index.js';
import type { SecretProvider } from '../secrets/types.js';
import { createGrpcRoutes } from './grpc/router.js';
import type { OrchestratorToolRegistry } from './grpc/orchestrator-service.js';
import type { ContainerManager } from '../sandbox/container-manager.js';
import { DefaultToolRegistry } from '../tool/registry.js';
import { registerExistingAgentHttpTools } from './http-tools.js';
import { DefaultHarnessRegistry } from '../harness/registry.js';
import { LangGraphHarness } from '../harness/langgraph.js';
import { ClaudeAgentsHarness } from '../harness/claude-agents.js';
import { PIAgentHarness } from '../harness/pi-agent.js';
import type { HarnessRegistry } from '../harness/types.js';

export interface ServerOptions {
  port?: number;
  host?: string;
  db: DatabaseRepository;
  harnessRegistry?: HarnessRegistry;
  runRegistry?: RunRegistry;
  learningPipeline?: LearningPipeline;
  knowledgeStore?: KnowledgeStore;
  eventBus?: TypedEventBus;
  /** Path to the .ctxmill data directory for agent workspaces. */
  dataDir?: string;
  /** Factory for creating session execution environments. */
  envFactory?: EnvironmentFactory;
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
  /** Pre-wired ContainerManager for sandbox concurrency stats. */
  containerManager?: ContainerManager;
  /** Pre-wired AgentRunService from DI container. */
  agentRunService: AgentRunService;
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
  const { db, port: _port, host: _host, harnessRegistry: optHarnessRegistry, runRegistry: optRunRegistry, learningPipeline, knowledgeStore, eventBus, dataDir, envFactory, triggerManager } = opts;
  const runRegistry = optRunRegistry ?? new RunRegistry();
  const harnessRegistry = optHarnessRegistry ?? createDefaultHarnessRegistry();
  const toolDefinitionRegistry = opts.toolDefinitionRegistry ?? new DefaultToolRegistry();

  const app = Fastify({ logger: true });

  // CORS — configurable via CORS_ORIGINS env var, defaults to Docker UI ports
  await app.register(cors, {
    origin: process.env.CORS_ORIGINS
      ? process.env.CORS_ORIGINS.split(',')
      : ['http://localhost:3200', 'http://127.0.0.1:3200'],
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

  // ── AgentRunService ──────────────────────────────────────
  const agentRunService = opts.agentRunService;

  const manifestService = new ManifestService(db);

  // ── Config endpoint ──────────────────────────────────────
  app.get('/api/config', async () => {
    const startTime = process.uptime() * 1000;
    return {
      llm: {
        provider: process.env.OPENAI_BASE_URL ? 'openai-compatible' : (process.env.LLM_PROVIDER ?? 'openai'),
        model: process.env.OPENAI_MODEL ?? process.env.LLM_MODEL ?? undefined,
        baseUrl: process.env.OPENAI_BASE_URL ?? undefined,
      },
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
  await app.register(agentRoutes, { prefix: '/api/agents', db, sse, interrupts, runRegistry, harnessRegistry, learningPipeline, knowledgeStore, agentRunService, eventBus, dataDir, envFactory, manifestService, secretProvider: opts.secretProvider, toolRegistry: toolDefinitionRegistry });
  await app.register(runsRoutes, { prefix: '/api/runs', runRegistry });
  await app.register(catalogRoutes, { prefix: '/api/catalogs' });
  await app.register(eventRoutes, { prefix: '/api/events', db });
  await app.register(knowledgeRoutes, { prefix: '/api/knowledge', knowledgeStore });
  if (triggerManager) {
    await app.register(triggerRoutes, { prefix: '/api/triggers', triggerManager, db });
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
