import { create } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import { TurnDeliveryCapabilitySchema } from '@stablehand/proto/sandbox/v1';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  callWithinOrchestratorWindow,
  classifyCallbackFailure,
} from '../callback-window.js';
import {
  clearTurnDeliveryExpiry,
  installTurnDeliveryCapability,
  type TurnDeliveryContext,
} from '../turn-delivery-context.js';

function capability(ownerId: string, fenceToken: number, leaseExpiresAtMs: number) {
  return create(TurnDeliveryCapabilitySchema, {
    ownerId,
    fenceToken: BigInt(fenceToken),
    leaseExpiresAtMs: BigInt(leaseExpiresAtMs),
    restoreFenceToken: 0n,
    agentId: 'agent-1',
    signature: 'stablehand-open-turn-delivery-capability-v1',
  });
}

function identity(ownerId: string, fenceToken: number) {
  return {
    turnId: 'turn-1',
    sandboxSessionId: 'session-1',
    agentId: 'agent-1',
    ownerId,
    fenceToken,
    restoreFenceToken: 0,
  };
}

const contexts: TurnDeliveryContext[] = [];

function context(options: { graceMs: number; leaseExpiresAtMs?: number }): TurnDeliveryContext {
  const leaseExpiresAtMs = options.leaseExpiresAtMs ?? Date.now() + 60_000;
  const created: TurnDeliveryContext = {
    identity: identity('owner-a', 1),
    capability: capability('owner-a', 1, leaseExpiresAtMs),
    leaseExpiresAtMs,
    abortController: new AbortController(),
    orphanGraceMs: options.graceMs,
    capabilityVersion: 0,
  };
  contexts.push(created);
  return created;
}

function rotate(target: TurnDeliveryContext, ownerId: string, fenceToken: number): void {
  const leaseExpiresAtMs = Date.now() + 60_000;
  installTurnDeliveryCapability(target, {
    identity: identity(ownerId, fenceToken),
    capability: capability(ownerId, fenceToken, leaseExpiresAtMs),
    leaseExpiresAtMs,
  });
}

const quiet = () => undefined;

afterEach(() => {
  for (const created of contexts.splice(0)) clearTurnDeliveryExpiry(created);
});

describe('callWithinOrchestratorWindow (ADR 025)', () => {
  it('classifies transport, stale-authority and fatal failures', () => {
    expect(classifyCallbackFailure(new ConnectError('down', Code.Unavailable))).toBe('transport');
    expect(classifyCallbackFailure(new ConnectError('socket hang up', Code.Internal))).toBe('transport');
    expect(classifyCallbackFailure(new ConnectError('stale', Code.FailedPrecondition))).toBe('stale_authority');
    expect(classifyCallbackFailure(new ConnectError('bad args', Code.InvalidArgument))).toBe('fatal');
    expect(classifyCallbackFailure(new ConnectError('boom', Code.Internal))).toBe('fatal');
  });

  it('retries transport failures until the orchestrator answers', async () => {
    const target = context({ graceMs: 5_000 });
    const call = vi.fn()
      .mockRejectedValueOnce(new ConnectError('connect ECONNREFUSED', Code.Unavailable))
      .mockRejectedValueOnce(new ConnectError('connect ECONNREFUSED', Code.Unavailable))
      .mockResolvedValue('result');

    await expect(callWithinOrchestratorWindow(target, 'tool', call, {
      attemptTimeoutMs: 1_000,
      log: quiet,
    })).resolves.toBe('result');
    expect(call).toHaveBeenCalledTimes(3);
  });

  it('waits for a rotated capability after a stale-authority refusal and retries with it', async () => {
    const target = context({ graceMs: 5_000 });
    const presented: string[] = [];
    const call = vi.fn(async (cap: ReturnType<typeof capability>) => {
      presented.push(`${cap.ownerId}:${cap.fenceToken}`);
      if (cap.ownerId === 'owner-a') {
        setTimeout(() => rotate(target, 'owner-b', 2), 20);
        throw new ConnectError('does not belong to the live delivery', Code.FailedPrecondition);
      }
      return 'adopted';
    });

    await expect(callWithinOrchestratorWindow(target, 'tool', call, {
      attemptTimeoutMs: 1_000,
      log: quiet,
    })).resolves.toBe('adopted');
    expect(presented).toEqual(['owner-a:1', 'owner-b:2']);
  });

  it('waits out an expired capability instead of failing immediately', async () => {
    const target = context({ graceMs: 5_000, leaseExpiresAtMs: Date.now() - 1 });
    setTimeout(() => rotate(target, 'owner-b', 2), 20);
    const call = vi.fn(async (cap: ReturnType<typeof capability>) => cap.ownerId);

    await expect(callWithinOrchestratorWindow(target, 'tool', call, {
      attemptTimeoutMs: 1_000,
      log: quiet,
    })).resolves.toBe('owner-b');
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('gives up once the window is exceeded', async () => {
    const target = context({ graceMs: 60 });
    const call = vi.fn(async () => {
      throw new ConnectError('connect ECONNREFUSED', Code.Unavailable);
    });

    await expect(callWithinOrchestratorWindow(target, 'tool "search"', call, {
      attemptTimeoutMs: 1_000,
      log: quiet,
    })).rejects.toThrow(/could not reach a live orchestrator within 60ms/);
  });

  it('opens the window when the orchestrator first fails, not when a long call started (ctx-2jp0)', async () => {
    const target = context({ graceMs: 60 });
    const call = vi.fn()
      // A parked approval: the call stays open far longer than the window,
      // then its orchestrator dies.
      .mockImplementationOnce(async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        throw new ConnectError('[aborted] socket hang up', Code.Aborted);
      })
      .mockResolvedValue('answered by the successor');

    await expect(callWithinOrchestratorWindow(target, 'tool "request-approval"', call, {
      attemptTimeoutMs: 1_000,
      log: quiet,
    })).resolves.toBe('answered by the successor');
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('abandons an orphaned delivery instead of failing the call into the harness (ctx-2jp0)', async () => {
    const target = context({ graceMs: 60 });
    const abandonIfOrphaned = vi.fn((reason: string) => {
      target.abortController.abort(new Error(`turn stopped: ${reason}`));
      return true;
    });
    target.abandonIfOrphaned = abandonIfOrphaned;
    const call = vi.fn(async () => {
      throw new ConnectError('connect ECONNREFUSED', Code.Unavailable);
    });

    await expect(callWithinOrchestratorWindow(target, 'tool "request-approval"', call, {
      attemptTimeoutMs: 1_000,
      log: quiet,
    })).rejects.toThrow('turn stopped: tool "request-approval" could not reach a live orchestrator');
    expect(abandonIfOrphaned).toHaveBeenCalledTimes(1);
  });

  it('fails the call itself when a live orchestrator is still attached', async () => {
    const target = context({ graceMs: 60 });
    target.abandonIfOrphaned = vi.fn(() => false);
    const call = vi.fn(async () => {
      throw new ConnectError('connect ECONNREFUSED', Code.Unavailable);
    });

    await expect(callWithinOrchestratorWindow(target, 'tool "search"', call, {
      attemptTimeoutMs: 1_000,
      log: quiet,
    })).rejects.toThrow(/could not reach a live orchestrator within 60ms/);
    expect(target.abortController.signal.aborted).toBe(false);
  });

  it('passes fatal errors through without retrying', async () => {
    const target = context({ graceMs: 5_000 });
    const call = vi.fn(async () => {
      throw new ConnectError('bad args', Code.InvalidArgument);
    });

    await expect(callWithinOrchestratorWindow(target, 'tool', call, {
      attemptTimeoutMs: 1_000,
      log: quiet,
    })).rejects.toMatchObject({ code: Code.InvalidArgument });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('stops as soon as the delivery is aborted', async () => {
    const target = context({ graceMs: 5_000 });
    const call = vi.fn(async () => {
      setTimeout(() => target.abortController.abort(new Error('turn cancelled')), 10);
      throw new ConnectError('connect ECONNREFUSED', Code.Unavailable);
    });

    await expect(callWithinOrchestratorWindow(target, 'tool', call, {
      attemptTimeoutMs: 1_000,
      log: quiet,
    })).rejects.toThrow('turn cancelled');
  });
});
