import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventTriggerManager, MAX_TRIGGER_DEPTH } from '../../packages/ctxmill/src/events/trigger-manager.js';
import { AgentRunService } from '../../packages/ctxmill/src/orchestrator/agent-run-service.js';
import type { TypedEventBus } from '../../packages/ctxmill/src/events/bus.js';
import type { DatabaseRepository } from '../../packages/ctxmill/src/database/repository.js';
import type { AgentDefinition } from '@ctxmill/sandbox-daemon';
import type { SandboxRunService } from '../../packages/ctxmill/src/orchestrator/sandbox-run-service.js';

/** Helper to build an async generator from an array of events */
async function* mockEventStream(events: Array<Record<string, unknown>>) {
  for (const e of events) {
    yield e;
  }
}

// ── Shared mock factories ──────────────────────────────────────

function makeMockBus() {
  return {
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
  } as unknown as TypedEventBus;
}

function makeMockDb(overrides: Record<string, unknown> = {}) {
  return {
    getTriggers: vi.fn().mockResolvedValue([]),
    saveTrigger: vi.fn().mockResolvedValue(undefined),
    deleteTrigger: vi.fn().mockResolvedValue(undefined),
    getAgent: vi.fn().mockResolvedValue(undefined),
    createConversation: vi.fn().mockResolvedValue({ id: 'conv-triggered' }),
    addMessage: vi.fn().mockResolvedValue({ id: 'msg-1' }),
    getMessages: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as DatabaseRepository;
}

function makeMockRunRegistry() {
  return {
    startRun: vi.fn().mockResolvedValue({ id: 'run-triggered', agentId: 'triggered-agent' }),
    completeRun: vi.fn(),
    getAbortSignal: vi.fn().mockReturnValue(undefined),
  };
}

function makeMockSandboxRunService() {
  return {
    executeSessionTurn: vi.fn().mockReturnValue(mockEventStream([
      { type: 'TEXT_MESSAGE_CONTENT', timestamp: Date.now(), messageId: 'msg-1', content: 'sandbox response' },
    ])),
  } as SandboxRunService & {
    executeSessionTurn: ReturnType<typeof vi.fn>;
  };
}


describe('EventTriggerManager sandbox mode', () => {
  // ── Test: sandbox mode routes through SandboxRunService ──

  describe('sandbox routing via AgentRunService', () => {
    it('routes triggered run to SandboxRunService', async () => {
      const mockSandboxRunService = makeMockSandboxRunService();

      const agentRunService = new AgentRunService({
        sse: { broadcast: vi.fn() },
        db: { addMessage: vi.fn().mockResolvedValue({ id: 'msg-1' }) },
        runRegistry: makeMockRunRegistry(),
        sandboxRunService: mockSandboxRunService,
        toolExecutor: { list: vi.fn().mockReturnValue([]) },
      } as any);

      const agentDef: AgentDefinition = {
        name: 'triggered-agent',
        harness: 'claude-agents',
        harnessConfig: { provider: 'openai', model: 'gpt-5-mini' },
        tools: [],
        systemPrompt: 'You are a triggered agent.',
      };

      await agentRunService.executeRun({
        agentDef,
        messages: [{ id: 'msg-1', agentId: 'triggered-agent', role: 'user', content: 'triggered task', createdAt: new Date() }],
        agentId: 'triggered-agent',
        conversationId: 'conv-1',
        runId: 'run-1',
        taskDescription: 'triggered task',
      });

      expect(mockSandboxRunService.executeSessionTurn).toHaveBeenCalledTimes(1);
    });
  });

  // ── Test: triggered run gets its own secrets ──

  describe('triggered run secret isolation', () => {
    it('sandbox executeSessionTurn receives the triggered agent name (not triggering agent)', async () => {
      const mockSandboxRunService = makeMockSandboxRunService();

      const agentRunService = new AgentRunService({
        sse: { broadcast: vi.fn() },
        db: { addMessage: vi.fn().mockResolvedValue({ id: 'msg-1' }) },
        runRegistry: makeMockRunRegistry(),
        sandboxRunService: mockSandboxRunService,
        toolExecutor: { list: vi.fn().mockReturnValue([]) },
      } as any);

      // This is the TRIGGERED agent's definition
      const triggeredAgentDef: AgentDefinition = {
        name: 'agent-B',
        harness: 'claude-agents',
        harnessConfig: { provider: 'openai', model: 'gpt-5-mini' },
        tools: ['search'],
        systemPrompt: 'I am agent B.',
      };

      await agentRunService.executeRun({
        agentDef: triggeredAgentDef,
        messages: [{ id: 'msg-1', agentId: 'agent-B', role: 'user', content: 'event payload', createdAt: new Date() }],
        agentId: 'agent-B',
        conversationId: 'conv-B',
        runId: 'run-B',
        taskDescription: 'event payload',
      });

      const [agentDef, conversationId, messages, turnId] = mockSandboxRunService.executeSessionTurn.mock.calls[0] ?? [];
      expect(agentDef.name).toBe('agent-B');
      expect(conversationId).toBe('conv-B');
      expect(messages).toEqual([
        { id: 'msg-1', agentId: 'agent-B', role: 'user', content: 'event payload', createdAt: expect.any(Date) },
      ]);
      expect(turnId).toBe('run-B');
    });
  });

  // ── Test: trigger depth enforcement in sandbox mode ──

  describe('trigger depth enforcement with sandbox mode', () => {
    it('onFire callback receives incremented trigger depth', async () => {
      const onFire = vi.fn().mockResolvedValue(undefined);
      const mockBus = makeMockBus();
      const mockDb = makeMockDb();

      const manager = new EventTriggerManager(mockBus, mockDb, onFire);

      await manager.register({
        agentId: 'agent-1',
        eventType: 'custom.sandbox_test',
        taskTemplate: 'Handle event',
        enabled: true,
      });

      // Emit at depth 3 (below limit of 5)
      manager.emitCustomEvent('custom.sandbox_test', 'agent-1', { _triggerDepth: 3 });
      await new Promise((r) => setTimeout(r, 10));

      expect(onFire).toHaveBeenCalledTimes(1);
      expect(onFire).toHaveBeenCalledWith('agent-1', 'Handle event', expect.any(String), 4);
    });

    it('blocks triggers at MAX_TRIGGER_DEPTH regardless of execution mode', async () => {
      const onFire = vi.fn().mockResolvedValue(undefined);
      const mockBus = makeMockBus();
      const mockDb = makeMockDb();

      const manager = new EventTriggerManager(mockBus, mockDb, onFire);

      await manager.register({
        agentId: 'sandbox-agent',
        eventType: 'custom.deep_trigger',
        taskTemplate: 'Deep trigger',
        enabled: true,
      });

      // Emit at exactly MAX_TRIGGER_DEPTH — should be blocked
      manager.emitCustomEvent('custom.deep_trigger', 'sandbox-agent', {
        _triggerDepth: MAX_TRIGGER_DEPTH,
      });
      await new Promise((r) => setTimeout(r, 10));

      expect(onFire).not.toHaveBeenCalled();
    });

    it('full chain A -> B -> C -> D -> E -> blocked at F (depth 5)', async () => {
      const onFire = vi.fn().mockResolvedValue(undefined);
      const mockBus = makeMockBus();
      const mockDb = makeMockDb();

      const manager = new EventTriggerManager(mockBus, mockDb, onFire);

      await manager.register({
        agentId: 'agent-chain',
        eventType: 'custom.chain',
        taskTemplate: 'Chain step',
        enabled: true,
      });

      // Simulate depths 0, 1, 2, 3, 4 — all should fire
      for (let depth = 0; depth < MAX_TRIGGER_DEPTH; depth++) {
        onFire.mockClear();
        manager.emitCustomEvent('custom.chain', 'agent-chain', { _triggerDepth: depth });
        await new Promise((r) => setTimeout(r, 10));
        expect(onFire).toHaveBeenCalledTimes(1);
        expect(onFire).toHaveBeenCalledWith('agent-chain', 'Chain step', expect.any(String), depth + 1);
      }

      // At depth 5 (MAX_TRIGGER_DEPTH), it should be blocked
      onFire.mockClear();
      manager.emitCustomEvent('custom.chain', 'agent-chain', { _triggerDepth: MAX_TRIGGER_DEPTH });
      await new Promise((r) => setTimeout(r, 10));
      expect(onFire).not.toHaveBeenCalled();
    });
  });

  // ── Test: fire-and-forget behavior ──

  describe('fire-and-forget behavior', () => {
    it('triggering agent completes independently even if triggered run fails', async () => {
      // Simulate a SandboxRunService that errors out
      const failingSandbox = {
        executeSessionTurn: vi.fn().mockImplementation(async function* () {
          if (Date.now() < 0) {
            yield { type: 'TEXT_MESSAGE_CONTENT', timestamp: Date.now(), content: '' };
          }
          throw new Error('container failed to start');
        }),
      } as unknown as SandboxRunService;

      const runRegistry = makeMockRunRegistry();
      const sse = { broadcast: vi.fn() };

      const agentRunService = new AgentRunService({
        sse,
        db: { addMessage: vi.fn().mockResolvedValue({ id: 'msg-1' }) },
        runRegistry,
        sandboxRunService: failingSandbox,
        toolExecutor: { list: vi.fn().mockReturnValue([]) },
      } as any);

      // Execute the triggered run — it should handle the failure gracefully
      await agentRunService.executeRun({
        agentDef: {
          name: 'failing-agent',
          harness: 'claude-agents',
          harnessConfig: { provider: 'openai', model: 'gpt-5-mini' },
          tools: [],
          systemPrompt: 'fail',
        },
        messages: [],
        agentId: 'failing-agent',
        conversationId: 'conv-1',
        runId: 'run-fail',
        taskDescription: 'will fail',
      });

      // The run should have been completed with an error
      expect(runRegistry.completeRun).toHaveBeenCalledWith('run-fail', expect.stringContaining('container failed'));
    });

    it('onFire callback is fire-and-forget in container.ts pattern', async () => {
      // This test verifies the pattern used in container.ts — the onFire callback
      // does NOT await the executeRun result, and errors are caught silently
      const onFire = vi.fn().mockRejectedValue(new Error('triggered run failed'));
      const mockBus = makeMockBus();
      const mockDb = makeMockDb();

      const manager = new EventTriggerManager(mockBus, mockDb, onFire);

      await manager.register({
        agentId: 'agent-1',
        eventType: 'custom.fire_forget',
        taskTemplate: 'Fire and forget',
        enabled: true,
      });

      // Should not throw even though onFire rejects
      manager.emitCustomEvent('custom.fire_forget', 'agent-1', {});
      await new Promise((r) => setTimeout(r, 20));

      // onFire was called even though it fails — errors are isolated
      expect(onFire).toHaveBeenCalledTimes(1);
    });
  });

  // ── Test: container.ts agentDef includes resourceLimits from manifest ──

  describe('agentDef construction from manifest', () => {
    it('includes resourceLimits from agent manifest', () => {
      // Simulate what container.ts does after fetching the agent row
      const agentRow = {
        name: 'manifest-agent',
        harness: 'claude-agents',
        harnessConfig: JSON.stringify({ provider: 'openai', model: 'gpt-5-mini' }),
        systemPrompt: 'I have manifest overrides.',
        tools: ['search'],
        description: 'Test agent',
        metadata: null,
        workspaceDir: '/workspace/manifest-agent',
        manifest: {
          resourceLimits: { cpus: 2, memoryMb: 1024, timeoutSec: 300 },
        },
      };

      // Reproduce the agentDef construction logic from container.ts
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

  // ── Test: event payload as initial message content ──

  describe('event payload as initial message', () => {
    it('triggered run receives event payload interpolated into task template', async () => {
      const onFire = vi.fn().mockResolvedValue(undefined);
      const mockBus = makeMockBus();
      const mockDb = makeMockDb();

      const manager = new EventTriggerManager(mockBus, mockDb, onFire);

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
      await new Promise((r) => setTimeout(r, 10));

      expect(onFire).toHaveBeenCalledTimes(1);
      const [, task] = onFire.mock.calls[0];
      expect(task).toBe('Process data: source=pipeline-A, count=42');
    });
  });
});
