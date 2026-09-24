import { Code, ConnectError } from '@connectrpc/connect';
import { describe, expect, it } from 'vitest';

import {
  backoffForAttempt,
  classifyRestoreFailure,
  decideRestoreOutcome,
  InvalidCheckpointError,
  MAX_RESTORE_ATTEMPTS,
  RESTORE_BACKOFF_MS,
} from '../restore-retry-policy.js';

describe('restore-retry-policy', () => {
  it('uses ADR 013 retry budget and backoff schedule', () => {
    expect(MAX_RESTORE_ATTEMPTS).toBe(3);
    expect(RESTORE_BACKOFF_MS).toEqual([5_000, 15_000, 45_000]);
  });

  describe('classifyRestoreFailure', () => {
    it('classifies InvalidCheckpointError as non-retryable', () => {
      const result = classifyRestoreFailure(new InvalidCheckpointError('checkpoint missing'));
      expect(result.category).toBe('non_retryable');
      expect(result.message).toBe('checkpoint missing');
    });

    it('classifies Code.InvalidArgument as non-retryable', () => {
      const result = classifyRestoreFailure(new ConnectError('bad input', Code.InvalidArgument));
      expect(result.category).toBe('non_retryable');
    });

    it('classifies Code.FailedPrecondition as non-retryable', () => {
      const result = classifyRestoreFailure(new ConnectError('bad state', Code.FailedPrecondition));
      expect(result.category).toBe('non_retryable');
    });

    it('classifies Code.Unavailable as retryable', () => {
      const result = classifyRestoreFailure(new ConnectError('temp', Code.Unavailable));
      expect(result.category).toBe('retryable');
    });

    it('classifies ECONNREFUSED node errors as retryable', () => {
      const result = classifyRestoreFailure(new Error('connect ECONNREFUSED 127.0.0.1:50051'));
      expect(result.category).toBe('retryable');
    });

    it('classifies unknown errors as retryable (defensive)', () => {
      const result = classifyRestoreFailure(new Error('unknown'));
      expect(result.category).toBe('retryable');
    });
  });

  describe('backoffForAttempt', () => {
    it('returns the schedule for attempts 1..MAX', () => {
      expect(backoffForAttempt(1)).toBe(5_000);
      expect(backoffForAttempt(2)).toBe(15_000);
      expect(backoffForAttempt(3)).toBe(45_000);
    });

    it('returns undefined past the budget', () => {
      expect(backoffForAttempt(0)).toBeUndefined();
      expect(backoffForAttempt(4)).toBeUndefined();
    });
  });

  describe('decideRestoreOutcome', () => {
    it('non-retryable failure goes straight to TERMINATED on first attempt', () => {
      const decision = decideRestoreOutcome(new InvalidCheckpointError('no checkpoint'), 1);
      expect(decision.toStatus).toBe('TERMINATED');
      expect(decision.classification.category).toBe('non_retryable');
      expect(decision.retryDelayMs).toBeUndefined();
    });

    it('retryable failure with attempts < MAX schedules a retry with backoff', () => {
      const decision = decideRestoreOutcome(new ConnectError('temp', Code.Unavailable), 1);
      expect(decision.toStatus).toBe('RETRY');
      expect(decision.retryDelayMs).toBe(5_000);

      const next = decideRestoreOutcome(new ConnectError('temp', Code.Unavailable), 2);
      expect(next.toStatus).toBe('RETRY');
      expect(next.retryDelayMs).toBe(15_000);
    });

    it('retryable failure at the MAX attempt lands in CHECKPOINTED', () => {
      const decision = decideRestoreOutcome(
        new ConnectError('temp', Code.Unavailable),
        MAX_RESTORE_ATTEMPTS,
      );
      expect(decision.toStatus).toBe('CHECKPOINTED');
      expect(decision.classification.category).toBe('retryable');
      expect(decision.retryDelayMs).toBeUndefined();
    });
  });
});
