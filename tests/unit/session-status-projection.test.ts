import { describe, expect, it } from 'vitest';
import {
  TURN_CANCELLED_MESSAGE,
  projectConversationStatus,
  projectTurnStatus,
} from '@ctxmill/shared';

describe('status projections', () => {
  const openTurn = { completedAt: null, error: null };

  it('maps a cancelled turn to CANCELLED', () => {
    const turn = { completedAt: Date.now(), error: TURN_CANCELLED_MESSAGE };
    expect(projectTurnStatus({ ...turn, status: 'failed' })).toBe('CANCELLED');
  });

  it('maps an errored turn to ERROR', () => {
    expect(projectTurnStatus({ completedAt: Date.now(), error: 'boom', status: 'failed' })).toBe('ERROR');
  });

  it('maps a completed turn to COMPLETED', () => {
    expect(projectTurnStatus({ completedAt: Date.now(), error: null, status: 'completed' })).toBe('COMPLETED');
  });

  it('uses execution vocabulary for open turns', () => {
    expect(projectTurnStatus({ ...openTurn, status: 'queued' })).toBe('QUEUED');
    expect(projectTurnStatus({ ...openTurn, status: 'running' })).toBe('RUNNING');
  });

  it('projects sandbox lifecycle only onto conversation aggregates', () => {
    expect(projectConversationStatus(openTurn, 'CHECKPOINTED')).toBe('CHECKPOINTED');
    expect(projectConversationStatus(openTurn, 'RESTORING')).toBe('RESTORING');
    expect(projectConversationStatus(openTurn, 'ACTIVE')).toBe('ACTIVE');
  });

  it('treats a terminated or absent sandbox as an idle conversation', () => {
    expect(projectConversationStatus(openTurn, 'TERMINATED')).toBe('IDLE');
    expect(projectConversationStatus(null, null)).toBe('IDLE');
  });
});
