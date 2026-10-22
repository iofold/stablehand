import type { DeliveryStamp } from '@stablehand/sandbox-daemon';

export type { DeliveryStamp };

/**
 * Side channel carrying a daemon journal position (ADR 025) on the AG-UI
 * shaped events AgentTurnService consumes, without adding non-protocol keys
 * to the events themselves.
 */
const stamps = new WeakMap<object, DeliveryStamp>();

export function stampDelivery<T extends object>(
  target: T,
  stamp: DeliveryStamp | undefined,
): T {
  if (stamp) {
    stamps.set(target, stamp);
  }
  return target;
}

export function readDeliveryStamp(target: object): DeliveryStamp | undefined {
  return stamps.get(target);
}
