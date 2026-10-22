/**
 * Raised when a successor orchestrator cannot re-attach to a turn delivery
 * that should still be running in its sandbox (ADR 025): the daemon has no
 * journal for the turn, refused the fence, or could not be reached. The turn
 * is left open so the caller can choose the fallback.
 */
export class TurnAttachUnavailableError extends Error {
  constructor(
    readonly turnId: string,
    readonly sandboxSessionId: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'TurnAttachUnavailableError';
  }
}
