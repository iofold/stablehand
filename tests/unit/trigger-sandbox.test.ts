import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventTriggerManager, MAX_TRIGGER_DEPTH } from '../../packages/ctxmill/src/events/trigger-manager.js';
import { AgentTurnService } from '../../packages/ctxmill/src/orchestrator/agent-turn-service.js';
import type { AgentTurnServiceDeps } from '../../packages/ctxmill/src/orchestrator/agent-turn-service.js';
import {
  createMockDatabase,
  createMockTriggerDb,
  createTestBus,
} from '../utils/event-bus-test-helpers.js';
import type { DatabaseRepository } from '../../packages/ctxmill/src/database/repository.js';
import type { AgentDefinition } from '../../packages/sandbox-daemon/src/types.js';
import type { SessionTurnExecutor } from '../../packages/ctxmill/src/orchestrator/session-turn-service.js';

async function* mockEventStream(events: Array<Record<string, unknown>>) {
  for (const e of events) {
    yield e;
  }
}

const settle = () => new Promise((r) => setTimeout(r, 15));

type MockSessionTurnService = SessionTurnExecutor & {
  executeSessionTurn: ReturnType<typeof vi.fn>;
};

function makeMockSessionTurnService(): MockSessionTurnService {
  return {
    executeSessionTurn: vi.fn().mockReturnValue(mockEventStream([
      { type: 'TEXT_MESSAGE_CONTENT', timestamp: Date.now(), messageId: 'msg-1', delta: 'sandbox response' },
    ])),
  } as MockSessionTurnService;
}

function makeAgentRunService(): ReturnType<typeof buildAgentRunService> & { sessionTurnService: MockSessionTurnService };
function makeAgentRunService(sessionTurnService: SessionTurnExecutor): ReturnType<typeof buildAgentRunService>;
function makeAgentRunService(sessionTurnService: SessionTurnExecutor = makeMockSessionTurnService()) {
  return buildAgentRunService(sessionTurnService);
}

function buildAgentRunService(sessionTurnService: SessionTurnExecutor) {
  const sessionManager = {
    ensureSession: vi.fn().mockResolvedValue({ sessionId: 'sandbox-1' }),
    startTurn: vi.fn().mockReturnValue(undefined),
    completeTurn: vi.fn().mockResolvedValue(undefined),
    abandonTurnDelivery: vi.fn().mockResolvedValue(undefined),
    getPendingSessionReset: vi.fn().mockReturnValue(undefined),
  };
  const db = createMockDatabase();
  const deps: AgentTurnServiceDeps = {
    db: db as unknown as AgentTurnServiceDeps['db'],
    sessionManager: sessionManager as unknown as AgentTurnServiceDeps['sessionManager'],
    sessionTurnService,
    eventBus: createTestBus(),
  };

  return {
    agentTurnService: new AgentTurnService(deps),
    sessionManager,
    sessionTurnService,
  };
}


describe('EventTriggerManager sandbox mode', () => {
  let manager: EventTriggerManager | undefined;
  afterEach(() => {
    manager?.shutdown();
    manager = undefined;
  });

  describe('sandbox routing via AgentRunService', () => {
    it('routes triggered run to SandboxRunService', async () => {
      const { agentTurnService, sessionTurnService } = makeAgentRunService();

      const agentDef: AgentDefinition = {
        name: 'triggered-agent',
        harness: 'claude-agents',
        harnessConfig: { provider: 'openai', model: 'gpt-5.4-mini' },
        tools: [],
        systemPrompt: 'You are a triggered agent.',
      };

      await agentTurnService.executeTurn({
        agentDef,
        messages: [{ id: 'msg-1', agentId: 'triggered-agent', role: 'user', content: 'triggered task', createdAt: new Date() }],
        agentId: 'triggered-agent',
        conversationId: 'conv-1',
        turnId: 'run-1',
        mode: 'background',
        taskDescription: 'triggered task',
      });

      expect(sessionTurnService.executeSessionTurn).toHaveBeenCalledTimes(1);
    });
  });

  describe('triggered run secret isolation', () => {
    it('sandbox executeSessionTurn receives the triggered agent name (not triggering agent)', async () => {
      const { agentTurnService, sessionTurnService } = makeAgentRunService();

      const triggeredAgentDef: AgentDefinition = {
        name: 'agent-B',
        harness: 'claude-agents',
        harnessConfig: { provider: 'openai', model: 'gpt-5.4-mini' },
        tools: ['search'],
        systemPrompt: 'I am agent B.',
      };

      await agentTurnService.executeTurn({
        agentDef: triggeredAgentDef,
        messages: [{ id: 'msg-1', agentId: 'agent-B', role: 'user', content: 'event payload', createdAt: new Date() }],
        agentId: 'agent-B',
        conversationId: 'conv-B',
        turnId: 'run-B',
        mode: 'background',
        taskDescription: 'event payload',
      });

      expect(sessionTurnService.executeSessionTurn).toHaveBeenCalledTimes(1);
      const [agentDef, conversationId, messages, turnId] = sessionTurnService.executeSessionTurn.mock.lastCall ?? [];
      expect(agentDef.name).toBe('agent-B');
      expect(conversationId).toBe('conv-B');
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        id: 'msg-1',
        agentId: 'agent-B',
        role: 'user',
        content: 'event payload',
      });
      expect(turnId).toBe('run-B');
    });
  });

  describe('trigger depth enforcement with real EventBus', () => {
    it('onFire callback receives incremented trigger depth', async () => {
      const onFire = vi.fn().mockResolvedValue(undefined);
      const bus = createTestBus();
      const mockDb = createMockTriggerDb();

      manager = new EventTriggerManager(bus, mockDb as unknown as DatabaseRepository, onFire);

      await manager.register({
        agentId: 'agent-1',
        eventType: 'custom.sandbox_test',
        taskTemplate: 'Handle event',
        enabled: true,
      });

      manager.emitCustomEvent('custom.sandbox_test', 'agent-1', { _triggerDepth: 3 });
      await settle();

      expect(onFire).toHaveBeenCalledTimes(1);
      expect(onFire).toHaveBeenCalledWith('agent-1', 'Handle event', expect.any(String), 4, undefined);
    });

    it('blocks triggers at MAX_TRIGGER_DEPTH regardless of execution mode', async () => {
      const onFire = vi.fn().mockResolvedValue(undefined);
      const bus = createTestBus();
      const mockDb = createMockTriggerDb();

      manager = new EventTriggerManager(bus, mockDb as unknown as DatabaseRepository, onFire);

      await manager.register({
        agentId: 'sandbox-agent',
        eventType: 'custom.deep_trigger',
        taskTemplate: 'Deep trigger',
        enabled: true,
      });

      manager.emitCustomEvent('custom.deep_trigger', 'sandbox-agent', {
        _triggerDepth: MAX_TRIGGER_DEPTH,
      });
      await settle();

      expect(onFire).not.toHaveBeenCalled();
    });

    it('full chain A -> B -> C -> D -> E -> blocked at F (depth 5)', async () => {
      const onFire = vi.fn().mockResolvedValue(undefined);
      const bus = createTestBus();
      const mockDb = createMockTriggerDb();

      manager = new EventTriggerManager(bus, mockDb as unknown as DatabaseRepository, onFire);

      await manager.register({
        agentId: 'agent-chain',
        eventType: 'custom.chain',
        taskTemplate: 'Chain step',
        enabled: true,
      });

      for (let depth = 0; depth < MAX_TRIGGER_DEPTH; depth++) {
        onFire.mockClear();
        manager.emitCustomEvent('custom.chain', 'agent-chain', { _triggerDepth: depth });
        await settle();
        expect(onFire).toHaveBeenCalledTimes(1);
        expect(onFire).toHaveBeenCalledWith('agent-chain', 'Chain step', expect.any(String), depth + 1, undefined);
      }

      onFire.mockClear();
      manager.emitCustomEvent('custom.chain', 'agent-chain', { _triggerDepth: MAX_TRIGGER_DEPTH });
      await settle();
      expect(onFire).not.toHaveBeenCalled();
    });
  });

  describe('fire-and-forget behavior', () => {
    it('triggering agent completes independently even if triggered run fails', async () => {
      const failingSandbox = {
        executeSessionTurn: vi.fn().mockImplementation(async function* () {
          if (Date.now() < 0) {
            yield { type: 'TEXT_MESSAGE_CONTENT', timestamp: Date.now(), delta: '' };
          }
          throw new Error('container failed to start');
        }),
      } as unknown as SessionTurnExecutor;

      const { agentTurnService, sessionManager } = makeAgentRunService(failingSandbox);

      await agentTurnService.executeTurn({
        agentDef: {
          name: 'failing-agent',
          harness: 'claude-agents',
          harnessConfig: { provider: 'openai', model: 'gpt-5.4-mini' },
          tools: [],
          systemPrompt: 'fail',
        },
        messages: [],
        agentId: 'failing-agent',
        conversationId: 'conv-1',
        turnId: 'run-fail',
        mode: 'background',
        taskDescription: 'will fail',
      });

      expect(sessionManager.completeTurn).toHaveBeenCalledWith('sandbox-1', 'run-fail', 'failing-agent', 'conv-1', 'error', expect.any(Number), expect.stringContaining('container failed'), undefined);
    });

    it('onFire callback is fire-and-forget — errors are isolated', async () => {
      const onFire = vi.fn().mockRejectedValue(new Error('triggered run failed'));
      const bus = createTestBus();
      const mockDb = createMockTriggerDb();

      manager = new EventTriggerManager(bus, mockDb as unknown as DatabaseRepository, onFire);

      await manager.register({
        agentId: 'agent-1',
        eventType: 'custom.fire_forget',
        taskTemplate: 'Fire and forget',
        enabled: true,
      });

      manager.emitCustomEvent('custom.fire_forget', 'agent-1', {});
      await settle();

      expect(onFire).toHaveBeenCalledTimes(1);
    });
  });

  describe('agentDef construction from manifest', () => {
    it('includes resourceLimits from agent manifest', () => {
      const agentRow = {
        name: 'manifest-agent',
        harness: 'claude-agents',
        harnessConfig: JSON.stringify({ provider: 'openai', model: 'gpt-5.4-mini' }),
        systemPrompt: 'I have manifest overrides.',
        tools: ['search'],
        description: 'Test agent',
        metadata: null,
        workspaceDir: '/workspace/manifest-agent',
        manifest: {
          resourceLimits: { cpus: 2, memoryMb: 1024, timeoutSec: 300 },
        },
      };

      const manifest = agentRow.manifest as Record<string, unknown> | null;
      const perAgentResourceLimits = manifest?.resourceLimits as Record<string, unknown> | undefined;

      const agentDef = {
        name: agentRow.name,
        harness: agentRow.harness ?? undefined,
        harnessConfig: JSON.parse(agentRow.harnessConfig) as Record<string, unknown>,
        systemPrompt: agentRow.systemPrompt,
        tools: agentRow.tools,
        description: agentRow.description ?? undefined,
        metadata: agentRow.metadata ?? undefined,
        workspaceDir: agentRow.workspaceDir ?? undefined,
        resourceLimits: perAgentResourceLimits,
      };

      expect(agentDef.resourceLimits).toEqual({ cpus: 2, memoryMb: 1024, timeoutSec: 300 });
    });

    it('resourceLimits is undefined when manifest is null', () => {
      const agentRow = {
        name: 'basic-agent',
        manifest: null,
      };

      const manifest = agentRow.manifest as Record<string, unknown> | null;
      const perAgentResourceLimits = manifest?.resourceLimits as Record<string, unknown> | undefined;

      expect(perAgentResourceLimits).toBeUndefined();
    });

    it('resourceLimits is undefined when manifest exists but has no resourceLimits key', () => {
      const agentRow = {
        name: 'partial-manifest-agent',
        manifest: { tools: ['search'], systemPrompt: 'Hello' },
      };

      const manifest = agentRow.manifest as Record<string, unknown> | null;
      const perAgentResourceLimits = manifest?.resourceLimits as Record<string, unknown> | undefined;

      expect(perAgentResourceLimits).toBeUndefined();
    });
  });

  describe('event payload as initial message', () => {
    it('triggered run receives event payload interpolated into task template', async () => {
      const onFire = vi.fn().mockResolvedValue(undefined);
      const bus = createTestBus();
      const mockDb = createMockTriggerDb();

      manager = new EventTriggerManager(bus, mockDb as unknown as DatabaseRepository, onFire);

      await manager.register({
        agentId: 'agent-1',
        eventType: 'custom.data_event',
        taskTemplate: 'Process data: source={{payload.source}}, count={{payload.count}}',
        enabled: true,
      });

      manager.emitCustomEvent('custom.data_event', 'agent-1', {
        source: 'pipeline-A',
        count: 42,
      });
      await settle();

      expect(onFire).toHaveBeenCalledTimes(1);
      expect(onFire).toHaveBeenCalledWith(
        'agent-1',
        'Process data: source=pipeline-A, count=42',
        expect.any(String),
        1,
        undefined,
      );
    });
  });
});
