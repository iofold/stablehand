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

import { waitForContainerReady } from '../grpc-session-client.js';

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

  it('retries transport failures until the sandbox answers', async () => {
    const grpcClient = {
      killSession: vi.fn()
        .mockRejectedValueOnce(new ConnectError('unavailable', Code.Unavailable))
        .mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:50051'))
        .mockResolvedValue({ finalStatus: 'no_session' }),
    };
    connectMocks.createClientMock.mockReturnValue(grpcClient);

    const readyPromise = waitForContainerReady('http://ctxmill-run-sess-1:50051', 5_000);
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

    const ready = await waitForContainerReady('http://ctxmill-run-sess-1:50051', 5_000);

    expect(grpcClient.killSession).toHaveBeenCalledTimes(1);
    expect(ready).toEqual({
      transport: { kind: 'transport' },
      grpcClient,
    });
  });
});
