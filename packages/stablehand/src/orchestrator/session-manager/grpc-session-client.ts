import { create } from '@bufbuild/protobuf';
import {
  Code,
  ConnectError,
  createClient,
  type Interceptor,
} from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-node';
import { HarnessService, KillSessionRequestSchema } from '@stablehand/proto/sandbox/v1';
import { RUNTIME_INSTANCE_TOKEN_HEADER } from '@stablehand/shared';
import { randomBytes } from 'node:crypto';
import { Agent } from 'node:http';

import { unrefTimer } from '../../util/timing.js';

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

export interface WaitForContainerReadyOptions {
  runtimeInstanceToken: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export function createRuntimeInstanceToken(): string {
  return randomBytes(32).toString('base64url');
}

function createRuntimeInstanceAuthInterceptor(
  runtimeInstanceToken: string,
): Interceptor {
  const token = runtimeInstanceToken.trim();
  if (!token) {
    throw new Error('Sandbox runtime instance token is required');
  }

  return (next) => async (request) => {
    request.header.set(RUNTIME_INSTANCE_TOKEN_HEADER, token);
    return await next(request);
  };
}

export function createHarnessTransport(
  baseUrl: string,
  runtimeInstanceToken: string,
): HarnessTransport {
  return createConnectTransport({
    baseUrl,
    httpVersion: '1.1',
    nodeOptions: { agent: sandboxAgent, timeout: 0 },
    interceptors: [
      createRuntimeInstanceAuthInterceptor(runtimeInstanceToken),
    ],
  });
}

export function createHarnessClient(transport: HarnessTransport): HarnessGrpcClient {
  return createClient(HarnessService, transport);
}

export async function waitForContainerReady(
  baseUrl: string,
  options: WaitForContainerReadyOptions,
): Promise<ReadyClient> {
  const timeoutMs = options.timeoutMs ?? HEALTH_CHECK_TIMEOUT_MS;
  const signal = options.signal;
  const transport = createHarnessTransport(
    baseUrl,
    options.runtimeInstanceToken,
  );
  const grpcClient = createHarnessClient(transport);
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    signal?.throwIfAborted();
    try {
      await grpcClient.killSession(
        create(KillSessionRequestSchema, { sessionId: 'probe', reason: 'probe' }),
        { signal },
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

    await abortableDelay(500, signal);
  }

  throw new Error(`Container health check timed out after ${timeoutMs}ms at ${baseUrl}`);
}

function isAppLevelProbeError(err: unknown): err is ConnectError {
  return err instanceof ConnectError
    && err.code !== Code.Unauthenticated
    && err.code !== Code.PermissionDenied
    && !isRetryableTransportProbeError(err);
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
  signal?: AbortSignal,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    signal?.throwIfAborted();
    try {
      return await fn();
    } catch (err) {
      signal?.throwIfAborted();
      lastError = err;

      const shouldRetry = err instanceof ConnectError && err.code === Code.Unavailable;
      if (!shouldRetry || attempt >= maxRetries) {
        throw err;
      }

      await abortableDelay(delayMs * (attempt + 1), signal);
    }
  }

  throw lastError;
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const finish = (): void => {
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const abort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(signal?.reason);
    };
    const timer = setTimeout(finish, ms);
    unrefTimer(timer);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
