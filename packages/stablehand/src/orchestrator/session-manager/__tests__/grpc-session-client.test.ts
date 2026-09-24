import { Code, ConnectError } from '@connectrpc/connect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const connectMocks = vi.hoisted(() => ({
  createClientMock: vi.fn(),
  createConnectTransportMock: vi.fn(),
}));

vi.mock('@connectrpc/connect', async () => {
  const actual = await vi.importActual<typeof import('@connectrpc/connect')>('@connectrpc/connect');
  return {
    ...actual,
    createClient: connectMocks.createClientMock,
  };
});

vi.mock('@connectrpc/connect-node', () => ({
  createConnectTransport: connectMocks.createConnectTransportMock,
}));

import {
  createHarnessTransport,
  createRuntimeInstanceToken,
  retryGrpcCall,
  waitForContainerReady,
} from '../grpc-session-client.js';

describe('grpc-session-client.waitForContainerReady', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    connectMocks.createConnectTransportMock.mockReturnValue({ kind: 'transport' });
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('creates distinct high-entropy tokens for separate container instances', () => {
    const first = createRuntimeInstanceToken();
    const second = createRuntimeInstanceToken();

    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).not.toBe(first);
  });

  it('authenticates every request with the sandbox runtime instance token', async () => {
    createHarnessTransport(
      'http://stablehand-sandbox-sess-1:50051',
      'runtime-instance-token-1',
    );

    const transportOptions = connectMocks.createConnectTransportMock.mock.calls[0]?.[0];
    const interceptor = transportOptions?.interceptors?.[0];
    if (!interceptor) {
      throw new Error('expected a runtime-instance authentication interceptor');
    }
    const next = vi.fn(async () => ({ ok: true }));
    const request = { header: new Headers() };

    await interceptor(next)(request);

    expect(request.header.get('x-stablehand-runtime-instance-token')).toBe(
      'runtime-instance-token-1',
    );
    expect(next).toHaveBeenCalledOnce();
  });

  it('retries transport failures until the sandbox answers', async () => {
    const grpcClient = {
      killSession: vi.fn()
        .mockRejectedValueOnce(new ConnectError('unavailable', Code.Unavailable))
        .mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:50051'))
        .mockResolvedValue({ finalStatus: 'no_session' }),
    };
    connectMocks.createClientMock.mockReturnValue(grpcClient);

    const readyPromise = waitForContainerReady(
      'http://stablehand-sandbox-sess-1:50051',
      {
        runtimeInstanceToken: 'runtime-instance-token-1',
        timeoutMs: 5_000,
      },
    );
    await vi.advanceTimersByTimeAsync(1_000);
    const ready = await readyPromise;

    expect(grpcClient.killSession).toHaveBeenCalledTimes(3);
    expect(ready).toEqual({
      transport: { kind: 'transport' },
      grpcClient,
    });
  });

  it('treats app-level RPC errors as proof the sandbox is reachable', async () => {
    const grpcClient = {
      killSession: vi.fn().mockRejectedValue(new ConnectError('invalid', Code.InvalidArgument)),
    };
    connectMocks.createClientMock.mockReturnValue(grpcClient);

    const ready = await waitForContainerReady(
      'http://stablehand-sandbox-sess-1:50051',
      {
        runtimeInstanceToken: 'runtime-instance-token-1',
        timeoutMs: 5_000,
      },
    );

    expect(grpcClient.killSession).toHaveBeenCalledTimes(1);
    expect(ready).toEqual({
      transport: { kind: 'transport' },
      grpcClient,
    });
  });

  it.each([
    ['unauthenticated', Code.Unauthenticated],
    ['permission denied', Code.PermissionDenied],
  ])('does not accept %s as container readiness', async (_label, code) => {
    const grpcClient = {
      killSession: vi.fn().mockRejectedValue(
        new ConnectError('invalid runtime instance token', code),
      ),
    };
    connectMocks.createClientMock.mockReturnValue(grpcClient);

    await expect(
      waitForContainerReady(
        'http://stablehand-sandbox-sess-1:50051',
        {
          runtimeInstanceToken: 'predecessor-token',
          timeoutMs: 5_000,
        },
      ),
    ).rejects.toMatchObject({
      code,
    });
    expect(grpcClient.killSession).toHaveBeenCalledOnce();
  });

  it('does not retry a gRPC call after restore ownership is aborted', async () => {
    const controller = new AbortController();
    const call = vi.fn().mockRejectedValue(
      new ConnectError('unavailable', Code.Unavailable),
    );
    const retry = retryGrpcCall(call, 5, 1_000, controller.signal);
    const rejection = expect(retry).rejects.toThrow('restore lease lost');
    await Promise.resolve();
    await Promise.resolve();

    controller.abort(new Error('restore lease lost'));
    await vi.advanceTimersByTimeAsync(10_000);

    await rejection;
    expect(call).toHaveBeenCalledOnce();
  });

  it('stops readiness polling when restore ownership is aborted', async () => {
    const controller = new AbortController();
    const grpcClient = {
      killSession: vi.fn().mockRejectedValue(
        new ConnectError('unavailable', Code.Unavailable),
      ),
    };
    connectMocks.createClientMock.mockReturnValue(grpcClient);

    const ready = waitForContainerReady(
      'http://stablehand-sandbox-sess-1:50051',
      {
        runtimeInstanceToken: 'runtime-instance-token-1',
        timeoutMs: 5_000,
        signal: controller.signal,
      },
    );
    const rejection = expect(ready).rejects.toThrow('restore lease lost');
    await Promise.resolve();
    await Promise.resolve();
    controller.abort(new Error('restore lease lost'));
    await vi.advanceTimersByTimeAsync(5_000);

    await rejection;
    expect(grpcClient.killSession).toHaveBeenCalledOnce();
  });
});
