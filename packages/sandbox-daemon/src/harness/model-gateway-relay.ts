import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';

interface Logger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

/** A model call the gateway refused because the session key's budget ran out. */
export interface GatewayBudgetRefusal {
  /** Opaque turn correlation the call carried, or null when it carried none. */
  correlationId: string | null;
  /** Spend the gateway had counted against the key, in USD. */
  spentUsd: number | null;
  /** The key's budget at refusal time, in USD. */
  capUsd: number | null;
  observedAt: number;
}

/**
 * Body the relay returns in place of the gateway's budget refusal. Plain
 * words and no digits: harness SDKs classify retryability by status and by
 * message text, and PI's classifier treats any "429"/"500" substring as
 * transient while "out of budget" is explicitly terminal.
 */
export const GATEWAY_BUDGET_REFUSAL_MESSAGE =
  'Stablehand spend cap reached: this run is out of budget, so the model gateway refused the call. Do not retry.';

const CORRELATION_HEADER = 'x-litellm-trace-id';
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const MAX_TRACKED_REFUSALS = 64;
const HOP_BY_HOP_HEADERS: ReadonlySet<string> = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
]);
const NO_CORRELATION_KEY = '';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseUsd(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Recognize LiteLLM's virtual-key budget refusal. LiteLLM 1.93 answers 429
 * with `{"error":{"type":"budget_exceeded","message":"Budget has been
 * exceeded! Key=... Current cost: X, Max budget: Y",...}}` on every inference
 * route (verified on dev1 2026-10-22 for /v1/chat/completions,
 * /v1/messages and /v1/responses, streaming or not); older releases used 400.
 */
export function parseLiteLLMBudgetRefusal(
  status: number,
  body: unknown,
): { spentUsd: number | null; capUsd: number | null } | null {
  if (status !== 429 && status !== 400) return null;
  if (!isRecord(body) || !isRecord(body.error)) return null;
  const error = body.error;
  const message = typeof error.message === 'string' ? error.message : '';
  const typed = error.type === 'budget_exceeded';
  if (!typed && !message.startsWith('Budget has been exceeded')) return null;
  const amounts = /Current cost:\s*([0-9.eE+-]+),\s*Max budget:\s*([0-9.eE+-]+)/.exec(message);
  return {
    spentUsd: parseUsd(amounts?.[1]),
    capUsd: parseUsd(amounts?.[2]),
  };
}

function forwardHeaders(
  headers: IncomingHttpHeaders,
  upstreamHost: string,
): OutgoingHttpHeaders {
  const forwarded: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    // Ask for identity encoding so the relay can always read an error body;
    // the gateway sits on the internal network, compression buys nothing.
    if (value === undefined || HOP_BY_HOP_HEADERS.has(lower) || lower === 'accept-encoding') continue;
    forwarded[name] = value;
  }
  forwarded.host = upstreamHost;
  return forwarded;
}

function responseHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const forwarded: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    forwarded[name] = value;
  }
  return forwarded;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * Loopback relay between in-sandbox model clients and the model gateway.
 *
 * Every byte passes through unchanged except one response: the gateway's
 * budget refusal. LiteLLM sends it as a headerless 429, which the Anthropic
 * and OpenAI SDKs and the Claude Code CLI all treat as a transient rate limit
 * and retry with backoff, so a run that ran out of budget would stall for
 * minutes instead of stopping. The relay rewrites that one response to a
 * terminal 400 with `x-should-retry: false` and records the refusal by turn
 * correlation, so the harness adapter can end the turn with a typed
 * `model_gateway_budget_exceeded` error carrying the gateway's numbers.
 */
export class ModelGatewayRelay {
  private server: Server | undefined;
  private listeningUrl: string | undefined;
  private readonly upstream: URL;
  private readonly refusals = new Map<string, GatewayBudgetRefusal>();
  private readonly now: () => number;

  constructor(
    private readonly options: {
      upstreamUrl: string;
      logger?: Logger;
      now?: () => number;
    },
  ) {
    this.upstream = new URL(options.upstreamUrl);
    if (this.upstream.protocol !== 'http:' && this.upstream.protocol !== 'https:') {
      throw new Error('Model gateway relay upstream must be an HTTP(S) URL');
    }
    this.now = options.now ?? Date.now;
  }

  /** Loopback base URL clients should use instead of the gateway root, once started. */
  get url(): string | undefined {
    return this.listeningUrl;
  }

  async start(): Promise<string> {
    if (this.listeningUrl) return this.listeningUrl;
    const server = createServer((req, res) => this.handle(req, res));
    // Model streams can legitimately run for many minutes.
    server.timeout = 0;
    server.keepAliveTimeout = 10 * 60 * 1000;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address() as AddressInfo;
    this.server = server;
    this.listeningUrl = `http://127.0.0.1:${address.port}`;
    return this.listeningUrl;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.listeningUrl = undefined;
    if (!server) return;
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  /** Remove and return the budget refusal recorded for this turn correlation. */
  takeBudgetRefusal(correlationId: string): GatewayBudgetRefusal | undefined {
    const refusal = this.refusals.get(correlationId);
    if (refusal) {
      this.refusals.delete(correlationId);
      return refusal;
    }
    // A client that sent no correlation header can only be matched loosely.
    const uncorrelated = this.refusals.get(NO_CORRELATION_KEY);
    if (uncorrelated) this.refusals.delete(NO_CORRELATION_KEY);
    return uncorrelated;
  }

  /** True when a refusal is recorded for this correlation, without consuming it. */
  hasBudgetRefusal(correlationId: string): boolean {
    return this.refusals.has(correlationId) || this.refusals.has(NO_CORRELATION_KEY);
  }

  private recordRefusal(refusal: GatewayBudgetRefusal): void {
    const key = refusal.correlationId ?? NO_CORRELATION_KEY;
    this.refusals.delete(key);
    this.refusals.set(key, refusal);
    while (this.refusals.size > MAX_TRACKED_REFUSALS) {
      const oldest = this.refusals.keys().next().value;
      if (oldest === undefined) break;
      this.refusals.delete(oldest);
    }
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const transport = this.upstream.protocol === 'https:' ? httpsRequest : httpRequest;
    const correlationId = headerValue(req.headers[CORRELATION_HEADER]) ?? null;
    const upstreamReq = transport({
      protocol: this.upstream.protocol,
      hostname: this.upstream.hostname,
      port: this.upstream.port || undefined,
      method: req.method,
      path: req.url ?? '/',
      headers: forwardHeaders(req.headers, this.upstream.host),
    }, (upstreamRes) => {
      const status = upstreamRes.statusCode ?? 502;
      if (status === 429 || status === 400) {
        this.relayErrorResponse(upstreamRes, res, status, correlationId);
        return;
      }
      res.writeHead(status, responseHeaders(upstreamRes.headers));
      upstreamRes.pipe(res);
      upstreamRes.on('error', (err) => {
        this.options.logger?.warn('[model-gateway-relay] upstream response stream failed:', err);
        res.destroy(err);
      });
    });

    upstreamReq.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          error: {
            type: 'model_gateway_unavailable',
            message: `Model gateway is unreachable from the sandbox relay: ${err.message}`,
          },
        }));
        return;
      }
      res.destroy(err);
    });
    res.on('close', () => {
      if (!res.writableFinished) upstreamReq.destroy();
    });
    req.on('error', (err) => {
      upstreamReq.destroy(err);
    });
    req.pipe(upstreamReq);
  }

  private relayErrorResponse(
    upstreamRes: IncomingMessage,
    res: ServerResponse,
    status: number,
    correlationId: string | null,
  ): void {
    // Error bodies are small; buffer the whole body so a non-budget error is
    // relayed byte for byte, and only parse one of plausible size.
    const chunks: Buffer[] = [];
    let size = 0;
    upstreamRes.on('data', (chunk: Buffer) => {
      size += chunk.length;
      chunks.push(chunk);
    });
    upstreamRes.on('error', (err) => {
      this.options.logger?.warn('[model-gateway-relay] upstream error body failed:', err);
      res.destroy(err);
    });
    upstreamRes.on('end', () => {
      const raw = Buffer.concat(chunks);
      let parsed: unknown;
      if (size <= MAX_ERROR_BODY_BYTES) {
        try {
          parsed = JSON.parse(raw.toString('utf8'));
        } catch {
          parsed = undefined;
        }
      }
      const refusal = parsed === undefined ? null : parseLiteLLMBudgetRefusal(status, parsed);
      if (!refusal) {
        res.writeHead(status, responseHeaders(upstreamRes.headers));
        res.end(raw);
        return;
      }
      this.recordRefusal({
        correlationId,
        spentUsd: refusal.spentUsd,
        capUsd: refusal.capUsd,
        observedAt: this.now(),
      });
      this.options.logger?.warn(
        `[model-gateway-relay] gateway refused a call for budget (spent=${refusal.spentUsd ?? 'unknown'} cap=${refusal.capUsd ?? 'unknown'}); returning a terminal error`,
      );
      res.writeHead(400, {
        'content-type': 'application/json',
        'x-should-retry': 'false',
      });
      res.end(JSON.stringify({
        type: 'error',
        error: {
          type: 'budget_exceeded',
          code: 'budget_exceeded',
          param: null,
          message: GATEWAY_BUDGET_REFUSAL_MESSAGE,
        },
      }));
    });
  }
}

let activeRelay: ModelGatewayRelay | undefined;

/** The relay harness clients in this process route gateway traffic through, if any. */
export function getModelGatewayRelay(): ModelGatewayRelay | undefined {
  return activeRelay;
}

export function registerModelGatewayRelay(relay: ModelGatewayRelay | undefined): void {
  activeRelay = relay;
}

/**
 * Start the relay when this sandbox runs in gateway mode. Failure to start is
 * not fatal: clients then talk to the gateway directly, as before, and a
 * budget refusal surfaces through message classification only.
 */
export async function startModelGatewayRelayFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
  logger: Logger = console,
): Promise<ModelGatewayRelay | undefined> {
  if (env.STABLEHAND_MODEL_GATEWAY_ENABLED?.trim() !== 'true') return undefined;
  const upstreamUrl = env.STABLEHAND_MODEL_GATEWAY_URL?.trim();
  if (!upstreamUrl) return undefined;
  try {
    const relay = new ModelGatewayRelay({ upstreamUrl, logger });
    const url = await relay.start();
    registerModelGatewayRelay(relay);
    logger.info(`[model-gateway-relay] relaying model gateway traffic through ${url}`);
    return relay;
  } catch (err) {
    logger.error('[model-gateway-relay] failed to start; harness clients will call the gateway directly:', err);
    return undefined;
  }
}

export async function stopModelGatewayRelay(): Promise<void> {
  const relay = activeRelay;
  activeRelay = undefined;
  await relay?.stop();
}
