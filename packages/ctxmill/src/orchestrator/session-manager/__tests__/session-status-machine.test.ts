import { describe, expect, it } from 'vitest';

import { assertTransition, canTransition, isTerminal } from '../session-status-machine.js';

describe('session-status-machine', () => {
  it.each([
    ['ACTIVE', 'CHECKPOINTED'],
    ['ACTIVE', 'TERMINATED'],
    ['PAUSED', 'CHECKPOINTED'],
    ['PAUSED', 'ACTIVE'],
    ['CHECKPOINTED', 'RESTORING'],
    ['CHECKPOINTED', 'TERMINATED'],
    ['RESTORING', 'ACTIVE'],
    ['RESTORING', 'CHECKPOINTED'],
    ['RESTORING', 'TERMINATED'],
  ] as const)('allows %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    expect(() => assertTransition(from, to)).not.toThrow();
  });

  it.each([
    ['ACTIVE', 'ACTIVE'],
    ['ACTIVE', 'PAUSED'],
    ['PAUSED', 'RESTORING'],
    ['CHECKPOINTED', 'ACTIVE'],
    ['TERMINATED', 'ACTIVE'],
  ] as const)('rejects %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
    expect(() => assertTransition(from, to)).toThrow(
      `Invalid sandbox session status transition: ${from} -> ${to}`,
    );
  });

  it('detects terminal states', () => {
    expect(isTerminal('TERMINATED')).toBe(true);
    expect(isTerminal('ACTIVE')).toBe(false);
    expect(isTerminal('CHECKPOINTED')).toBe(false);
  });
});
