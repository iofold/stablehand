import { describe, it, expect, vi } from 'vitest';
import { RunRegistry, MAX_CONCURRENT_RUNS_PER_AGENT } from '../../packages/ctxmill/src/orchestrator/run-registry.js';
import { EventTriggerManager, MAX_TRIGGER_DEPTH } from '../../packages/ctxmill/src/events/trigger-manager.js';
import type { TypedEventBus } from '../../packages/ctxmill/src/events/bus.js';
import type { DatabaseRepository } from '../../packages/ctxmill/src/database/repository.js';

describe('Trigger cascade protection', () => {
  // ─── Protection 2: concurrent run limit ───────────────────────────

  it('should export MAX_CONCURRENT_RUNS_PER_AGENT = 3', () => {
    expect(MAX_CONCURRENT_RUNS_PER_AGENT).toBe(3);
  });

  it('should allow up to the concurrent limit', async () => {
    const registry = new RunRegistry();

    await registry.startRun('agent-1', 'conv-1', 'background');
    await registry.startRun('agent-1', 'conv-2', 'background');
    await registry.startRun('agent-1', 'conv-3', 'background');

    expect(registry.getActiveRuns('agent-1').length).toBe(3);
  });

  it('should reject runs beyond the concurrent limit', async () => {
    const registry = new RunRegistry();

    await registry.startRun('agent-1', 'conv-1', 'background');
    await registry.startRun('agent-1', 'conv-2', 'background');
    await registry.startRun('agent-1', 'conv-3', 'background');

    await expect(
      registry.startRun('agent-1', 'conv-4', 'background'),
    ).rejects.toThrow(/concurrent run limit/i);
  });

  it('should respect a custom maxConcurrent option', async () => {
    const registry = new RunRegistry();

    await registry.startRun('agent-1', 'conv-1', 'background');
    await registry.startRun('agent-1', 'conv-2', 'background');

    // With maxConcurrent=2, the 3rd should fail
    await expect(
      registry.startRun('agent-1', 'conv-3', 'background', undefined, { maxConcurrent: 2 }),
    ).rejects.toThrow(/concurrent run limit/i);
  });

  it('should allow runs for different agents independently', async () => {
    const registry = new RunRegistry();

    await registry.startRun('agent-1', 'conv-1', 'background');
    await registry.startRun('agent-1', 'conv-2', 'background');
    await registry.startRun('agent-1', 'conv-3', 'background');

    // agent-2 should still be able to start runs
    const run = await registry.startRun('agent-2', 'conv-4', 'background');
    expect(run.agentId).toBe('agent-2');
  });

  it('should allow new runs after completing existing ones', async () => {
    const registry = new RunRegistry();

    const run1 = await registry.startRun('agent-1', 'conv-1', 'background');
    await registry.startRun('agent-1', 'conv-2', 'background');
    await registry.startRun('agent-1', 'conv-3', 'background');

    // Complete one run
    await registry.completeRun(run1.id);

    // Now a new run should be allowed
    const run4 = await registry.startRun('agent-1', 'conv-4', 'background');
    expect(run4.agentId).toBe('agent-1');
  });

  // ─── Protection 1: max trigger depth ──────────────────────────────

  it('should export MAX_TRIGGER_DEPTH = 5', () => {
    expect(MAX_TRIGGER_DEPTH).toBe(5);
  });

  it('should skip events with _triggerDepth >= MAX_TRIGGER_DEPTH', async () => {
    const onFire = vi.fn().mockResolvedValue(undefined);
    const mockBus = {
      on: vi.fn(),
      off: vi.fn(),
      emit: vi.fn(),
    } as unknown as TypedEventBus;
    const mockDb = {
      getTriggers: vi.fn().mockResolvedValue([]),
      saveTrigger: vi.fn().mockResolvedValue(undefined),
      deleteTrigger: vi.fn().mockResolvedValue(undefined),
    } as unknown as DatabaseRepository;

    const manager = new EventTriggerManager(mockBus, mockDb, onFire);

    // Register a trigger that listens for 'custom.test'
    await manager.register({
      agentId: 'agent-1',
      eventType: 'custom.test',
      taskTemplate: 'Do something',
      enabled: true,
    });

    // Emit with depth below limit — should fire
    manager.emitCustomEvent('custom.test', 'agent-1', { _triggerDepth: 3 });
    // Allow microtask to resolve
    await new Promise((r) => setTimeout(r, 10));
    expect(onFire).toHaveBeenCalledTimes(1);
    // The onFire should be called with incremented depth (3+1=4)
    expect(onFire).toHaveBeenCalledWith('agent-1', 'Do something', expect.any(String), 4);

    onFire.mockClear();

    // Emit with depth at the limit — should be skipped
    manager.emitCustomEvent('custom.test', 'agent-1', { _triggerDepth: MAX_TRIGGER_DEPTH });
    await new Promise((r) => setTimeout(r, 10));
    expect(onFire).not.toHaveBeenCalled();

    // Emit with depth above the limit — should also be skipped
    manager.emitCustomEvent('custom.test', 'agent-1', { _triggerDepth: MAX_TRIGGER_DEPTH + 2 });
    await new Promise((r) => setTimeout(r, 10));
    expect(onFire).not.toHaveBeenCalled();
  });

  it('should allow events with no _triggerDepth (depth 0)', async () => {
    const onFire = vi.fn().mockResolvedValue(undefined);
    const mockBus = {
      on: vi.fn(),
      off: vi.fn(),
      emit: vi.fn(),
    } as unknown as TypedEventBus;
    const mockDb = {
      getTriggers: vi.fn().mockResolvedValue([]),
      saveTrigger: vi.fn().mockResolvedValue(undefined),
      deleteTrigger: vi.fn().mockResolvedValue(undefined),
    } as unknown as DatabaseRepository;

    const manager = new EventTriggerManager(mockBus, mockDb, onFire);

    await manager.register({
      agentId: 'agent-1',
      eventType: 'custom.test',
      taskTemplate: 'Do something',
      enabled: true,
    });

    // Emit with no _triggerDepth — should fire with depth 1
    manager.emitCustomEvent('custom.test', 'agent-1', { someData: 'hello' });
    await new Promise((r) => setTimeout(r, 10));
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(onFire).toHaveBeenCalledWith('agent-1', 'Do something', expect.any(String), 1);
  });

  it('should propagate _triggerDepth through emitCustomEvent', async () => {
    const onFire = vi.fn().mockResolvedValue(undefined);
    const mockBus = {
      on: vi.fn(),
      off: vi.fn(),
      emit: vi.fn(),
    } as unknown as TypedEventBus;
    const mockDb = {
      getTriggers: vi.fn().mockResolvedValue([]),
      saveTrigger: vi.fn().mockResolvedValue(undefined),
      deleteTrigger: vi.fn().mockResolvedValue(undefined),
    } as unknown as DatabaseRepository;

    const manager = new EventTriggerManager(mockBus, mockDb, onFire);

    await manager.register({
      agentId: 'agent-1',
      eventType: 'custom.chain',
      taskTemplate: 'Chain step',
      enabled: true,
    });

    // Simulate a chain: depth 0 → 1 → 2 → 3 → 4 → blocked at 5
    for (let depth = 0; depth < MAX_TRIGGER_DEPTH; depth++) {
      onFire.mockClear();
      manager.emitCustomEvent('custom.chain', 'agent-1', { _triggerDepth: depth });
      await new Promise((r) => setTimeout(r, 10));
      expect(onFire).toHaveBeenCalledTimes(1);
      expect(onFire).toHaveBeenCalledWith('agent-1', 'Chain step', expect.any(String), depth + 1);
    }

    // At MAX_TRIGGER_DEPTH, it should be blocked
    onFire.mockClear();
    manager.emitCustomEvent('custom.chain', 'agent-1', { _triggerDepth: MAX_TRIGGER_DEPTH });
    await new Promise((r) => setTimeout(r, 10));
    expect(onFire).not.toHaveBeenCalled();
  });
});
