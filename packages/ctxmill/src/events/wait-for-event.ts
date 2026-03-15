import type { TypedEventBus, EventMap, EventName } from './bus.js';

/**
 * Error thrown when waitForEvent times out before a matching event is received.
 */
export class EventTimeoutError extends Error {
  eventType: string;
  timeoutMs: number;

  constructor(eventType: string, timeoutMs: number) {
    super(`waitForEvent timeout after ${timeoutMs}ms for event "${eventType}"`);
    this.name = 'EventTimeoutError';
    this.eventType = eventType;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Wait for an event matching a predicate, with a timeout.
 *
 * Overload without predicate: matches any event of that type.
 */
export function waitForEvent<K extends EventName>(
  bus: TypedEventBus,
  eventType: K,
  timeoutMs: number,
): Promise<EventMap[K]>;

/**
 * Wait for an event matching a predicate, with a timeout.
 *
 * Overload with predicate: only resolves when predicate returns true.
 */
export function waitForEvent<K extends EventName>(
  bus: TypedEventBus,
  eventType: K,
  predicate: (payload: EventMap[K]) => boolean,
  timeoutMs: number,
): Promise<EventMap[K]>;

/**
 * Implementation.
 */
export function waitForEvent<K extends EventName>(
  bus: TypedEventBus,
  eventType: K,
  predicateOrTimeout: ((payload: EventMap[K]) => boolean) | number,
  timeoutMs?: number,
): Promise<EventMap[K]> {
  const predicate: ((payload: EventMap[K]) => boolean) | undefined =
    typeof predicateOrTimeout === 'function' ? predicateOrTimeout : undefined;
  const deadline: number =
    typeof predicateOrTimeout === 'number' ? predicateOrTimeout : timeoutMs!;

  return new Promise<EventMap[K]>((resolve, reject) => {
    let resolved = false;

    const handler = (payload: EventMap[K]) => {
      if (resolved) return;

      // If a predicate is provided, check it (treat throws as non-match)
      if (predicate) {
        try {
          if (!predicate(payload)) return;
        } catch (err) {
          console.warn(
            `[waitForEvent] predicate threw for "${String(eventType)}":`,
            err,
          );
          return;
        }
      }

      resolved = true;
      clearTimeout(timer);
      bus.off(eventType, handler);
      resolve(payload);
    };

    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      bus.off(eventType, handler);
      reject(new EventTimeoutError(String(eventType), deadline));
    }, deadline);

    bus.on(eventType, handler);
  });
}
