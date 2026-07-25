import type { CanonicalStreamEvent } from '../../../packages/contracts/src/index.js';

export interface TurnEventObservation {
  firstEventAtMs?: number;
  runStartedAtMs?: number;
  firstTokenAtMs?: number;
  terminalAtMs?: number;
  firstServerEventAtMs?: number;
  terminalServerEventAtMs?: number;
  eventCount?: number;
  terminalType?: 'RUN_FINISHED' | 'RUN_ERROR';
}

export function eventTurnId(
  event: CanonicalStreamEvent,
): string | undefined {
  if ('turnId' in event && typeof event.turnId === 'string') {
    return event.turnId;
  }
  if ('runId' in event && typeof event.runId === 'string') {
    return event.runId;
  }
  return undefined;
}

export function observeTurnEvent(
  observation: TurnEventObservation,
  event: CanonicalStreamEvent,
  receivedAtMs: number,
): void {
  observation.eventCount = (observation.eventCount ?? 0) + 1;
  observation.firstEventAtMs ??= receivedAtMs;
  if (observation.firstServerEventAtMs === undefined && event.timestamp !== undefined) {
    observation.firstServerEventAtMs = event.timestamp;
  }

  if (event.type === 'RUN_STARTED') {
    observation.runStartedAtMs ??= receivedAtMs;
  }
  if (event.type === 'TEXT_MESSAGE_CONTENT' && event.delta.length > 0) {
    observation.firstTokenAtMs ??= receivedAtMs;
  }
  if (
    (event.type === 'RUN_FINISHED' || event.type === 'RUN_ERROR')
    && observation.terminalAtMs === undefined
  ) {
    observation.terminalAtMs = receivedAtMs;
    observation.terminalType = event.type;
    if (event.timestamp !== undefined) {
      observation.terminalServerEventAtMs = event.timestamp;
    }
  }
}
