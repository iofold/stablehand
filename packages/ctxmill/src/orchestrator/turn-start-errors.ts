import type { FastifyReply } from 'fastify';

import { ConcurrencyLimitError } from './session-manager/concurrency-limit-error.js';
import { BudgetExceededError, TagConflictError, TagNotProvisionedError } from './budgets.js';

export function sendTurnStartError(reply: FastifyReply, err: unknown): boolean {
  if (err instanceof BudgetExceededError) {
    reply.status(err.statusCode).send({
      error: err.message,
      code: err.code,
      policyId: err.policyId,
      policyName: err.policyName,
      ...(err.bucket ? { bucket: err.bucket } : {}),
      metric: err.status.metric,
      spent: err.status.spent,
      limit: err.status.limit,
    });
    return true;
  }

  if (err instanceof TagConflictError || err instanceof TagNotProvisionedError) {
    reply.status(err.statusCode).send({ error: err.message, code: err.code });
    return true;
  }

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
