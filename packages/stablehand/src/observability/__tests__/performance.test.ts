import { describe, expect, it, vi } from 'vitest';

import {
  PerformanceInstrumentation,
  type PerformanceSpan,
} from '../performance.js';

function spanRecorder() {
  const attributes: Record<string, string | number | boolean> = {};
  const span: PerformanceSpan = {
    setAttribute: vi.fn((key, value) => {
      attributes[key] = value;
      return span;
    }),
    setStatus: vi.fn(() => span),
    recordException: vi.fn(() => span),
    end: vi.fn(),
  };
  return { attributes, span };
}

describe('PerformanceInstrumentation', () => {
  it('records an idempotent successful duration with trace and low-cardinality metric attributes', () => {
    const times = [100, 142];
    const { attributes, span } = spanRecorder();
    const recordDuration = vi.fn();
    const instrumentation = new PerformanceInstrumentation({
      now: () => times.shift()!,
      startSpan: (_name, initialAttributes) => {
        Object.assign(attributes, initialAttributes);
        return span;
      },
      startActiveSpan: (_name, initialAttributes, operation) => {
        Object.assign(attributes, initialAttributes);
        return operation(span);
      },
      recordDuration,
    });

    const measurement = instrumentation.start('sandbox.queue', {
      'stablehand.harness': 'langgraph',
      'stablehand.session.state': 'cold',
      'stablehand.turn.id': 'turn-high-cardinality',
    });

    expect(measurement.end()).toEqual(expect.objectContaining({
      phase: 'sandbox.queue',
      durationMs: 42,
      outcome: 'ok',
    }));
    expect(measurement.end()).toEqual(expect.objectContaining({ durationMs: 42 }));
    expect(span.end).toHaveBeenCalledTimes(1);
    expect(attributes).toMatchObject({
      'stablehand.phase': 'sandbox.queue',
      'stablehand.harness': 'langgraph',
      'stablehand.session.state': 'cold',
      'stablehand.turn.id': 'turn-high-cardinality',
      'stablehand.outcome': 'ok',
      'stablehand.duration_ms': 42,
    });
    expect(recordDuration).toHaveBeenCalledWith(42, {
      'stablehand.phase': 'sandbox.queue',
      'stablehand.harness': 'langgraph',
      'stablehand.session.state': 'cold',
      'stablehand.outcome': 'ok',
    });
  });

  it('marks failed measurements and rethrows the original operation error', async () => {
    const times = [10, 25];
    const { span } = spanRecorder();
    const recordDuration = vi.fn();
    const expected = new Error('container failed');
    const instrumentation = new PerformanceInstrumentation({
      now: () => times.shift()!,
      startSpan: () => span,
      startActiveSpan: (_name, _attributes, operation) => operation(span),
      recordDuration,
    });

    await expect(instrumentation.measure(
      'sandbox.create',
      { 'stablehand.harness': 'pi-agent' },
      async () => {
        throw expected;
      },
    )).rejects.toBe(expected);

    expect(span.recordException).toHaveBeenCalledWith(expected);
    expect(span.setStatus).toHaveBeenCalledWith(expect.objectContaining({
      code: expect.any(Number),
      message: 'container failed',
    }));
    expect(recordDuration).toHaveBeenCalledWith(15, {
      'stablehand.phase': 'sandbox.create',
      'stablehand.harness': 'pi-agent',
      'stablehand.outcome': 'error',
    });
  });

  it('keeps the measurement span active while an async operation runs', async () => {
    const times = [1, 4];
    const { span } = spanRecorder();
    let active = false;
    const instrumentation = new PerformanceInstrumentation({
      now: () => times.shift()!,
      startSpan: () => span,
      startActiveSpan: async (_name, _attributes, operation) => {
        active = true;
        try {
          return await operation(span);
        } finally {
          active = false;
        }
      },
      recordDuration: vi.fn(),
    });

    const result = await instrumentation.measure(
      'turn.execute',
      { 'stablehand.turn.id': 'turn-1' },
      async () => {
        expect(active).toBe(true);
        await Promise.resolve();
        expect(active).toBe(true);
        return 'done';
      },
    );

    expect(result).toBe('done');
    expect(active).toBe(false);
  });
});
