/**
 * Classification of trigger-fire failures (ctx-v6ef).
 *
 * A failure is non-retryable when trying again cannot change the outcome
 * without an operator acting first: the target agent refuses this kind of
 * run, a budget or tag policy blocks it, the agent is gone, or the input is
 * invalid. Those firings are dead-lettered at once so the event spine keeps
 * moving. Everything else (capacity throttles, database or network faults,
 * unknown errors) is retryable: the spine consumer runner retries it with
 * bounded backoff before dead-lettering it.
 *
 * Classification is by the error's `code` so this module does not import the
 * orchestrator's error classes (events/ sits below orchestrator/).
 */

/** Error codes that retrying cannot fix. */
export const NON_RETRYABLE_TRIGGER_ERROR_CODES: ReadonlySet<string> = new Set([
  'agent_mode_not_allowed',
  'budget_exceeded',
  'tag_conflict',
  'tag_not_provisioned',
  'trigger_target_not_found',
  'trigger_target_misconfigured',
  'invalid_trigger_input',
]);

/** Longest error message kept on a dead-letter row or event. */
export const TRIGGER_FAILURE_MESSAGE_MAX_CHARS = 2_000;

export interface TriggerFireFailure {
  retryable: boolean;
  /** Machine token, e.g. `agent_mode_not_allowed`; `trigger_fire_failed` when unknown. */
  code: string;
  /** Human-readable reason, truncated to TRIGGER_FAILURE_MESSAGE_MAX_CHARS. */
  message: string;
}

/** A trigger target that cannot accept runs until someone fixes it. */
export class TriggerTargetError extends Error {
  constructor(
    readonly code: 'trigger_target_not_found' | 'trigger_target_misconfigured',
    message: string,
  ) {
    super(message);
    this.name = 'TriggerTargetError';
  }
}

function errorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.length > TRIGGER_FAILURE_MESSAGE_MAX_CHARS
    ? `${raw.slice(0, TRIGGER_FAILURE_MESSAGE_MAX_CHARS - 1)}…`
    : raw;
}

export function classifyTriggerFireError(err: unknown): TriggerFireFailure {
  const message = errorMessage(err);
  if (err instanceof Error && err.name === 'ZodError') {
    return { retryable: false, code: 'invalid_trigger_input', message };
  }
  const code = errorCode(err);
  if (code && NON_RETRYABLE_TRIGGER_ERROR_CODES.has(code)) {
    return { retryable: false, code, message };
  }
  return { retryable: true, code: code ?? 'trigger_fire_failed', message };
}

/**
 * Thrown by EventTriggerManager when at least one trigger for an event failed
 * with a retryable error. The cursor holds; the spine runner retries the
 * event with backoff and dead-letters it after the attempt budget.
 */
export class RetryableTriggerFireError extends Error {
  constructor(
    readonly eventType: string,
    readonly eventSeq: number | undefined,
    readonly failures: ReadonlyArray<{ triggerId: string; agentId: string; failure: TriggerFireFailure }>,
    options?: { cause?: unknown },
  ) {
    super(
      `${failures.length} trigger(s) failed for ${eventType}`
      + `${eventSeq === undefined ? '' : ` seq ${eventSeq}`}: `
      + failures.map(({ triggerId, failure }) => `${triggerId}: ${failure.message}`).join('; '),
      options,
    );
    this.name = 'RetryableTriggerFireError';
  }
}
