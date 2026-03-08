import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CTXMillConfig, ResolvedConfig } from './types.js';
import { resolveConfig } from './resolve.js';
import { createKnowledgeStoreFromConfig, createLLMProviderFromConfig } from './factories.js';
import { createDatabase } from '../database/connection.js';
import { runMigrations } from '../database/migrations.js';
import { DatabaseRepository } from '../database/repository.js';
import type { KnowledgeStore, ContextProvider } from '../knowledge/types.js';
import { InMemoryContextProvider } from '../knowledge/context.js';
import type { LLMProvider } from '../llm/types.js';
import { LocalFunctionExecutor } from '../tool/executor.js';
import { AgentExecutor } from '../agent/executor.js';
import { TypedEventBus } from '../events/bus.js';
import { SimpleReflector } from '../learning/reflector.js';
import type { LearningPipeline } from '../learning/types.js';
import { DefaultLearningPipeline } from '../learning/pipeline.js';
import { SSEManager } from '../orchestrator/sse.js';
import { InterruptManager } from '../orchestrator/interrupt.js';
import { RunRegistry } from '../orchestrator/run-registry.js';

export interface AppContainer {
  config: ResolvedConfig;
  db: DatabaseRepository;
  knowledgeStore: KnowledgeStore;
  contextProvider: ContextProvider;
  llmProvider: LLMProvider;
  toolExecutor: LocalFunctionExecutor;
  agentExecutor: AgentExecutor;
  eventBus: TypedEventBus;
  reflector: SimpleReflector;
  learningPipeline: LearningPipeline;
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
  const knowledgeStore = createKnowledgeStoreFromConfig(config, dataDir);
  const contextProvider = new InMemoryContextProvider();

  // ── LLM ──────────────────────────────────────────────────
  const llmProvider = createLLMProviderFromConfig(config);

  // ── Tools ───────────────────────────────────────────────
  const toolExecutor = new LocalFunctionExecutor();

  // ── Events ──────────────────────────────────────────────
  const eventBus = new TypedEventBus();

  // ── Learning ────────────────────────────────────────────
  const reflector = new SimpleReflector(llmProvider);
  const learningPipeline = new DefaultLearningPipeline(reflector, knowledgeStore, db);

  // ── SSE + Interrupts ───────────────────────────────────
  const sseManager = new SSEManager();
  const interruptManager = new InterruptManager();

  // ── Agent Execution ─────────────────────────────────────
  const agentExecutor = new AgentExecutor(
    llmProvider,
    toolExecutor,
    knowledgeStore,
    interruptManager,
  );
  const runRegistry = new RunRegistry(db);
  await runRegistry.loadFromDb();

  return {
    config,
    db,
    knowledgeStore,
    contextProvider,
    llmProvider,
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
