import { z } from 'zod';

import { CtxmillApiError, CtxmillContractError, CtxmillTimeoutError } from './errors.js';

export type CtxmillHeadersProvider = HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
export type CtxmillTokenProvider = string | (() => string | Promise<string>);

export interface CtxmillRetryOptions {
  /** Total attempts, including the initial safe-read request. */
  maxAttempts?: number;
  baseDelayMs?: number;
}

export interface CtxmillClientOptions {
  apiBase?: string;
  token?: CtxmillTokenProvider;
  headers?: CtxmillHeadersProvider;
  credentials?: RequestCredentials;
  fetch?: typeof fetch;
  timeoutMs?: number;
  retry?: CtxmillRetryOptions;
}

export interface CtxmillRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  idempotencyKey?: string;
}

interface TransportRequest<T> extends CtxmillRequestOptions {
  method: string;
  path: string;
  responseSchema: z.ZodType<T>;
  json?: unknown;
  requestSchema?: z.ZodType;
  rawBody?: BodyInit;
  headers?: HeadersInit;
}

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const REDACTED = '[REDACTED]';
const SENSITIVE_KEY = /(?:authorization|cookie|token|secret|api[-_]?key|password|credential|value)/i;

function normalizeBaseUrl(base: string): string {
  if (base.length > 1 && base.endsWith('/')) {
    return base.slice(0, -1);
  }
  return base;
}

function joinUrl(base: string, path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${base}${normalizedPath}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      SENSITIVE_KEY.test(key) ? REDACTED : redact(entry),
    ]),
  );
}

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function errorFields(body: unknown): { code?: string; detail?: string } {
  if (!isRecord(body)) return {};
  const code = typeof body.code === 'string' ? body.code : undefined;
  const detailCandidate = body.detail ?? body.error ?? body.message;
  const detail = typeof detailCandidate === 'string' ? detailCandidate : undefined;
  return { code, detail };
}

function abortContext(signal: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  clearTimeout: () => void;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) {
    controller.abort(signal.reason);
  } else {
    signal?.addEventListener('abort', onAbort, { once: true });
  }

  const timeout = setTimeout(() => {
    controller.abort(new CtxmillTimeoutError(timeoutMs));
  }, timeoutMs);

  return {
    signal: controller.signal,
    clearTimeout: () => clearTimeout(timeout),
    cleanup: () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface CtxmillOpenedStream {
  body: ReadableStream<Uint8Array>;
  close: () => Promise<void>;
}

export class CtxmillTransport {
  private readonly apiBase: string;
  private readonly tokenProvider?: CtxmillTokenProvider;
  private readonly headerProvider?: CtxmillHeadersProvider;
  private readonly credentials?: RequestCredentials;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxReadAttempts: number;
  private readonly retryBaseDelayMs: number;

  constructor(options: CtxmillClientOptions = {}) {
    this.apiBase = normalizeBaseUrl(options.apiBase ?? '/api');
    this.tokenProvider = options.token;
    this.headerProvider = options.headers;
    this.credentials = options.credentials;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxReadAttempts = Math.max(1, options.retry?.maxAttempts ?? 3);
    this.retryBaseDelayMs = Math.max(0, options.retry?.baseDelayMs ?? 100);
  }

  private async headers(extra?: HeadersInit): Promise<Headers> {
    const provided = typeof this.headerProvider === 'function'
      ? await this.headerProvider()
      : this.headerProvider;
    const headers = new Headers(provided);
    if (this.tokenProvider) {
      const token = typeof this.tokenProvider === 'function'
        ? await this.tokenProvider()
        : this.tokenProvider;
      headers.set('Authorization', `Bearer ${token}`);
    }
    new Headers(extra).forEach((value, key) => headers.set(key, value));
    return headers;
  }

  private validate<T>(
    schema: z.ZodType<T>,
    value: unknown,
    input: { direction: 'request' | 'response' | 'stream'; method: string; path: string },
  ): T {
    const result = schema.safeParse(value);
    if (!result.success) {
      throw new CtxmillContractError({
        ...input,
        issues: result.error.issues,
      });
    }
    return result.data;
  }

  async request<T>(input: TransportRequest<T>): Promise<T> {
    const method = input.method.toUpperCase();
    const isSafeRead = method === 'GET' || method === 'HEAD';
    const maxAttempts = isSafeRead ? this.maxReadAttempts : 1;
    let json = input.json;
    if (input.requestSchema) {
      json = this.validate(input.requestSchema, input.json, {
        direction: 'request',
        method,
        path: input.path,
      });
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const headers = await this.headers(input.headers);
      let body = input.rawBody;
      if (json !== undefined) {
        headers.set('Content-Type', 'application/json');
        body = JSON.stringify(json);
      }
      if (input.idempotencyKey) {
        headers.set('Idempotency-Key', input.idempotencyKey);
      }

      const abort = abortContext(input.signal, input.timeoutMs ?? this.timeoutMs);
      let response: Response;
      try {
        response = await this.fetchImpl(joinUrl(this.apiBase, input.path), {
          method,
          headers,
          credentials: this.credentials,
          signal: abort.signal,
          body,
        });
      } catch (error) {
        abort.cleanup();
        if (abort.signal.aborted) {
          throw abort.signal.reason;
        }
        if (isSafeRead && attempt < maxAttempts) {
          await delay(this.retryBaseDelayMs * 2 ** (attempt - 1), input.signal);
          continue;
        }
        throw error;
      }
      abort.cleanup();

      if (isSafeRead && RETRYABLE_STATUSES.has(response.status) && attempt < maxAttempts) {
        await response.body?.cancel();
        await delay(this.retryBaseDelayMs * 2 ** (attempt - 1), input.signal);
        continue;
      }

      const responseBody = response.status === 204 ? undefined : await parseBody(response);
      if (!response.ok) {
        const fields = errorFields(responseBody);
        throw new CtxmillApiError({
          status: response.status,
          ...fields,
          body: redact(responseBody),
          method,
          path: input.path,
        });
      }

      return this.validate(input.responseSchema, responseBody, {
        direction: 'response',
        method,
        path: input.path,
      });
    }

    throw new Error('CTXMill request exhausted without a response');
  }

  async openStream(input: {
    method: 'GET' | 'POST';
    path: string;
    json?: unknown;
    requestSchema?: z.ZodType;
    headers?: HeadersInit;
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<CtxmillOpenedStream> {
    const method = input.method;
    const json = input.requestSchema
      ? this.validate(input.requestSchema, input.json, {
        direction: 'request',
        method,
        path: input.path,
      })
      : input.json;
    let body: BodyInit | undefined;
    if (json !== undefined) {
      body = JSON.stringify(json);
    }

    const isSafeRead = method === 'GET';
    const maxAttempts = isSafeRead ? this.maxReadAttempts : 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const headers = await this.headers(input.headers);
      if (json !== undefined) {
        headers.set('Content-Type', 'application/json');
      }

      const abort = abortContext(input.signal, input.timeoutMs ?? this.timeoutMs);
      let response: Response;
      try {
        response = await this.fetchImpl(joinUrl(this.apiBase, input.path), {
          method,
          headers,
          credentials: this.credentials,
          signal: abort.signal,
          body,
        });
      } catch (error) {
        const aborted = abort.signal.aborted;
        const reason = abort.signal.reason;
        abort.cleanup();
        if (aborted) {
          throw reason;
        }
        if (isSafeRead && attempt < maxAttempts) {
          await delay(this.retryBaseDelayMs * 2 ** (attempt - 1), input.signal);
          continue;
        }
        throw error;
      }

      if (isSafeRead && RETRYABLE_STATUSES.has(response.status) && attempt < maxAttempts) {
        abort.cleanup();
        await response.body?.cancel();
        await delay(this.retryBaseDelayMs * 2 ** (attempt - 1), input.signal);
        continue;
      }

      if (!response.ok) {
        let responseBody: unknown;
        try {
          responseBody = await parseBody(response);
        } finally {
          abort.cleanup();
        }
        const fields = errorFields(responseBody);
        throw new CtxmillApiError({
          status: response.status,
          ...fields,
          body: redact(responseBody),
          method,
          path: input.path,
        });
      }
      if (!response.body) {
        abort.cleanup();
        throw new CtxmillContractError({
          direction: 'response',
          method,
          path: input.path,
          issues: [{
            code: 'custom',
            path: [],
            message: 'Expected a streaming response body',
            input: undefined,
          }],
        });
      }
      abort.clearTimeout();
      const responseBody = response.body;
      return {
        body: responseBody,
        close: async () => {
          try {
            await responseBody.cancel();
          } finally {
            abort.cleanup();
          }
        },
      };
    }

    throw new Error('CTXMill stream request exhausted without a response');
  }
}
