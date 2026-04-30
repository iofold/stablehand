import { describe, expect, it } from 'vitest';
import {
  countActiveSessions,
  countAllSessions,
  normalizeRunStatus,
  normalizeSessionStatusCounts,
} from './session-status';

describe('session status normalization', () => {
  it('normalizes backend sandbox status casing before counting', () => {
    const counts = normalizeSessionStatusCounts({ active: 2, PAUSED: 1, restoring: 3, terminated: 4 } as never);

    expect(counts).toEqual({ ACTIVE: 2, PAUSED: 1, CHECKPOINTED: 0, RESTORING: 3, TERMINATED: 4 });
    expect(countActiveSessions(counts)).toBe(6);
    expect(countAllSessions(counts)).toBe(10);
  });

  it('maps sandbox statuses to run-filter statuses', () => {
    expect(normalizeRunStatus('ACTIVE')).toBe('running');
    expect(normalizeRunStatus('restoring')).toBe('running');
    expect(normalizeRunStatus('checkpointed')).toBe('completed');
    expect(normalizeRunStatus('TERMINATED')).toBe('cancelled');
    expect(normalizeRunStatus('FAILED')).toBe('error');
  });
});
