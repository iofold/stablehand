import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CTXMillConfig, ResolvedConfig } from './types.js';
import { resolveConfig } from './resolve.js';
import { createDatabase } from '../database/connection.js';
import { runMigrations } from '../database/migrations.js';
import { DatabaseRepository } from '../database/repository.js';
import { InMemoryKnowledgeStore } from '../knowledge/store.js';
import { InMemoryContextProvider } from '../knowledge/context.js';
import { LocalFunctionExecutor } from '../tool/executor.js';
import { AgentExecutor } from '../agent/executor.js';
import { TypedEventBus } from '../events/bus.js';
import { SimpleReflector } from '../learning/reflector.js';
import { DefaultLearningPipeline } from '../learning/pipeline.js';
import { SSEManager } from '../orchestrator/sse.js';
import { InterruptManager } from '../orchestrator/interrupt.js';
import { RunRegistry } from '../orchestrator/run-registry.js';

export interface AppContainer {
  config: ResolvedConfig;
  db: DatabaseRepository;
  knowledgeStore: InMemoryKnowledgeStore;
  contextProvider: InMemoryContextProvider;
  toolExecutor: LocalFunctionExecutor;
  agentExecutor: AgentExecutor;
  eventBus: TypedEventBus;
  reflector: SimpleReflector;
  learningPipeline: DefaultLearningPipeline;
  sseManager: SSEManager;
  interruptManager: InterruptManager;
  runRegistry: RunRegistry;
}

/**
 * Build the application dependency graph. This is the single composition root
 * that wires every provider for Level 1 (local / SQLite) operation.
 *
 * @param userConfig - Partial config supplied by the user (or defineConfig)
 * @param dataDir    - Root directory for persisted data (database, knowledge, audit)
 */
export async function createContainer(
  userConfig: CTXMillConfig,
  dataDir: string,
): Promise<AppContainer> {
  const config = resolveConfig(userConfig);

  // ── Database ────────────────────────────────────────────
  const dbPath = join(dataDir, config.database.path || 'data.db');
  mkdirSync(dirname(dbPath), { recursive: true });
  const { db: drizzleDb, sqlite } = createDatabase(dbPath);
  runMigrations(sqlite);
  const db = new DatabaseRepository(drizzleDb);

  // ── Knowledge ───────────────────────────────────────────
  const knowledgeStore = new InMemoryKnowledgeStore(dataDir);
  const contextProvider = new InMemoryContextProvider();

  // ── Tools ───────────────────────────────────────────────
  const toolExecutor = new LocalFunctionExecutor();

  // ── Events ──────────────────────────────────────────────
  const eventBus = new TypedEventBus();

  // ── Learning ────────────────────────────────────────────
  const reflector = new SimpleReflector({
    apiKey: config.llm.apiKey,
    baseUrl: config.llm.baseUrl || undefined,
    model: config.llm.model,
    provider: config.llm.provider,
  });
  const learningPipeline = new DefaultLearningPipeline(reflector, knowledgeStore, db);

  // ── Agent Execution ─────────────────────────────────────
  const agentExecutor = new AgentExecutor(
    {
      apiKey: config.llm.apiKey,
      baseUrl: config.llm.baseUrl || undefined,
      model: config.llm.model,
      provider: (config.llm.provider as 'anthropic' | 'openai') || 'anthropic',
    },
    toolExecutor,
    knowledgeStore,
  );

  // ── SSE + Interrupts ───────────────────────────────────
  const sseManager = new SSEManager();
  const interruptManager = new InterruptManager();
  const runRegistry = new RunRegistry(db);
  await runRegistry.loadFromDb();

  return {
    config,
    db,
    knowledgeStore,
    contextProvider,
    toolExecutor,
    agentExecutor,
    eventBus,
    reflector,
    learningPipeline,
    sseManager,
    interruptManager,
    runRegistry,
  };
}
