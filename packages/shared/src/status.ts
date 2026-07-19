import type {
  ApiConversationStatus,
  ApiTurnStatus,
  SandboxSessionStatus,
} from './api.js';

export const TURN_CANCELLED_MESSAGE = 'Turn cancelled';

export function isTurnCancelled(error: string | null | undefined): boolean {
  return error === TURN_CANCELLED_MESSAGE;
}

export function projectTurnStatus(
  turn: {
    status: string;
    completedAt: number | null;
    error: string | null;
  },
): ApiTurnStatus {
  if (isTurnCancelled(turn.error)) return 'CANCELLED';
  if (turn.error || turn.status === 'failed') return 'ERROR';
  if (turn.completedAt != null || turn.status === 'completed') return 'COMPLETED';
  return turn.status === 'queued' ? 'QUEUED' : 'RUNNING';
}

/** Project the latest turn plus its sandbox lifecycle into conversation state. */
export function projectConversationStatus(
  turn: { completedAt: number | null; error: string | null } | null | undefined,
  sandboxStatus: string | null | undefined,
): ApiConversationStatus {
  if (turn && isTurnCancelled(turn.error)) {
    return 'CANCELLED';
  }
  if (turn?.error) {
    return 'ERROR';
  }
  if (turn && turn.completedAt != null) {
    return 'COMPLETED';
  }
  if (
    sandboxStatus === 'ACTIVE'
    || sandboxStatus === 'CHECKPOINTED'
    || sandboxStatus === 'RESTORING'
  ) {
    return sandboxStatus as Exclude<SandboxSessionStatus, 'TERMINATED'>;
  }
  return 'IDLE';
}
