import { create } from '@bufbuild/protobuf';
import {
  Code,
  ConnectError,
  createClient,
  type Interceptor,
} from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-node';
import {
  HarnessService,
  KillSessionRequestSchema,
} from '@stablehand/proto/sandbox/v1';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  RUNTIME_INSTANCE_TOKEN_ENV,
  RUNTIME_INSTANCE_TOKEN_HEADER,
} from '../runtime-instance-auth.js';
import {
  startDaemon,
  stopDaemon,
} from '../daemon.js';

function runtimeInstanceClient(baseUrl: string, token: string) {
  const auth: Interceptor = (next) => async (request) => {
    request.header.set(RUNTIME_INSTANCE_TOKEN_HEADER, token);
    return await next(request);
  };
  const transport = createConnectTransport({
    baseUrl,
    httpVersion: '1.1',
    interceptors: [auth],
  });
  return createClient(HarnessService, transport);
}

describe('sandbox runtime instance authentication network boundary', () => {
  afterEach(async () => {
    await stopDaemon();
    vi.unstubAllEnvs();
  });

  it('rejects a predecessor client at the replacement daemon before KillSession dispatch', async () => {
    vi.stubEnv(RUNTIME_INSTANCE_TOKEN_ENV, 'successor-token');
    const server = await startDaemon(0);
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('expected daemon to listen on a TCP port');
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const request = create(KillSessionRequestSchema, {
      sessionId: 'probe',
      reason: 'readiness',
    });

    const predecessor = runtimeInstanceClient(baseUrl, 'predecessor-token');
    const staleFailure = await predecessor.killSession(request).catch(
      (error: unknown) => error,
    );
    expect(staleFailure).toBeInstanceOf(ConnectError);
    expect((staleFailure as ConnectError).code).toBe(Code.Unauthenticated);

    const successor = runtimeInstanceClient(baseUrl, 'successor-token');
    const successorResponse = await successor.killSession(request).catch(
      (error: unknown) => error,
    );
    expect(successorResponse).toBeInstanceOf(ConnectError);
    expect((successorResponse as ConnectError).code).toBe(Code.NotFound);
  });
});
