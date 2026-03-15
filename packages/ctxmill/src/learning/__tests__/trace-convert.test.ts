import { describe, it, expect } from 'vitest';
import { traceToDbRow, dbRowToTrace } from '../trace-convert.js';
import type { ExecutionTrace } from '../types.js';

function makeTrace(overrides: Partial<ExecutionTrace> = {}): ExecutionTrace {
  return {
    id: 'trace-1',
    agentId: 'agent-1',
    runId: 'run-1',
    taskDescription: 'Do something',
    steps: [
      { ordinal: 0, type: 'llm_call', content: 'hello', durationMs: 100, metadata: {} },
    ],
    startedAt: new Date('2026-01-01T00:00:00Z'),
    completedAt: new Date('2026-01-01T00:01:00Z'),
    outcome: 'success',
    metadata: { key: 'value' },
    ...overrides,
  };
}

describe('traceToDbRow', () => {
  it('converts a full trace to DB row format', () => {
    const trace = makeTrace();
    const row = traceToDbRow(trace);

    expect(row.id).toBe('trace-1');
    expect(row.agentId).toBe('agent-1');
    expect(row.runId).toBe('run-1');
    expect(row.taskDescription).toBe('Do something');
    expect(row.steps).toEqual(trace.steps);
    expect(row.startedAt).toBe(new Date('2026-01-01T00:00:00Z').getTime());
    expect(row.completedAt).toBe(new Date('2026-01-01T00:01:00Z').getTime());
    expect(row.outcome).toBe('success');
  });

  it('defaults outcome to "unknown" when missing', () => {
    const trace = makeTrace({ outcome: undefined as any });
    const row = traceToDbRow(trace);
    expect(row.outcome).toBe('unknown');
  });

  it('handles empty steps array', () => {
    const trace = makeTrace({ steps: [] });
    const row = traceToDbRow(trace);
    expect(row.steps).toEqual([]);
  });

  it('preserves all step metadata', () => {
    const steps = [
      { ordinal: 0, type: 'tool_call' as const, content: 'calc', durationMs: 50, metadata: { tool: 'calculator' } },
      { ordinal: 1, type: 'tool_result' as const, content: '42', durationMs: 10, metadata: {} },
    ];
    const trace = makeTrace({ steps });
    const row = traceToDbRow(trace);
    expect(row.steps).toEqual(steps);
  });
});

describe('dbRowToTrace', () => {
  it('converts a DB row back to ExecutionTrace', () => {
    const row = {
      id: 'trace-2',
      agentId: 'agent-2',
      runId: 'run-2',
      taskDescription: 'Another task',
      steps: [{ ordinal: 0, type: 'reasoning', content: 'thinking', durationMs: 200, metadata: {} }],
      startedAt: 1735689600000,
      completedAt: 1735689660000,
      outcome: 'failure',
    };
    const trace = dbRowToTrace(row);

    expect(trace.id).toBe('trace-2');
    expect(trace.startedAt).toBeInstanceOf(Date);
    expect(trace.startedAt.getTime()).toBe(1735689600000);
    expect(trace.completedAt).toBeInstanceOf(Date);
    expect(trace.completedAt.getTime()).toBe(1735689660000);
    expect(trace.outcome).toBe('failure');
    expect(trace.metadata).toEqual({});
  });

  it('defaults outcome to "unknown" when null', () => {
    const row = {
      id: 'trace-3',
      agentId: 'agent-3',
      runId: 'run-3',
      taskDescription: 'Task 3',
      steps: [],
      startedAt: Date.now(),
      completedAt: null,
      outcome: null,
    };
    const trace = dbRowToTrace(row);
    expect(trace.outcome).toBe('unknown');
  });

  it('handles null completedAt by using current time', () => {
    const before = Date.now();
    const row = {
      id: 'trace-4',
      agentId: 'agent-4',
      runId: 'run-4',
      taskDescription: 'Task 4',
      steps: [],
      startedAt: before - 1000,
      completedAt: null,
      outcome: 'success',
    };
    const trace = dbRowToTrace(row);
    expect(trace.completedAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('handles non-array steps gracefully', () => {
    const row = {
      id: 'trace-5',
      agentId: 'agent-5',
      runId: 'run-5',
      taskDescription: 'Task 5',
      steps: 'not-an-array' as unknown,
      startedAt: Date.now(),
      completedAt: Date.now(),
      outcome: 'success',
    };
    const trace = dbRowToTrace(row);
    expect(trace.steps).toEqual([]);
  });
});
