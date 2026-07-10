import type { FastifyReply } from 'fastify';

import { ConcurrencyLimitError } from './session-manager/concurrency-limit-error.js';

export function sendRunStartError(reply: FastifyReply, err: unknown): boolean {
  if (!(err instanceof ConcurrencyLimitError)) {
    return false;
  }

  reply
    .status(err.statusCode)
    .header('Retry-After', String(err.retryAfterSec))
    .send({
      error: err.message,
      code: 'concurrency_limit_reached',
      agentId: err.agentId,
      maxConcurrent: err.maxConcurrent,
      retryAfterSec: err.retryAfterSec,
    });
  return true;
}
