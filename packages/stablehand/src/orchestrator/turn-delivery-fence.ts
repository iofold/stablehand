import type { EventMap } from '../events/bus.js';

/** Monotonic ownership token for one admitted turn delivery. */
export interface TurnDeliveryFence {
  ownerId: string;
  fenceToken: number;
}

/**
 * Recovery-only startup state. Its publications are persisted idempotently at
 * the fenced delivery boundary, after durable activation succeeds.
 */
export interface TurnDeliveryContext {
  fence: TurnDeliveryFence;
  userMessage?: EventMap['user.message'];
}
