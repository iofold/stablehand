/**
 * Sandbox Daemon — gRPC entrypoint for each sandbox container.
 *
 * Starts a ConnectRPC server that implements the HarnessService:
 *   - OpenSession (unary) — initialises a session (fresh or restore)
 *   - DeliverTurn (server-streaming) — runs a harness turn and streams SessionEvents
 *   - SuspendSession (unary) — suspends the current session and returns a checkpoint
 *   - KillSession (unary) — kills the current session
 *
 * Usage:
 *   node --loader ts-node/esm packages/ctxmill/src/sandbox/daemon.ts
 *
 * Environment:
 *   SANDBOX_PORT — Port to listen on (default: 50051)
 */

import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { create } from '@bufbuild/protobuf';
import {
  ConnectError,
  Code,
  type ConnectRouter,
  type HandlerContext,
} from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';

import {
  HarnessService,
  type OpenSessionRequest,
  OpenSessionResponseSchema,
  type DeliverTurnRequest,
  type RenewTurnDeliveryCapabilityRequest,
  type SuspendSessionRequest,
  type KillSessionRequest,
  KillSessionResponseSchema,
} from '@ctxmill/proto/sandbox/v1';

import {
  openSession,
  deliverTurn,
  renewTurnDeliveryCapability,
  suspendSession,
  killSession,
} from './runner.js';
import { validateCheckpointSize } from './checkpoint.js';
import { stringifyJsonWithBigInts } from './json-serialization.js';
import { createRuntimeInstanceAuthInterceptor } from './runtime-instance-auth.js';
import {
  resolvePtcTurnDeliveryContext,
  runWithTurnDeliveryContext,
} from './turn-delivery-context.js';

import type { ResolvedSecrets } from '../harness/types.js';
import type { ToolContext, ToolDefinition } from '../tool/types.js';

/* -------------------------------------------------------------------------- */
/*  State                                                                      */
/* -------------------------------------------------------------------------- */

let secrets: ResolvedSecrets = {};
let secretsLoaded = false;
let server: Server | null = null;
let toolApi: { stop: () => void } | null = null;
let _sessionTools: ToolDefinition[] = [];
let _sessionToolContext: ToolContext | null = null;
let _toolApiToken = randomUUID();

interface BunServer {
  stop(): void;
}

interface BunGlobal {
  serve(options: {
    hostname?: string;
    port: number;
    fetch(request: Request): Response | Promise<Response>;
  }): BunServer;
}

export function setSessionTools(tools: ToolDefinition[], context?: ToolContext | null) {
  _sessionTools = tools;
  _sessionToolContext = context ?? null;
  _toolApiToken = randomUUID();
}

export function getSessionTools(): ToolDefinition[] {
  return _sessionTools;
}

export function getToolApiToken(): string {
  return _toolApiToken;
}

function getBun(): BunGlobal | null {
  const bun = (globalThis as typeof globalThis & { Bun?: BunGlobal }).Bun;
  return bun ?? null;
}

function jsonResponse(body: unknown, status: number = 200): Response {
  return new Response(stringifyJsonWithBigInts(body), {
    status,
    headers: {
      'content-type': 'application/json',
    },
  });
}

function parseToolResult(result: string): unknown {
  try {
    return JSON.parse(result);
  } catch {
    // Tool results are not guaranteed to be JSON (e.g. markdown, plain text).
    // Return the raw string so the caller can pass it through rather than crashing.
    console.debug('[daemon] Tool result is not JSON, returning raw string');
    return result;
  }
}

function createMinimalToolContext(): ToolContext {
  return {
    agentId: 'sandbox-daemon',
    conversationId: 'sandbox-daemon',
    workspaceDir: '/workspace',
  };
}

function getSessionToolContext(): ToolContext {
  return _sessionToolContext ?? createMinimalToolContext();
}

type SafeParseResult =
  | { success: true; data: unknown }
  | { success: false; error?: { issues?: unknown; message?: string } };

interface SafeParseSchema {
  safeParse(input: unknown): SafeParseResult;
}

function hasSafeParse(input: unknown): input is SafeParseSchema {
  return typeof input === 'object'
    && input !== null
    && 'safeParse' in input
    && typeof (input as { safeParse?: unknown }).safeParse === 'function';
}

function validateToolInput(tool: ToolDefinition, input: unknown): { ok: true; data: unknown } | { ok: false; body: unknown } {
  if (!hasSafeParse(tool.input)) {
    return { ok: true, data: input };
  }

  const result = tool.input.safeParse(input);
  if (result.success) {
    return { ok: true, data: result.data };
  }

  return {
    ok: false,
    body: {
      error: 'Invalid tool input',
      details: result.error?.issues ?? result.error?.message ?? 'Schema validation failed',
    },
  };
}

function isAuthorized(request: Request, token: string): boolean {
  return request.headers.get('authorization') === `Bearer ${token}`;
}

function readBearerToken(request: Request): string | undefined {
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) return undefined;
  const token = authorization.slice('Bearer '.length);
  return token || undefined;
}

export function startToolApi(
  port: number = 8080,
  getTools: () => ToolDefinition[],
  opts?: { token?: string; makeContext?: () => ToolContext },
): { stop: () => void } {
  const bun = getBun();
  if (!bun) {
    console.error('[sandbox] Bun runtime unavailable — PTC tool API disabled');
    return {
      stop() {},
    };
  }

  const toolServer = bun.serve({
    hostname: '127.0.0.1',
    port,
    fetch: async (request: Request) => {
      const url = new URL(request.url);
      const token = opts?.token ?? getToolApiToken();
      const started = performance.now();
      const respond = (response: Response): Response => {
        const elapsedMs = Math.round(performance.now() - started);
        console.error(`[sandbox] tool API ${request.method} ${url.pathname} -> ${response.status} (${elapsedMs}ms)`);
        return response;
      };

      if (request.method === 'GET' && url.pathname === '/tools') {
        if (!isAuthorized(request, token)) {
          return respond(jsonResponse({ error: 'Unauthorized' }, 401));
        }
        return respond(jsonResponse(getTools().map((tool) => tool.name)));
      }

      if (request.method === 'POST' && url.pathname.startsWith('/tools/')) {
        const deliveryToken = readBearerToken(request);
        const deliveryContext = deliveryToken
          ? resolvePtcTurnDeliveryContext(deliveryToken)
          : undefined;
        if (!deliveryContext) {
          return respond(jsonResponse({ error: 'Unauthorized' }, 401));
        }

        const toolName = decodeURIComponent(url.pathname.slice('/tools/'.length));
        const tool = getTools().find((candidate) => candidate.name === toolName);

        if (!tool) {
          return respond(jsonResponse({ error: `Tool not found: ${toolName}` }, 404));
        }

        let parsedBody: unknown;
        try {
          parsedBody = await request.json();
        } catch (parseErr: unknown) {
          console.error(`[daemon] Failed to parse tool request body for ${toolName}:`, parseErr);
          return respond(jsonResponse({ error: 'Invalid request body: failed to parse JSON' }, 400));
        }

        try {
          const inputResult = validateToolInput(tool, parsedBody);
          if (!inputResult.ok) {
            return respond(jsonResponse(inputResult.body, 400));
          }

          const result = await runWithTurnDeliveryContext(
            deliveryContext,
            () => tool.handler(
              inputResult.data,
              opts?.makeContext?.() ?? getSessionToolContext(),
            ),
          );
          return respond(jsonResponse(parseToolResult(result)));
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[sandbox] tool ${toolName} failed:`, error);
          return respond(jsonResponse({ error: message }, 500));
        }
      }

      return respond(jsonResponse({ error: `Not found: ${url.pathname}` }, 404));
    },
  });

  console.error(`[sandbox] tool API listening on 127.0.0.1:${port}`);

  return {
    stop() {
      toolServer.stop();
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  RPC handlers                                                               */
/* -------------------------------------------------------------------------- */

/**
 * OpenSession — unary RPC.
 * Initialises a new session from a FreshBootstrap or RestoreBootstrap.
 */
export async function handleOpenSession(
  req: OpenSessionRequest,
  context: HandlerContext,
) {
  console.error(`[sandbox] OpenSession called`);

  try {
    const resolvedSecrets = ensureSecrets();
    const result = await openSession(req, resolvedSecrets, {
      signal: context.signal,
    });

    console.error(`[sandbox] session opened — sessionId=${result.sessionId}, status=${result.status}`);

    return create(OpenSessionResponseSchema, {
      sessionId: result.sessionId,
      status: result.status,
    });
  } catch (err: unknown) {
    if (err instanceof ConnectError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[sandbox] OpenSession failed:`, err);
    throw new ConnectError(`OpenSession failed: ${message}`, Code.Internal);
  }
}

/**
 * DeliverTurn — server-streaming RPC.
 * Feeds user messages into the active session and streams back SessionEvents.
 */
export async function* handleDeliverTurn(
  req: DeliverTurnRequest,
  context: HandlerContext,
) {
  yield* deliverTurn(req, { signal: context.signal });
}

/**
 * RenewTurnDeliveryCapability — extends only the exact active delivery
 * authority. The request is authenticated by the runtime-instance interceptor.
 */
export async function handleRenewTurnDeliveryCapability(
  req: RenewTurnDeliveryCapabilityRequest,
) {
  return await renewTurnDeliveryCapability(req);
}

/**
 * SuspendSession — unary RPC.
 * Cooperatively suspends the running session at the next safe point,
 * captures a checkpoint, validates its size, and returns it.
 */
async function handleSuspendSession(req: SuspendSessionRequest) {
  console.error(`[sandbox] SuspendSession called — sessionId=${req.sessionId}, reason=${req.reason}`);

  try {
    const response = await suspendSession(req.reason, req.sessionId);

    const json = stringifyJsonWithBigInts(response.sessionCheckpoint);
    const sizeResult = validateCheckpointSize(json);

    if (!sizeResult.ok) {
      console.error(`[sandbox] Checkpoint rejected: ${sizeResult.error}`);
      throw new ConnectError(
        sizeResult.error ?? 'Checkpoint exceeds size limit',
        Code.ResourceExhausted,
      );
    }

    if (sizeResult.warning) {
      console.error(`[sandbox] Checkpoint warning: ${sizeResult.warning}`);
    }

    console.error(
      `[sandbox] Checkpoint created: ${sizeResult.sizeBytes} bytes`,
    );

    return response;
  } catch (err: unknown) {
    if (err instanceof ConnectError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[sandbox] SuspendSession failed:`, err);
    throw new ConnectError(`SuspendSession failed: ${message}`, Code.Internal);
  }
}

/**
 * KillSession — unary RPC.
 * Aborts any in-progress DeliverTurn stream, then instructs the runner to
 * tear down the current session.
 */
async function handleKillSession(req: KillSessionRequest) {
  console.error(`[sandbox] KillSession called — sessionId=${req.sessionId}, reason=${req.reason}`);

  await killSession(req.sessionId);

  return create(KillSessionResponseSchema, {
    finalStatus: 'killed',
  });
}

/* -------------------------------------------------------------------------- */
/*  Route registration                                                         */
/* -------------------------------------------------------------------------- */

function registerRoutes(router: ConnectRouter) {
  router.service(HarnessService, {
    openSession: handleOpenSession,
    deliverTurn: handleDeliverTurn,
    renewTurnDeliveryCapability: handleRenewTurnDeliveryCapability,
    suspendSession: handleSuspendSession,
    killSession: handleKillSession,
  });
}

/* -------------------------------------------------------------------------- */
/*  Server lifecycle                                                           */
/* -------------------------------------------------------------------------- */

export function buildSecretsFromEnv(env: NodeJS.ProcessEnv = process.env): ResolvedSecrets {
  const next: ResolvedSecrets = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      next[key] = value;
    }
  }
  return next;
}

function ensureSecrets(): ResolvedSecrets {
  if (secretsLoaded) return secrets;
  secrets = buildSecretsFromEnv();
  secretsLoaded = true;
  const count = Object.keys(secrets).length;
  console.error(`[sandbox] resolved ${count} secret env var(s)`);
  return secrets;
}

/**
 * Start the gRPC server.
 *
 * @param port        - Port to listen on (default: 50051).
 * @returns The HTTP/1.1 server instance.
 */
export async function startDaemon(
  port: number = Number(process.env.SANDBOX_PORT) || 50051,
): Promise<Server> {
  const toolApiPort = parseInt(process.env.PTC_PORT ?? '8080', 10);
  const runtimeInstanceAuthInterceptor =
    createRuntimeInstanceAuthInterceptor();

  const connectHandler = connectNodeAdapter({
    routes: registerRoutes,
    interceptors: [runtimeInstanceAuthInterceptor],
  });

  server = createServer(connectHandler);

  // Bun's default idle timeout (~10s) kills the DeliverTurn stream while
  // the harness blocks on slow orchestrator tool calls (Exa, Firecrawl, etc).
  server.keepAliveTimeout = 10 * 60 * 1000;
  server.timeout = 0;

  await new Promise<void>((resolve) => {
    server!.listen(port, () => {
      console.error(`[sandbox] daemon listening on :${port}`);
      resolve();
    });
  });

  toolApi = startToolApi(toolApiPort, getSessionTools);

  return server;
}

/**
 * Gracefully shut down the daemon.
 */
export async function stopDaemon(): Promise<void> {
  await killSession().catch((err: unknown) => {
    console.error('[sandbox] killSession during stopDaemon failed:', err);
  });

  if (server) {
    await new Promise<void>((resolve, reject) => {
      server!.close((err?: Error) => {
        if (err) reject(err);
        else resolve();
      });
    });
    server = null;
  }

  if (toolApi) {
    toolApi.stop();
    toolApi = null;
  }

  secrets = {};
  secretsLoaded = false;
}

/* -------------------------------------------------------------------------- */
/*  Signal handling                                                            */
/* -------------------------------------------------------------------------- */

function setupSignalHandlers() {
  const shutdown = async (signal: string) => {
    console.error(`[sandbox] received ${signal} — shutting down`);
    await stopDaemon();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

/* -------------------------------------------------------------------------- */
/*  Main                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Entry point — only runs when this file is executed directly.
 * Importing this module (for testing) does not start the server.
 */
const isDirectExecution =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('daemon.ts') || process.argv[1].endsWith('daemon.js'));

if (isDirectExecution) {
  setupSignalHandlers();
  startDaemon().catch((err) => {
    console.error('[sandbox] fatal error during startup:', err);
    process.exit(1);
  });
}
