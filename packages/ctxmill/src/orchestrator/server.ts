import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { agentRoutes, runsRoutes } from './routes/agents.js';
import { catalogRoutes } from './routes/catalogs.js';
import { SSEManager } from './sse.js';
import { InterruptManager } from './interrupt.js';
import { AgentRunService } from './agent-run-service.js';
import type { DatabaseRepository } from '../database/repository.js';
import type { AgentExecutor } from '../agent/executor.js';
import type { AgentDefinition } from '../types.js';
import type { LearningPipeline } from '../learning/types.js';
import type { KnowledgeStore } from '../knowledge/types.js';
import { RunRegistry } from './run-registry.js';

export interface ServerOptions {
  port?: number;
  host?: string;
  db: DatabaseRepository;
  executor: AgentExecutor;
  /** Map of agent ID → AgentDefinition for registered agents. */
  agents: Map<string, AgentDefinition>;
  runRegistry?: RunRegistry;
  learningPipeline?: LearningPipeline;
  knowledgeStore?: KnowledgeStore;
}

/**
 * Create and configure the Fastify orchestrator server.
 *
 * The server is the composition root that wires together
 * the database, SSE manager, interrupt manager, and agent routes.
 */
export async function createServer(opts: ServerOptions): Promise<FastifyInstance> {
  const { db, executor, agents, port: _port, host: _host, runRegistry: optRunRegistry, learningPipeline, knowledgeStore } = opts;
  const runRegistry = optRunRegistry ?? new RunRegistry();

  const app = Fastify({ logger: true });

  // CORS — configurable via CORS_ORIGINS env var, defaults to dev ports
  await app.register(cors, {
    origin: process.env.CORS_ORIGINS
      ? process.env.CORS_ORIGINS.split(',')
      : ['http://localhost:5173', 'http://localhost:3000'],
  });

  // Shared infrastructure
  const sse = new SSEManager();
  const interrupts = new InterruptManager();

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
  });

  // ── Route plugins ──────────────────────────────────────
  await app.register(agentRoutes, { prefix: '/api/agents', db, sse, interrupts, executor, agents, runRegistry, learningPipeline, knowledgeStore, agentRunService });
  await app.register(runsRoutes, { prefix: '/api/runs', runRegistry });
  await app.register(catalogRoutes, { prefix: '/api/catalogs' });

  // ── Graceful shutdown ──────────────────────────────────
  app.addHook('onClose', async () => {
    sse.shutdown();
    interrupts.shutdown();
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
