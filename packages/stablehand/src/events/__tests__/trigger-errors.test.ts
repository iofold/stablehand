import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  classifyTriggerFireError,
  TRIGGER_FAILURE_MESSAGE_MAX_CHARS,
  TriggerTargetError,
} from '../trigger-errors.js';

function coded(code: string, message = code): Error {
  return Object.assign(new Error(message), { code });
}

describe('classifyTriggerFireError', () => {
  it.each([
    'agent_mode_not_allowed',
    'budget_exceeded',
    'tag_conflict',
    'tag_not_provisioned',
  ])('treats %s as non-retryable', (code) => {
    expect(classifyTriggerFireError(coded(code))).toEqual({ retryable: false, code, message: code });
  });

  it('treats a missing or misconfigured target as non-retryable', () => {
    expect(classifyTriggerFireError(new TriggerTargetError('trigger_target_not_found', 'gone')))
      .toMatchObject({ retryable: false, code: 'trigger_target_not_found' });
    expect(classifyTriggerFireError(new TriggerTargetError('trigger_target_misconfigured', 'no harness')))
      .toMatchObject({ retryable: false, code: 'trigger_target_misconfigured' });
  });

  it('treats validation errors as non-retryable', () => {
    const result = z.string().safeParse(42);
    expect(result.success).toBe(false);
    expect(classifyTriggerFireError(result.error)).toMatchObject({
      retryable: false,
      code: 'invalid_trigger_input',
    });
  });

  it('retries capacity throttles and unknown faults', () => {
    expect(classifyTriggerFireError(coded('queue_full'))).toMatchObject({ retryable: true, code: 'queue_full' });
    expect(classifyTriggerFireError(coded('dispatch_stalled'))).toMatchObject({ retryable: true });
    expect(classifyTriggerFireError(new Error('connection reset'))).toEqual({
      retryable: true,
      code: 'trigger_fire_failed',
      message: 'connection reset',
    });
    expect(classifyTriggerFireError('plain string')).toMatchObject({ retryable: true, message: 'plain string' });
  });

  it('truncates long messages for the dead-letter row', () => {
    const { message } = classifyTriggerFireError(new Error('x'.repeat(TRIGGER_FAILURE_MESSAGE_MAX_CHARS * 2)));
    expect(message).toHaveLength(TRIGGER_FAILURE_MESSAGE_MAX_CHARS);
    expect(message.endsWith('…')).toBe(true);
  });
});
