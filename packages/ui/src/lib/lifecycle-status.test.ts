import { describe, expect, it } from 'vitest';
import {
  countActiveSandboxSessions,
  countAllSandboxSessions,
  normalizeSandboxSessionStatusCounts,
  normalizeTurnStatus,
} from './lifecycle-status';

describe('lifecycle status normalization', () => {
  it('normalizes backend sandbox status casing before counting', () => {
    const counts = normalizeSandboxSessionStatusCounts({ active: 2, restoring: 3, terminated: 4 } as never);

    expect(counts).toEqual({ ACTIVE: 2, CHECKPOINTED: 0, RESTORING: 3, TERMINATED: 4 });
    expect(countActiveSandboxSessions(counts)).toBe(5);
    expect(countAllSandboxSessions(counts)).toBe(9);
  });

  it('normalizes only turn statuses for turn filters', () => {
    expect(normalizeTurnStatus('RUNNING')).toBe('running');
    expect(normalizeTurnStatus('queued')).toBe('queued');
    expect(normalizeTurnStatus('ERROR')).toBe('error');
    expect(normalizeTurnStatus('CANCELLED')).toBe('cancelled');
  });
});
