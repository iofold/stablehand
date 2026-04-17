import { create } from '@bufbuild/protobuf';
import { Code, ConnectError, createClient } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-node';
import { HarnessService, KillSessionRequestSchema } from '@ctxmill/proto/sandbox/v1';
import { Agent } from 'node:http';

const HEALTH_CHECK_TIMEOUT_MS = 10_000;

const sandboxAgent = new Agent({
  keepAlive: true,
  keepAliveMsecs: 30_000,
});

export type HarnessTransport = ReturnType<typeof createConnectTransport>;
export type HarnessGrpcClient = ReturnType<typeof createClient<typeof HarnessService>>;

export interface ReadyClient {
  transport: HarnessTransport;
  grpcClient: HarnessGrpcClient;
}

export function createHarnessTransport(baseUrl: string): HarnessTransport {
  return createConnectTransport({
    baseUrl,
    httpVersion: '1.1',
    nodeOptions: { agent: sandboxAgent, timeout: 0 },
  });
}

export function createHarnessClient(transport: HarnessTransport): HarnessGrpcClient {
  return createClient(HarnessService, transport);
}

export async function waitForContainerReady(
  baseUrl: string,
  timeoutMs = HEALTH_CHECK_TIMEOUT_MS,
): Promise<ReadyClient> {
  const transport = createHarnessTransport(baseUrl);
  const grpcClient = createHarnessClient(transport);
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      await grpcClient.killSession(
        create(KillSessionRequestSchema, { sessionId: 'probe', reason: 'probe' }),
      );
      return { transport, grpcClient };
    } catch (err) {
      if (isAppLevelProbeError(err)) {
        return { transport, grpcClient };
      }
      if (!isRetryableTransportProbeError(err)) {
        throw err;
      }
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 500);
      unrefTimer(timer);
    });
  }

  throw new Error(`Container health check timed out after ${timeoutMs}ms at ${baseUrl}`);
}

function isAppLevelProbeError(err: unknown): err is ConnectError {
  return err instanceof ConnectError && !isRetryableTransportProbeError(err);
}

function isRetryableTransportProbeError(err: unknown): boolean {
  if (err instanceof ConnectError) {
    return err.code === Code.Unavailable || err.code === Code.Internal;
  }

  return err instanceof Error && /ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN/.test(err.message);
}

export async function retryGrpcCall<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  delayMs: number,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      const shouldRetry = err instanceof ConnectError && err.code === Code.Unavailable;
      if (!shouldRetry || attempt >= maxRetries) {
        throw err;
      }

      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delayMs * (attempt + 1));
        unrefTimer(timer);
      });
    }
  }

  throw lastError;
}

export function unrefTimer(timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>): void {
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
    timer.unref();
  }
}
