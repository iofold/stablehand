import { afterEach, describe, expect, it, vi } from 'vitest';

import { acquireTurnDeliveryLease } from '../turn-delivery-lease.js';

describe('turn delivery lease guard', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits for an in-flight renewal before releasing the same fence', async () => {
    vi.useFakeTimers();
    let localNow = 0;
    let finishRenewal!: () => void;
    const renewalFinished = new Promise<void>((resolve) => {
      finishRenewal = resolve;
    });
    const db = {
      claimTurnDeliveryLease: vi.fn(async () => ({
        turnId: 'turn-1',
        ownerId: 'replica-a',
        fenceToken: 1,
        leaseExpiresAt: 60_000,
        updatedAt: 0,
      })),
      renewTurnDeliveryLease: vi.fn(async () => {
        await renewalFinished;
        return {
          turnId: 'turn-1',
          ownerId: 'replica-a',
          fenceToken: 1,
          leaseExpiresAt: 60_025,
          updatedAt: 25,
        };
      }),
      releaseTurnDeliveryLease: vi.fn(async () => true),
    };
    const guard = await acquireTurnDeliveryLease(
      { db, logger: { warn: vi.fn() } },
      'turn-1',
      {
        ownerId: 'replica-a',
        leaseMs: 100,
        heartbeatMs: 25,
        now: () => localNow,
      },
    );

    localNow = 25;
    await vi.advanceTimersByTimeAsync(25);
    expect(db.renewTurnDeliveryLease).toHaveBeenCalledWith(
      'turn-1',
      'replica-a',
      1,
      100,
    );

    let released = false;
    const release = guard!.release().then(() => {
      released = true;
    });
    await Promise.resolve();
    expect(released).toBe(false);
    expect(db.releaseTurnDeliveryLease).not.toHaveBeenCalled();

    finishRenewal();
    await release;
    expect(db.releaseTurnDeliveryLease).toHaveBeenCalledWith(
      'turn-1',
      'replica-a',
      1,
    );
  });

  it('aborts immediately when the database refuses renewal of the live token', async () => {
    vi.useFakeTimers();
    let localNow = 0;
    const logger = { warn: vi.fn() };
    const db = {
      claimTurnDeliveryLease: vi.fn(async () => ({
        turnId: 'turn-2',
        ownerId: 'replica-a',
        fenceToken: 4,
        leaseExpiresAt: 60_000,
        updatedAt: 0,
      })),
      renewTurnDeliveryLease: vi.fn(async () => undefined),
      releaseTurnDeliveryLease: vi.fn(async () => false),
    };
    const guard = await acquireTurnDeliveryLease(
      { db, logger },
      'turn-2',
      {
        ownerId: 'replica-a',
        leaseMs: 100,
        heartbeatMs: 25,
        now: () => localNow,
      },
    );

    localNow = 25;
    await vi.advanceTimersByTimeAsync(25);

    expect(guard!.signal.aborted).toBe(true);
    expect(guard!.signal.reason).toEqual(
      expect.objectContaining({ message: 'lost delivery lease for turn turn-2' }),
    );
    await guard!.release();
    expect(db.releaseTurnDeliveryLease).toHaveBeenCalledWith(
      'turn-2',
      'replica-a',
      4,
    );
  });

  it('bounds release by local lease expiry when renewal never settles', async () => {
    vi.useFakeTimers();
    let localNow = 0;
    const db = {
      claimTurnDeliveryLease: vi.fn(async () => ({
        turnId: 'turn-hung-renewal',
        ownerId: 'replica-a',
        fenceToken: 7,
        leaseExpiresAt: 60_000,
        updatedAt: 0,
      })),
      renewTurnDeliveryLease: vi.fn(
        () => new Promise<undefined>(() => undefined),
      ),
      releaseTurnDeliveryLease: vi.fn(async () => true),
    };
    const guard = await acquireTurnDeliveryLease(
      { db, logger: { warn: vi.fn() } },
      'turn-hung-renewal',
      {
        ownerId: 'replica-a',
        leaseMs: 100,
        heartbeatMs: 25,
        now: () => localNow,
      },
    );

    localNow = 25;
    await vi.advanceTimersByTimeAsync(25);
    expect(db.renewTurnDeliveryLease).toHaveBeenCalledOnce();

    let released = false;
    const release = guard!.release().then(() => {
      released = true;
    });
    await Promise.resolve();
    expect(released).toBe(false);

    localNow = 100;
    await vi.advanceTimersByTimeAsync(75);
    await release;

    expect(guard!.signal.aborted).toBe(true);
    expect(db.releaseTurnDeliveryLease).toHaveBeenCalledWith(
      'turn-hung-renewal',
      'replica-a',
      7,
    );
  });
});
