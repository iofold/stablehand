import { describe, it, expect, vi, afterEach } from 'vitest';
import { TestSessionRegistry, MAX_CONCURRENT_SESSIONS_PER_AGENT } from '../utils/test-session-registry.js';
import { EventTriggerManager, MAX_TRIGGER_DEPTH } from '../../packages/ctxmill/src/events/trigger-manager.js';
import { createTestBus, createMockTriggerDb } from '../utils/event-bus-test-helpers.js';
import type { DatabaseRepository } from '../../packages/ctxmill/src/database/repository.js';

const settle = () => new Promise((r) => setTimeout(r, 15));

describe('Trigger cascade protection', () => {
  // ─── Protection 2: concurrent run limit ───────────────────────────

  it('should export MAX_CONCURRENT_SESSIONS_PER_AGENT = 3', () => {
    expect(MAX_CONCURRENT_SESSIONS_PER_AGENT).toBe(3);
  });

  it('should allow up to the concurrent limit', async () => {
    const registry = new TestSessionRegistry();

    await registry.startSession('agent-1', 'conv-1', 'background');
    await registry.startSession('agent-1', 'conv-2', 'background');
    await registry.startSession('agent-1', 'conv-3', 'background');

    expect(registry.getActiveSessions('agent-1').length).toBe(3);
  });

  it('should reject runs beyond the concurrent limit', async () => {
    const registry = new TestSessionRegistry();

    await registry.startSession('agent-1', 'conv-1', 'background');
    await registry.startSession('agent-1', 'conv-2', 'background');
    await registry.startSession('agent-1', 'conv-3', 'background');

    await expect(
      registry.startSession('agent-1', 'conv-4', 'background'),
    ).rejects.toThrow(/concurrent run limit/i);
  });

  it('should respect a custom maxConcurrent option', async () => {
    const registry = new TestSessionRegistry();

    await registry.startSession('agent-1', 'conv-1', 'background');
    await registry.startSession('agent-1', 'conv-2', 'background');

    // With maxConcurrent=2, the 3rd should fail
    await expect(
      registry.startSession('agent-1', 'conv-3', 'background', undefined, { maxConcurrent: 2 }),
    ).rejects.toThrow(/concurrent run limit/i);
  });

  it('should allow runs for different agents independently', async () => {
    const registry = new TestSessionRegistry();

    await registry.startSession('agent-1', 'conv-1', 'background');
    await registry.startSession('agent-1', 'conv-2', 'background');
    await registry.startSession('agent-1', 'conv-3', 'background');

    const session = await registry.startSession('agent-2', 'conv-4', 'background');
    expect(session.agentId).toBe('agent-2');
  });

  it('should allow new runs after completing existing ones', async () => {
    const registry = new TestSessionRegistry();

    const session1 = await registry.startSession('agent-1', 'conv-1', 'background');
    await registry.startSession('agent-1', 'conv-2', 'background');
    await registry.startSession('agent-1', 'conv-3', 'background');

    await registry.completeSession(session1.id);

    const session4 = await registry.startSession('agent-1', 'conv-4', 'background');
    expect(session4.agentId).toBe('agent-1');
  });

  // ─── Protection 1: max trigger depth (real TypedEventBus) ─────────

  let manager: EventTriggerManager | undefined;
  afterEach(() => {
    manager?.shutdown();
    manager = undefined;
  });

  it('should export MAX_TRIGGER_DEPTH = 5', () => {
    expect(MAX_TRIGGER_DEPTH).toBe(5);
  });

  it('should skip events with _triggerDepth >= MAX_TRIGGER_DEPTH', async () => {
    const onFire = vi.fn().mockResolvedValue(undefined);
    const bus = createTestBus();
    const mockDb = createMockTriggerDb();

    manager = new EventTriggerManager(bus, mockDb as unknown as DatabaseRepository, onFire);

    await manager.register({
      agentId: 'agent-1',
      eventType: 'custom.test',
      taskTemplate: 'Do something',
      enabled: true,
    });

    manager.emitCustomEvent('custom.test', 'agent-1', { _triggerDepth: 3 });
    await settle();
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(onFire).toHaveBeenCalledWith('agent-1', 'Do something', expect.any(String), 4, undefined);

    onFire.mockClear();

    manager.emitCustomEvent('custom.test', 'agent-1', { _triggerDepth: MAX_TRIGGER_DEPTH });
    await settle();
    expect(onFire).not.toHaveBeenCalled();

    manager.emitCustomEvent('custom.test', 'agent-1', { _triggerDepth: MAX_TRIGGER_DEPTH + 2 });
    await settle();
    expect(onFire).not.toHaveBeenCalled();
  });

  it('should allow events with no _triggerDepth (depth 0)', async () => {
    const onFire = vi.fn().mockResolvedValue(undefined);
    const bus = createTestBus();
    const mockDb = createMockTriggerDb();

    manager = new EventTriggerManager(bus, mockDb as unknown as DatabaseRepository, onFire);

    await manager.register({
      agentId: 'agent-1',
      eventType: 'custom.test',
      taskTemplate: 'Do something',
      enabled: true,
    });

    manager.emitCustomEvent('custom.test', 'agent-1', { someData: 'hello' });
    await settle();
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(onFire).toHaveBeenCalledWith('agent-1', 'Do something', expect.any(String), 1, undefined);
  });

  it('should propagate _triggerDepth through emitCustomEvent', async () => {
    const onFire = vi.fn().mockResolvedValue(undefined);
    const bus = createTestBus();
    const mockDb = createMockTriggerDb();

    manager = new EventTriggerManager(bus, mockDb as unknown as DatabaseRepository, onFire);

    await manager.register({
      agentId: 'agent-1',
      eventType: 'custom.chain',
      taskTemplate: 'Chain step',
      enabled: true,
    });

    for (let depth = 0; depth < MAX_TRIGGER_DEPTH; depth++) {
      onFire.mockClear();
      manager.emitCustomEvent('custom.chain', 'agent-1', { _triggerDepth: depth });
      await settle();
      expect(onFire).toHaveBeenCalledTimes(1);
      expect(onFire).toHaveBeenCalledWith('agent-1', 'Chain step', expect.any(String), depth + 1, undefined);
    }

    onFire.mockClear();
    manager.emitCustomEvent('custom.chain', 'agent-1', { _triggerDepth: MAX_TRIGGER_DEPTH });
    await settle();
    expect(onFire).not.toHaveBeenCalled();
  });


  it('does not fire triggers when durable custom event persistence fails', async () => {
    const onFire = vi.fn().mockResolvedValue(undefined);
    const persistEvent = vi.fn().mockImplementation(() => {
      throw new Error('persist failed');
    });
    const bus = createTestBus({ persistEvent });
    const mockDb = createMockTriggerDb();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    manager = new EventTriggerManager(bus, mockDb as unknown as DatabaseRepository, onFire);

    await manager.register({
      agentId: 'agent-1',
      eventType: 'custom.persisted-chain',
      taskTemplate: 'Should not fire',
      enabled: true,
    });

    manager.emitCustomEvent('custom.persisted-chain', 'agent-1', { ok: true });
    await settle();

    expect(persistEvent).toHaveBeenCalledTimes(1);
    expect(onFire).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it('rejects awaitable custom event emit when durable persistence fails', async () => {
    const onFire = vi.fn().mockResolvedValue(undefined);
    const persistEvent = vi.fn().mockRejectedValue(new Error('persist failed'));
    const bus = createTestBus({ persistEvent });
    const mockDb = createMockTriggerDb();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    manager = new EventTriggerManager(bus, mockDb as unknown as DatabaseRepository, onFire);

    await manager.register({
      agentId: 'agent-1',
      eventType: 'custom.awaited-chain',
      taskTemplate: 'Should not fire',
      enabled: true,
    });

    await expect(
      manager.emitCustomEventAsync('custom.awaited-chain', 'agent-1', { ok: true }),
    ).rejects.toThrow('persist failed');

    expect(persistEvent).toHaveBeenCalledTimes(1);
    expect(onFire).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  // ─── Regression: emitCustomEvent must fire triggers exactly once ──

  it('should fire onFire exactly once per emitCustomEvent (no double-fire)', async () => {
    const onFire = vi.fn().mockResolvedValue(undefined);
    const bus = createTestBus();
    const mockDb = createMockTriggerDb();

    manager = new EventTriggerManager(bus, mockDb as unknown as DatabaseRepository, onFire);

    await manager.register({
      agentId: 'agent-A',
      eventType: 'custom.single_fire',
      taskTemplate: 'Should fire once',
      enabled: true,
    });

    await manager.register({
      agentId: 'agent-B',
      eventType: 'custom.single_fire',
      taskTemplate: 'Should also fire once',
      enabled: true,
    });

    manager.emitCustomEvent('custom.single_fire', undefined, { data: 'test' });
    await settle();

    expect(onFire).toHaveBeenCalledTimes(2);
    const calledAgents = onFire.mock.calls.map((c: unknown[]) => c[0]);
    expect(calledAgents).toContain('agent-A');
    expect(calledAgents).toContain('agent-B');
  });

  it('should fire onFire exactly once across multiple rapid emits', async () => {
    const onFire = vi.fn().mockResolvedValue(undefined);
    const bus = createTestBus();
    const mockDb = createMockTriggerDb();

    manager = new EventTriggerManager(bus, mockDb as unknown as DatabaseRepository, onFire);

    await manager.register({
      agentId: 'agent-1',
      eventType: 'custom.rapid',
      taskTemplate: 'Rapid fire',
      enabled: true,
    });

    manager.emitCustomEvent('custom.rapid', 'agent-1', { seq: 1 });
    manager.emitCustomEvent('custom.rapid', 'agent-1', { seq: 2 });
    manager.emitCustomEvent('custom.rapid', 'agent-1', { seq: 3 });
    await settle();

    expect(onFire).toHaveBeenCalledTimes(3);
  });
});
