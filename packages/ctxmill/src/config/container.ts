import type { CTXMillConfig, ResolvedConfig } from './types.js';
import { resolveConfig } from './resolve.js';
import { createKnowledgeStoreFromConfig, createLLMProviderFromConfig, createEnvironmentFactory } from './factories.js';
import { createDatabase, type DatabaseConnection } from '../database/connection.js';
import { runMigrations } from '../database/migrations.js';
import { DatabaseRepository } from '../database/repository.js';
import type { KnowledgeStore, ContextProvider } from '../knowledge/types.js';
import { InMemoryContextProvider } from '../knowledge/context.js';
import type { LLMProvider } from '../llm/types.js';
import { LocalFunctionExecutor } from '../tool/executor.js';
import { AgentExecutor } from '../agent/executor.js';
import { DefaultHarnessRegistry } from '../harness/registry.js';
import { LangGraphHarness } from '../harness/langgraph.js';
import { TypedEventBus } from '../events/bus.js';
import { SimpleReflector } from '../learning/reflector.js';
import type { LearningPipeline } from '../learning/types.js';
import { DefaultLearningPipeline } from '../learning/pipeline.js';
import { SSEManager } from '../orchestrator/sse.js';
import { SSEBroadcaster } from '../orchestrator/sse-broadcaster.js';
import { InterruptManager } from '../orchestrator/interrupt.js';
import { RunRegistry } from '../orchestrator/run-registry.js';
import { LearningEventSubscriber } from '../learning/event-subscriber.js';
import { SuspendedRunMatcher } from '../orchestrator/suspended-run-matcher.js';
import { EventTriggerManager } from '../events/trigger-manager.js';
import type { EnvironmentFactory } from '../workspace/types.js';
import { AgentRunService } from '../orchestrator/agent-run-service.js';
import { ManifestService } from '../manifest/index.js';

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
  sseBroadcaster: SSEBroadcaster;
  interruptManager: InterruptManager;
  runRegistry: RunRegistry;
  learningSubscriber: LearningEventSubscriber;
  suspendedRunMatcher: SuspendedRunMatcher;
  triggerManager: EventTriggerManager;
  envFactory: EnvironmentFactory;
  agentRunService: AgentRunService;
  manifestService: ManifestService;
  /** Gracefully close database connections */
  close: () => Promise<void>;
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
  const dbConn: DatabaseConnection = await createDatabase(config.database, dataDir);

  // Run migrations for the active dialect
  if (dbConn.dialect === 'sqlite' && dbConn.sqlite) {
    runMigrations(dbConn.sqlite);
  } else if (dbConn.dialect === 'postgres' && dbConn.pgClient) {
    const { runMigrationsPg } = await import('../database/migrations-pg.js');
    await runMigrationsPg(dbConn.pgClient);
  }

  const db = new DatabaseRepository(dbConn.db, dbConn.dialect);

  // ── Knowledge ───────────────────────────────────────────
  const knowledgeStore = createKnowledgeStoreFromConfig(config, dataDir);
  const contextProvider = new InMemoryContextProvider();

  // ── LLM ──────────────────────────────────────────────────
  const llmProvider = createLLMProviderFromConfig(config);

  // ── Tools ───────────────────────────────────────────────
  const toolExecutor = new LocalFunctionExecutor();

  // ── Events ──────────────────────────────────────────────
  const eventBus = new TypedEventBus({
    persistEvent: (type, agentId, payload) => {
      try {
        db.saveEvent(type, agentId, payload);
      } catch (err) {
        console.error('[EventBus] persist error:', err);
      }
    },
  });

  // ── Learning ────────────────────────────────────────────
  const reflector = new SimpleReflector(llmProvider);
  const learningPipeline = new DefaultLearningPipeline(reflector, knowledgeStore, db, eventBus);

  // ── SSE + Interrupts ───────────────────────────────────
  const sseManager = new SSEManager(eventBus);
  const sseBroadcaster = new SSEBroadcaster(sseManager, eventBus);
  const interruptManager = new InterruptManager(eventBus);

  // ── Event Subscribers ─────────────────────────────────
  const learningSubscriber = new LearningEventSubscriber(learningPipeline, eventBus, db);

  // ── Suspend/Resume ──────────────────────────────────────
  const suspendedRunMatcher = new SuspendedRunMatcher(eventBus, db, async (condition, _triggerEvent) => {
    console.log(`[SuspendedRunMatcher] resuming run ${condition.runId} for agent ${condition.agentId} (event: ${condition.eventType})`);
    try {
      await db.updateRun(condition.runId, { status: 'running' });
    } catch (err) {
      console.error(`[SuspendedRunMatcher] failed to update run status for ${condition.runId}:`, err);
    }
  });

  // ── Workspace Environment ────────────────────────────────
  const envFactory: EnvironmentFactory = createEnvironmentFactory(config.execution.type);

  // ── Harness Registry ────────────────────────────────────
  const harnessRegistry = new DefaultHarnessRegistry();
  const langGraphHarness = new LangGraphHarness(
    llmProvider,
    toolExecutor,
    knowledgeStore,
    interruptManager,
    envFactory,
  );
  harnessRegistry.register(langGraphHarness);

  // ── Agent Execution ─────────────────────────────────────
  const agentExecutor = new AgentExecutor(
    llmProvider,
    toolExecutor,
    knowledgeStore,
    interruptManager,
    envFactory,
    eventBus,
    harnessRegistry,
  );
  const runRegistry = new RunRegistry(db, eventBus);
  await runRegistry.loadFromDb();

  // ── Agent Run Service ────────────────────────────────────
  // Lazy ref so the onFire callback (defined below) can access it after construction.
  let agentRunServiceRef: AgentRunService | null = null;

  // ── Event Triggers ─────────────────────────────────────
  const triggerManager = new EventTriggerManager(eventBus, db, async (agentId, task, triggerId) => {
    const agent = await db.getAgent(agentId);
    if (!agent) {
      console.error(`[EventTriggerManager] agent ${agentId} not found for trigger ${triggerId}`);
      return;
    }
    // Create conversation + run for the triggered background run
    const conv = await db.createConversation(agentId);
    const run = await runRegistry.startRun(agentId, conv.id, 'background', task);

    // Persist the synthetic user message
    await db.addMessage({ agentId, conversationId: conv.id, role: 'user', content: task });
    const allMessages = await db.getMessages(conv.id);
    const messages = allMessages.map((m) => ({
      id: m.id,
      agentId: m.agentId ?? agentId,
      role: m.role as 'user' | 'assistant' | 'system',
      content: m.content,
      toolCallId: m.toolCallId ?? undefined,
      createdAt: new Date(m.createdAt),
    }));

    const agentDef = {
      name: agent.name,
      model: agent.model,
      systemPrompt: agent.systemPrompt,
      tools: agent.tools,
      description: agent.description ?? undefined,
      metadata: agent.metadata ?? undefined,
      workspaceDir: agent.workspaceDir ?? undefined,
    };

    // Fire-and-forget — AgentRunService handles SSE broadcasting, run.text_chunk events,
    // message persistence, run completion, and learning traces.
    void agentRunServiceRef!.executeRun({
      agentDef,
      messages,
      agentId,
      conversationId: conv.id,
      runId: run.id,
      taskDescription: task,
    }).then(() => {
      // Emit trigger.fired event after successful run
      eventBus.emit('trigger.fired', {
        triggerId,
        agentId,
        eventType: 'trigger.fired',
        runId: run.id,
        timestamp: Date.now(),
      });
    }).catch((err) => {
      console.error(`[EventTriggerManager] run error for trigger ${triggerId}:`, err);
    });
  });
  await triggerManager.start();

  const agentRunService = new AgentRunService({
    executor: agentExecutor,
    sse: sseManager,
    db,
    runRegistry,
    learningPipeline,
    eventBus,
  });
  agentRunServiceRef = agentRunService;

  const manifestService = new ManifestService(db);

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
    sseBroadcaster,
    interruptManager,
    runRegistry,
    learningSubscriber,
    suspendedRunMatcher,
    triggerManager,
    envFactory,
    agentRunService,
    manifestService,
    close: async () => { await dbConn.close(); },
  };
}
