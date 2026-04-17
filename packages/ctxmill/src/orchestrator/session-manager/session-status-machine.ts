import type { SessionStatus } from './types.js';

const VALID_TRANSITIONS: ReadonlyMap<SessionStatus, readonly SessionStatus[]> = new Map([
  ['ACTIVE', ['CHECKPOINTED', 'TERMINATED']],
  ['PAUSED', ['CHECKPOINTED', 'ACTIVE', 'TERMINATED']],
  ['CHECKPOINTED', ['RESTORING', 'TERMINATED']],
  ['RESTORING', ['ACTIVE', 'CHECKPOINTED']],
  ['TERMINATED', []],
]);

export function canTransition(from: SessionStatus, to: SessionStatus): boolean {
  return VALID_TRANSITIONS.get(from)?.includes(to) ?? false;
}

export function assertTransition(from: SessionStatus, to: SessionStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid sandbox session status transition: ${from} -> ${to}`);
  }
}

export function isTerminal(status: SessionStatus): boolean {
  return (VALID_TRANSITIONS.get(status)?.length ?? 0) === 0;
}
