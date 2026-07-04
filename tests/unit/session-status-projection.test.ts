import { describe, expect, it } from 'vitest';
import { SESSION_CANCELLED_MESSAGE, projectSessionStatus } from '@ctxmill/shared';

describe('projectSessionStatus (ctx-bl4)', () => {
  const openTurn = { completedAt: null, error: null };

  it('maps a cancelled turn to CANCELLED regardless of sandbox status', () => {
    const turn = { completedAt: Date.now(), error: SESSION_CANCELLED_MESSAGE };
    expect(projectSessionStatus(turn, 'ACTIVE', 'ACTIVE')).toBe('CANCELLED');
    expect(projectSessionStatus(turn, null, 'IDLE')).toBe('CANCELLED');
  });

  it('maps an errored turn to ERROR', () => {
    expect(projectSessionStatus({ completedAt: Date.now(), error: 'boom' }, 'ACTIVE', 'ACTIVE')).toBe('ERROR');
  });

  it('maps a completed turn to COMPLETED', () => {
    expect(projectSessionStatus({ completedAt: Date.now(), error: null }, 'ACTIVE', 'IDLE')).toBe('COMPLETED');
  });

  it('passes through a live sandbox status for an open turn', () => {
    expect(projectSessionStatus(openTurn, 'CHECKPOINTED', 'ACTIVE')).toBe('CHECKPOINTED');
    expect(projectSessionStatus(openTurn, 'RESTORING', 'IDLE')).toBe('RESTORING');
  });

  it('treats TERMINATED as not live and falls back', () => {
    expect(projectSessionStatus(openTurn, 'TERMINATED', 'ACTIVE')).toBe('ACTIVE');
    expect(projectSessionStatus(openTurn, 'TERMINATED', 'IDLE')).toBe('IDLE');
  });

  it('uses the caller fallback when there is no turn and no sandbox', () => {
    expect(projectSessionStatus(null, null, 'ACTIVE')).toBe('ACTIVE');
    expect(projectSessionStatus(undefined, undefined, 'IDLE')).toBe('IDLE');
  });
});
