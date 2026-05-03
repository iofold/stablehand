import { describe, expect, it } from 'vitest';

import {
  allowedTargets,
  assertTransition,
  canTransition,
  isTerminal,
  SESSION_STATUSES,
} from '../session-status-machine.js';
import type { SessionStatus } from '../types.js';

/**
 * Per ADR 005 the full sandbox-session transition matrix is:
 *
 *   ACTIVE       → PAUSED, CHECKPOINTED, TERMINATED
 *   PAUSED       → ACTIVE, CHECKPOINTED, TERMINATED
 *   CHECKPOINTED → RESTORING, TERMINATED
 *   RESTORING    → ACTIVE, CHECKPOINTED, TERMINATED
 *   TERMINATED   → (terminal)
 *
 * The `allowedRows` and `rejectedRows` lists are exhaustive over the 5x5 grid.
 * Adding/removing a status without updating both lists must fail the test.
 */

const allowedRows: ReadonlyArray<readonly [SessionStatus, SessionStatus]> = [
  ['ACTIVE', 'PAUSED'],
  ['ACTIVE', 'CHECKPOINTED'],
  ['ACTIVE', 'TERMINATED'],
  ['PAUSED', 'ACTIVE'],
  ['PAUSED', 'CHECKPOINTED'],
  ['PAUSED', 'TERMINATED'],
  ['CHECKPOINTED', 'RESTORING'],
  ['CHECKPOINTED', 'TERMINATED'],
  ['RESTORING', 'ACTIVE'],
  ['RESTORING', 'CHECKPOINTED'],
  ['RESTORING', 'TERMINATED'],
];

const rejectedRows: ReadonlyArray<readonly [SessionStatus, SessionStatus]> = [
  // ACTIVE rejects RESTORING and itself.
  ['ACTIVE', 'ACTIVE'],
  ['ACTIVE', 'RESTORING'],

  // PAUSED rejects RESTORING and itself.
  ['PAUSED', 'PAUSED'],
  ['PAUSED', 'RESTORING'],

  // CHECKPOINTED rejects ACTIVE and PAUSED (must go through RESTORING) and itself.
  ['CHECKPOINTED', 'ACTIVE'],
  ['CHECKPOINTED', 'PAUSED'],
  ['CHECKPOINTED', 'CHECKPOINTED'],

  // RESTORING rejects PAUSED and itself.
  ['RESTORING', 'PAUSED'],
  ['RESTORING', 'RESTORING'],

  // TERMINATED is terminal — every outgoing transition is rejected.
  ['TERMINATED', 'ACTIVE'],
  ['TERMINATED', 'PAUSED'],
  ['TERMINATED', 'CHECKPOINTED'],
  ['TERMINATED', 'RESTORING'],
  ['TERMINATED', 'TERMINATED'],
];

describe('session-status-machine — ADR 005 transition matrix', () => {
  it.each(allowedRows)('allows %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    expect(() => assertTransition(from, to)).not.toThrow();
  });

  it.each(rejectedRows)('rejects %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
    expect(() => assertTransition(from, to)).toThrow(
      `Invalid sandbox session status transition: ${from} -> ${to}`,
    );
  });

  it('covers the full 5x5 grid (allowed + rejected = 25 rows)', () => {
    expect(allowedRows.length + rejectedRows.length).toBe(SESSION_STATUSES.length ** 2);
  });

  it('matches ADR 005 outgoing-target sets exactly', () => {
    expect(new Set(allowedTargets('ACTIVE'))).toEqual(new Set(['PAUSED', 'CHECKPOINTED', 'TERMINATED']));
    expect(new Set(allowedTargets('PAUSED'))).toEqual(new Set(['ACTIVE', 'CHECKPOINTED', 'TERMINATED']));
    expect(new Set(allowedTargets('CHECKPOINTED'))).toEqual(new Set(['RESTORING', 'TERMINATED']));
    expect(new Set(allowedTargets('RESTORING'))).toEqual(new Set(['ACTIVE', 'CHECKPOINTED', 'TERMINATED']));
    expect(allowedTargets('TERMINATED')).toEqual([]);
  });

  it('detects terminal states', () => {
    expect(isTerminal('TERMINATED')).toBe(true);
    expect(isTerminal('ACTIVE')).toBe(false);
    expect(isTerminal('PAUSED')).toBe(false);
    expect(isTerminal('CHECKPOINTED')).toBe(false);
    expect(isTerminal('RESTORING')).toBe(false);
  });
});
