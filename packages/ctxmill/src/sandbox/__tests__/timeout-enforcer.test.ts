import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TimeoutEnforcer } from '../timeout-enforcer.js';

describe('TimeoutEnforcer', () => {
  let enforcer: TimeoutEnforcer;

  beforeEach(() => {
    vi.useFakeTimers();
    enforcer = new TimeoutEnforcer();
  });

  afterEach(() => {
    enforcer.cancelAll();
    vi.useRealTimers();
  });

  it('fires callback at exact timeout and cleans up active set', () => {
    const onTimeout = vi.fn();
    enforcer.startTimeout('run-1', 'container-abc', 60, onTimeout);
    expect(enforcer.activeCount).toBe(1);

    vi.advanceTimersByTime(59_000);
    expect(onTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1_000);
    expect(onTimeout).toHaveBeenCalledWith('run-1', 'container-abc');
    expect(enforcer.activeCount).toBe(0);
    expect(enforcer.hasTimeout('run-1')).toBe(false);
  });

  it('replaces existing timeout for same runId', () => {
    const onTimeout1 = vi.fn();
    const onTimeout2 = vi.fn();

    enforcer.startTimeout('run-1', 'c1', 30, onTimeout1);
    enforcer.startTimeout('run-1', 'c2', 60, onTimeout2);

    expect(enforcer.activeCount).toBe(1);

    vi.advanceTimersByTime(30_000);
    expect(onTimeout1).not.toHaveBeenCalled();

    vi.advanceTimersByTime(30_000);
    expect(onTimeout2).toHaveBeenCalledWith('run-1', 'c2');
  });

  it('tracks multiple concurrent timeouts independently', () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    const cb3 = vi.fn();

    enforcer.startTimeout('run-1', 'c1', 10, cb1);
    enforcer.startTimeout('run-2', 'c2', 20, cb2);
    enforcer.startTimeout('run-3', 'c3', 30, cb3);

    expect(enforcer.activeCount).toBe(3);

    vi.advanceTimersByTime(10_000);
    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb2).not.toHaveBeenCalled();
    expect(enforcer.activeCount).toBe(2);

    vi.advanceTimersByTime(20_000);
    expect(cb2).toHaveBeenCalledTimes(1);
    expect(cb3).toHaveBeenCalledTimes(1);
    expect(enforcer.activeCount).toBe(0);
  });

  it('cancelTimeout prevents firing without affecting others', () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();

    enforcer.startTimeout('run-1', 'c1', 10, cb1);
    enforcer.startTimeout('run-2', 'c2', 10, cb2);

    expect(enforcer.cancelTimeout('run-1')).toBe(true);
    expect(enforcer.cancelTimeout('nonexistent')).toBe(false);

    vi.advanceTimersByTime(10_000);
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).toHaveBeenCalledTimes(1);
  });

  it('cancelAll clears all pending timeouts', () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();

    enforcer.startTimeout('run-1', 'c1', 10, cb1);
    enforcer.startTimeout('run-2', 'c2', 20, cb2);

    expect(enforcer.cancelAll()).toBe(2);
    expect(enforcer.activeCount).toBe(0);

    vi.advanceTimersByTime(60_000);
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).not.toHaveBeenCalled();
  });
});
