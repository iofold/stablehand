/**
 * Raised when a durable approval continuation can never succeed, so retrying
 * it would only fail the same way (ctx-2jp0): for example, the sandbox had
 * already ended the parked run on its own and acknowledges the continuation
 * as a duplicate. The resume worker closes the turn with `reason` instead of
 * retrying and leaving it RUNNING.
 */
export class InterruptContinuationUnrecoverableError extends Error {
  constructor(
    readonly turnId: string,
    /** Why the run cannot continue, in plain words for the turn's error. */
    readonly reason: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'InterruptContinuationUnrecoverableError';
  }
}
