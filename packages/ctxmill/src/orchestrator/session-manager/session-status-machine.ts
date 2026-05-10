import type { SessionStatus } from './types.js';

/**
 * Sandbox-session transition matrix per ADR 005.
 *
 *   ACTIVE       → CHECKPOINTED, TERMINATED
 *   CHECKPOINTED → RESTORING, TERMINATED
 *   RESTORING    → ACTIVE, CHECKPOINTED, TERMINATED
 *   TERMINATED   → (terminal)
 *
 * SessionLifecycleService is the sole owner of these transitions; route
 * handlers MUST delegate rather than calling `updateSandboxSessionStatus`
 * directly.
 */
const VALID_TRANSITIONS: ReadonlyMap<SessionStatus, readonly SessionStatus[]> = new Map([
  ['ACTIVE', ['CHECKPOINTED', 'TERMINATED']],
  ['CHECKPOINTED', ['RESTORING', 'TERMINATED']],
  ['RESTORING', ['ACTIVE', 'CHECKPOINTED', 'TERMINATED']],
  ['TERMINATED', []],
]);

export const SESSION_STATUSES: readonly SessionStatus[] = [
  'ACTIVE',
  'CHECKPOINTED',
  'RESTORING',
  'TERMINATED',
];

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

export function allowedTargets(from: SessionStatus): readonly SessionStatus[] {
  return VALID_TRANSITIONS.get(from) ?? [];
}
