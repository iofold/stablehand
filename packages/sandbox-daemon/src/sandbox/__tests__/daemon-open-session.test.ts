import { create } from '@bufbuild/protobuf';
import type { HandlerContext } from '@connectrpc/connect';
import {
  FreshBootstrapSchema,
  OpenSessionRequestSchema,
} from '@ctxmill/proto/sandbox/v1';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  openSession: vi.fn(async () => ({
    sessionId: 'session-1',
    status: 'ready',
  })),
  killSession: vi.fn(async () => undefined),
}));

vi.mock('../runner.js', () => ({
  openSession: mocks.openSession,
  deliverTurn: vi.fn(async function* () {}),
  suspendSession: vi.fn(),
  killSession: mocks.killSession,
}));

import {
  handleOpenSession,
  stopDaemon,
} from '../daemon.js';

describe('sandbox daemon OpenSession transport context', () => {
  afterEach(async () => {
    await stopDaemon();
    vi.clearAllMocks();
  });

  it('propagates the Connect request abort signal into runner bootstrap', async () => {
    const request = create(OpenSessionRequestSchema, {
      bootstrap: {
        case: 'fresh',
        value: create(FreshBootstrapSchema, {
          agentId: 'agent-1',
          conversationId: 'conversation-1',
          harnessName: 'langgraph',
          sessionId: 'session-1',
        }),
      },
    });
    const controller = new AbortController();
    const context = {
      signal: controller.signal,
    } as unknown as HandlerContext;

    await handleOpenSession(request, context);

    expect(mocks.openSession).toHaveBeenCalledWith(
      request,
      expect.any(Object),
      { signal: controller.signal },
    );
  });
});
