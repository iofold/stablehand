import type { FastifyReply } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { sendTurnStartError } from '../turn-start-errors.js';
import { ConcurrencyLimitError } from '../session-manager/concurrency-limit-error.js';

function createReply() {
  const reply = {
    status: vi.fn(() => reply),
    header: vi.fn(() => reply),
    send: vi.fn(() => reply),
  };
  return reply;
}

describe('sendTurnStartError', () => {
  it('sends the canonical concurrency-limit response shape', () => {
    const reply = createReply();
    const err = new ConcurrencyLimitError('agent-1', 2, 5);

    expect(sendTurnStartError(reply as unknown as FastifyReply, err)).toBe(true);

    expect(reply.status).toHaveBeenCalledWith(429);
    expect(reply.header).toHaveBeenCalledWith('Retry-After', '5');
    expect(reply.send).toHaveBeenCalledWith({
      error: 'Concurrent session limit (2) reached for agent agent-1',
      code: 'concurrency_limit_reached',
      agentId: 'agent-1',
      maxConcurrent: 2,
      retryAfterSec: 5,
    });
  });

  it('leaves unrelated errors for the route-specific handlers', () => {
    const reply = createReply();

    expect(sendTurnStartError(reply as unknown as FastifyReply, new Error('nope'))).toBe(false);
    expect(reply.status).not.toHaveBeenCalled();
    expect(reply.header).not.toHaveBeenCalled();
    expect(reply.send).not.toHaveBeenCalled();
  });
});
