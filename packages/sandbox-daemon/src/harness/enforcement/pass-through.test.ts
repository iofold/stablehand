import { describe, expect, it } from 'vitest';

import { PassThroughHarnessTurnEnforcer } from './pass-through.js';

describe('PassThroughHarnessTurnEnforcer', () => {
  it('declares honest harness capability and leaves existing limits unchanged', async () => {
    const enforcer = new PassThroughHarnessTurnEnforcer({
      observationBoundary: 'turn_only',
      activeCallCancellation: false,
      softStop: false,
    });

    await expect(enforcer.beforeModelCall({
      turnId: 'turn-1',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    })).resolves.toEqual({ action: 'continue' });
    await expect(enforcer.afterModelCall({
      turnId: 'turn-1',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      totalTokens: 42,
    })).resolves.toEqual({ action: 'continue' });
    expect(enforcer.capabilities).toEqual({
      observationBoundary: 'turn_only',
      activeCallCancellation: false,
      softStop: false,
    });
    expect(Object.isFrozen(enforcer.capabilities)).toBe(true);
  });
});
