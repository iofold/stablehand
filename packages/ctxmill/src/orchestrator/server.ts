import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { agentRoutes, runsRoutes } from './routes/agents.js';
import { catalogRoutes } from './routes/catalogs.js';
import { eventRoutes } from './routes/events.js';
import { knowledgeRoutes } from './routes/knowledge.js';
import { triggerRoutes } from './routes/triggers.js';
import type { EventTriggerManager } from '../events/trigger-manager.js';
import { SSEManager } from './sse.js';
import { InterruptManager } from './interrupt.js';
import { AgentRunService } from './agent-run-service.js';
import type { DatabaseRepository } from '../database/repository.js';
import type { AgentExecutor } from '../agent/executor.js';
import type { LearningPipeline } from '../learning/types.js';
import type { KnowledgeStore } from '../knowledge/types.js';
import type { TypedEventBus } from '../events/bus.js';
import { RunRegistry } from './run-registry.js';
import type { EnvironmentFactory } from '../workspace/types.js';
import { ManifestService } from '../manifest/index.js';

export interface ServerOptions {
  port?: number;
  host?: string;
  db: DatabaseRepository;
  executor: AgentExecutor;
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
}

/**
 * Create and configure the Fastify orchestrator server.
 *
 * The server is the composition root that wires together
 * the database, SSE manager, interrupt manager, and agent routes.
 */
export async function createServer(opts: ServerOptions): Promise<FastifyInstance> {
  const { db, executor, port: _port, host: _host, runRegistry: optRunRegistry, learningPipeline, knowledgeStore, eventBus, dataDir, envFactory, triggerManager } = opts;
  const runRegistry = optRunRegistry ?? new RunRegistry();

  const app = Fastify({ logger: true });

  // CORS — configurable via CORS_ORIGINS env var, defaults to dev ports
  await app.register(cors, {
    origin: process.env.CORS_ORIGINS
      ? process.env.CORS_ORIGINS.split(',')
      : ['http://localhost:5173', 'http://localhost:3000'],
  });

  // Shared infrastructure — prefer injected instances from the DI container
  const sse = opts.sse ?? new SSEManager();
  const interrupts = opts.interrupts ?? new InterruptManager();

  // Decorate the app instance so other plugins can access shared state
  app.decorate('sse', sse);
  app.decorate('interrupts', interrupts);
  app.decorate('db', db);

  // ── Health check ───────────────────────────────────────
  app.get('/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
  }));

  // ── AgentRunService ──────────────────────────────────────
  const agentRunService = new AgentRunService({
    executor,
    sse,
    db,
    runRegistry,
    learningPipeline,
    eventBus,
  });

  const manifestService = new ManifestService(db);

  // ── Config endpoint ──────────────────────────────────────
  app.get('/api/config', async () => {
    const startTime = process.uptime() * 1000;
    return {
      llm: {
        provider: process.env.OPENAI_BASE_URL ? 'openai-compatible' : (process.env.LLM_PROVIDER ?? 'openai'),
        model: process.env.OPENAI_MODEL ?? process.env.LLM_MODEL ?? 'gpt-4',
        baseUrl: process.env.OPENAI_BASE_URL ?? undefined,
      },
      system: {
        version: process.env.npm_package_version ?? '0.1.0',
        uptime: startTime,
        dbPath: opts.dataDir ?? '.ctxmill',
      },
      agentDefaults: {
        harness: process.env.DEFAULT_HARNESS ?? 'langgraph',
        model: process.env.OPENAI_MODEL ?? process.env.LLM_MODEL ?? 'gpt-4',
        temperature: Number(process.env.DEFAULT_TEMPERATURE ?? '0.7'),
        maxTokens: Number(process.env.DEFAULT_MAX_TOKENS ?? '4096'),
      },
    };
  });

  // ── Route plugins ──────────────────────────────────────
  await app.register(agentRoutes, { prefix: '/api/agents', db, sse, interrupts, executor, runRegistry, learningPipeline, knowledgeStore, agentRunService, eventBus, dataDir, envFactory, manifestService });
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
  }
}
