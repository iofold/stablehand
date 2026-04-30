/**
 * Thrown when a synchronous per-agent concurrency check rejects a new
 * session/turn because the agent has too many active sandbox sessions.
 *
 * Carries the structured fields the HTTP layer needs to surface a 429
 * with a Retry-After header so callers (e.g. PILOT dispatch) can back off
 * deterministically instead of treating saturation as an opaque 500.
 */
export class ConcurrencyLimitError extends Error {
  public readonly statusCode = 429;
  public readonly agentId: string;
  public readonly maxConcurrent: number;
  public readonly retryAfterSec: number;

  constructor(agentId: string, maxConcurrent: number, retryAfterSec: number) {
    super(`Concurrent session limit (${maxConcurrent}) reached for agent ${agentId}`);
    this.name = 'ConcurrencyLimitError';
    this.agentId = agentId;
    this.maxConcurrent = maxConcurrent;
    this.retryAfterSec = retryAfterSec;
  }
}
