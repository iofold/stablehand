import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TURN_FANOUT_LIMITS,
  FanoutLimitHarnessTurnEnforcer,
  fanoutDenialMessage,
  fanoutLimitMessage,
  fanoutTelemetryEvent,
  resolveTurnFanoutLimits,
} from './fanout.js';

const SOFT_STOP_CAPS = {
  observationBoundary: 'before_and_after',
  activeCallCancellation: false,
  softStop: true,
} as const;

const HARD_STOP_CAPS = {
  observationBoundary: 'before_and_after',
  activeCallCancellation: true,
  softStop: false,
} as const;

const AFTER_ONLY_CAPS = {
  observationBoundary: 'after_only',
  activeCallCancellation: true,
  softStop: false,
} as const;

const attempt = (turnId = 'turn-1') => ({ turnId, provider: 'openai', model: 'gpt-5-mini' });

describe('resolveTurnFanoutLimits', () => {
  it('applies bounded defaults for missing, malformed, and non-positive configs', () => {
    expect(resolveTurnFanoutLimits(undefined)).toEqual(DEFAULT_TURN_FANOUT_LIMITS);
    expect(resolveTurnFanoutLimits('not json')).toEqual(DEFAULT_TURN_FANOUT_LIMITS);
    expect(resolveTurnFanoutLimits('{}')).toEqual(DEFAULT_TURN_FANOUT_LIMITS);
    expect(resolveTurnFanoutLimits(JSON.stringify({ limits: { maxModelCalls: -5, maxToolCalls: 'lots' } })))
      .toEqual(DEFAULT_TURN_FANOUT_LIMITS);
  });

  it('honors per-agent overrides while defaulting the rest', () => {
    const resolved = resolveTurnFanoutLimits(JSON.stringify({
      model: 'gpt-5-mini',
      limits: { maxModelCalls: 3, maxSubagents: 1 },
    }));
    expect(resolved).toEqual({
      maxModelCalls: 3,
      maxToolCalls: DEFAULT_TURN_FANOUT_LIMITS.maxToolCalls,
      maxSubagents: 1,
    });
  });
});

describe('FanoutLimitHarnessTurnEnforcer', () => {
  it('cancels the turn when model calls exceed the cap, regardless of soft-stop', async () => {
    const enforcer = new FanoutLimitHarnessTurnEnforcer(SOFT_STOP_CAPS, {
      maxModelCalls: 2, maxToolCalls: 10, maxSubagents: 10,
    });
    expect((await enforcer.beforeModelCall(attempt())).action).toBe('continue');
    expect((await enforcer.beforeModelCall(attempt())).action).toBe('continue');
    const third = await enforcer.beforeModelCall(attempt());
    expect(third).toEqual({ action: 'cancel_turn', reason: 'model_call_limit' });
    expect(enforcer.snapshot().modelCalls).toBe(3);
    expect(enforcer.snapshot().tripped).toEqual(['model_call_limit']);
  });

  it('counts in afterModelCall for after-only harnesses and never double-counts', async () => {
    const enforcer = new FanoutLimitHarnessTurnEnforcer(AFTER_ONLY_CAPS, {
      maxModelCalls: 1, maxToolCalls: 10, maxSubagents: 10,
    });
    expect((await enforcer.beforeModelCall(attempt())).action).toBe('continue');
    expect(enforcer.snapshot().modelCalls).toBe(0);
    expect((await enforcer.afterModelCall(attempt())).action).toBe('continue');
    expect((await enforcer.afterModelCall(attempt())).action).toBe('cancel_turn');
    expect(enforcer.snapshot().modelCalls).toBe(2);
  });

  it('soft-denies tool and subagent caps when the harness supports it, cancels otherwise', async () => {
    const soft = new FanoutLimitHarnessTurnEnforcer(SOFT_STOP_CAPS, {
      maxModelCalls: 10, maxToolCalls: 2, maxSubagents: 1,
    });
    expect((await soft.onToolBoundary({ turnId: 'turn-1', toolName: 'browse' })).action).toBe('continue');
    expect(await soft.onToolBoundary({ turnId: 'turn-1', toolName: 'task', subagent: true }))
      .toEqual({ action: 'continue' });
    expect(await soft.onToolBoundary({ turnId: 'turn-1', toolName: 'task', subagent: true }))
      .toEqual({ action: 'deny_next_call', reason: 'subagent_limit' });
    expect(await soft.onToolBoundary({ turnId: 'turn-1', toolName: 'browse' }))
      .toEqual({ action: 'deny_next_call', reason: 'tool_call_limit' });

    const hard = new FanoutLimitHarnessTurnEnforcer(HARD_STOP_CAPS, {
      maxModelCalls: 10, maxToolCalls: 1, maxSubagents: 10,
    });
    expect((await hard.onToolBoundary({ turnId: 'turn-1', toolName: 'browse' })).action).toBe('continue');
    expect(await hard.onToolBoundary({ turnId: 'turn-1', toolName: 'browse' }))
      .toEqual({ action: 'cancel_turn', reason: 'tool_call_limit' });
  });

  it('resets counters when a new turn begins on the same session', async () => {
    const enforcer = new FanoutLimitHarnessTurnEnforcer(HARD_STOP_CAPS, {
      maxModelCalls: 1, maxToolCalls: 1, maxSubagents: 1,
    });
    expect((await enforcer.beforeModelCall(attempt('turn-1'))).action).toBe('continue');
    expect((await enforcer.beforeModelCall(attempt('turn-1'))).action).toBe('cancel_turn');
    expect(enforcer.takeFirstTrip('model_call_limit')).toBe(true);

    expect((await enforcer.beforeModelCall(attempt('turn-2'))).action).toBe('continue');
    expect(enforcer.snapshot()).toMatchObject({
      turnId: 'turn-2', modelCalls: 1, toolCalls: 0, subagents: 0, tripped: [],
    });
    expect(enforcer.takeFirstTrip('model_call_limit')).toBe(true);
  });

  it('reports each tripped cap exactly once per turn', () => {
    const enforcer = new FanoutLimitHarnessTurnEnforcer(HARD_STOP_CAPS);
    expect(enforcer.takeFirstTrip('tool_call_limit')).toBe(true);
    expect(enforcer.takeFirstTrip('tool_call_limit')).toBe(false);
    expect(enforcer.takeFirstTrip('subagent_limit')).toBe(true);
  });
});

describe('fanout messages and telemetry', () => {
  const limits = { maxModelCalls: 5, maxToolCalls: 6, maxSubagents: 2 };

  it('speaks consequence and remedy, not mechanism', () => {
    expect(fanoutLimitMessage('model_call_limit', limits))
      .toBe('Turn stopped: it made 5 model calls, the safety cap for a single turn. '
        + "If this workload is legitimate, raise limits.maxModelCalls in the agent's harness config.");
    expect(fanoutDenialMessage('subagent_limit', limits)).toContain('already spawned 2 subagents');
    expect(fanoutDenialMessage('tool_call_limit', limits)).toContain('wrap up now');
  });

  it('emits a structured custom event with the full snapshot', async () => {
    const enforcer = new FanoutLimitHarnessTurnEnforcer(HARD_STOP_CAPS, limits);
    await enforcer.beforeModelCall(attempt('turn-9'));
    const event = fanoutTelemetryEvent('pi-agent', 'model_call_limit', 'cancel_turn', enforcer.snapshot());
    expect(event).toMatchObject({
      type: 'CUSTOM',
      name: 'ctxmill.fanout.limit',
      source: 'pi-agent',
      reason: 'model_call_limit',
      action: 'cancel_turn',
      turnId: 'turn-9',
      modelCalls: 1,
      limits,
    });
  });
});
