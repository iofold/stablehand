import { create } from '@bufbuild/protobuf';
import {
  Code,
  ConnectError,
  createClient,
  type Interceptor,
} from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-node';
import {
  DeliverTurnRequestSchema,
  FreshBootstrapSchema,
  HarnessService,
  OpenSessionRequestSchema,
  RenewTurnDeliveryCapabilityRequestSchema,
  TurnDeliveryCapabilitySchema,
} from '@stablehand/proto/sandbox/v1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AgentEvent,
  HarnessTurnContext,
  HarnessTurnInput,
} from '../../harness/types.js';
import {
  RUNTIME_INSTANCE_TOKEN_ENV,
  RUNTIME_INSTANCE_TOKEN_HEADER,
} from '../runtime-instance-auth.js';

const mocks = vi.hoisted(() => ({
  harnessDeliverTurn: vi.fn(),
  harnessClose: vi.fn(async () => undefined),
}));

vi.mock('../../harness/langgraph.js', () => ({
  LangGraphHarness: class {
    async openSession() {
      return {
        deliverTurn: (
          input: HarnessTurnInput,
          context: HarnessTurnContext,
        ) => mocks.harnessDeliverTurn(input, context),
        exportState: async () => ({ stateVersion: '2', payload: {} }),
        close: mocks.harnessClose,
      };
    }
  },
}));

import { startDaemon, stopDaemon } from '../daemon.js';

function runtimeClient(baseUrl: string, token: string) {
  const auth: Interceptor = (next) => async (request) => {
    request.header.set(RUNTIME_INSTANCE_TOKEN_HEADER, token);
    return await next(request);
  };
  return createClient(
    HarnessService,
    createConnectTransport({
      baseUrl,
      httpVersion: '1.1',
      interceptors: [auth],
    }),
  );
}

function capability(
  ownerId: string,
  fenceToken: number,
  leaseExpiresAtMs: number,
) {
  return create(TurnDeliveryCapabilitySchema, {
    ownerId,
    fenceToken: BigInt(fenceToken),
    leaseExpiresAtMs: BigInt(leaseExpiresAtMs),
    restoreFenceToken: 0n,
    containerId: 'container-1',
    agentId: 'agent-1',
    signature: 'stablehand-open-turn-delivery-capability-v1',
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('turn delivery capability network boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv(RUNTIME_INSTANCE_TOKEN_ENV, 'runtime-token');
    mocks.harnessDeliverTurn.mockImplementation(async function* () {
      yield { type: 'done', result: 'ok' } satisfies AgentEvent;
    });
  });

  afterEach(async () => {
    await stopDaemon();
    vi.unstubAllEnvs();
  });

  async function startOpenedClient() {
    const server = await startDaemon(0);
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('expected daemon to listen on a TCP port');
    }
    const client = runtimeClient(
      `http://127.0.0.1:${address.port}`,
      'runtime-token',
    );
    await client.openSession(create(OpenSessionRequestSchema, {
      bootstrap: {
        case: 'fresh',
        value: create(FreshBootstrapSchema, {
          agentId: 'agent-1',
          conversationId: 'conversation-1',
          harnessName: 'langgraph',
          harnessConfigJson: '{}',
          systemPrompt: 'network test',
          workspaceDir: '/tmp/stablehand-capability-network',
          sessionId: 'session-1',
        }),
      },
    }));
    return client;
  }

  it('rejects a lower fence over Connect after admitting a successor', async () => {
    const client = await startOpenedClient();
    const successor = create(DeliverTurnRequestSchema, {
      sessionId: 'session-1',
      turnId: 'turn-1',
      deliveryCapability: capability(
        'owner-2',
        2,
        Date.now() + 60_000,
      ),
    });
    const successorCases: Array<string | undefined> = [];
    for await (const event of client.deliverTurn(successor)) {
      successorCases.push(event.payload.case);
    }
    expect(successorCases).toEqual(['agentEvent', 'turnCompleted']);

    const stale = create(DeliverTurnRequestSchema, {
      sessionId: 'session-1',
      turnId: 'turn-1',
      deliveryCapability: capability(
        'owner-1',
        1,
        Date.now() + 60_000,
      ),
    });
    const staleError = await client.deliverTurn(stale)[Symbol.asyncIterator]()
      .next()
      .catch((error: unknown) => error);
    expect(staleError).toBeInstanceOf(ConnectError);
    expect((staleError as ConnectError).code).toBe(Code.FailedPrecondition);
    expect(mocks.harnessDeliverTurn).toHaveBeenCalledTimes(1);
  });

  it('renews the exact active capability over Connect without restarting the harness', async () => {
    const harnessStarted = deferred();
    const releaseHarness = deferred();
    mocks.harnessDeliverTurn.mockImplementation(async function* () {
      harnessStarted.resolve();
      await releaseHarness.promise;
      yield { type: 'done', result: 'renewed' } satisfies AgentEvent;
    });
    const client = await startOpenedClient();
    const initial = create(DeliverTurnRequestSchema, {
      sessionId: 'session-1',
      turnId: 'turn-renew',
      deliveryCapability: capability(
        'owner-1',
        1,
        Date.now() + 60_000,
      ),
    });
    const iterator = client.deliverTurn(initial)[Symbol.asyncIterator]();
    const firstEvent = iterator.next();
    await harnessStarted.promise;

    const renewedExpiry = Date.now() + 120_000;
    await expect(client.renewTurnDeliveryCapability(
      create(RenewTurnDeliveryCapabilityRequestSchema, {
        sessionId: 'session-1',
        turnId: 'turn-renew',
        deliveryCapability: capability('owner-1', 1, renewedExpiry),
      }),
    )).resolves.toMatchObject({ renewed: true });

    releaseHarness.resolve();
    expect((await firstEvent).value?.payload.case).toBe('agentEvent');
    expect((await iterator.next()).value?.payload.case).toBe('turnCompleted');
    expect((await iterator.next()).done).toBe(true);
    expect(mocks.harnessDeliverTurn).toHaveBeenCalledTimes(1);
  });
});
