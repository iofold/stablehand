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

import { createServer, type Server } from 'node:http';
import { create } from '@bufbuild/protobuf';
import { ConnectError, Code, type ConnectRouter } from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';

// LangGraph and other libraries use BigInt internally (checkpoint sequences, etc.).
// JSON.stringify throws on BigInt by default. This global polyfill makes BigInt
// JSON-serializable everywhere — the standard approach used by Prisma, Discord.js, etc.
// See: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/BigInt#use_within_json
declare global { interface BigInt { toJSON(): number; } }
BigInt.prototype.toJSON = function () {
  return Number(this);
};

import {
  HarnessService,
  type OpenSessionRequest,
  OpenSessionResponseSchema,
  type DeliverTurnRequest,
  type SuspendSessionRequest,
  type KillSessionRequest,
  KillSessionResponseSchema,
} from '@ctxmill/proto/sandbox/v1';

import { openSession, deliverTurn, suspendSession, killSession } from './runner.js';
import { validateCheckpointSize } from './checkpoint.js';

import type { ResolvedSecrets } from '../harness/types.js';
import type { ToolContext, ToolDefinition } from '../tool/types.js';

/* -------------------------------------------------------------------------- */
/*  State                                                                      */
/* -------------------------------------------------------------------------- */

let secrets: ResolvedSecrets = {};
let server: Server | null = null;
let toolApi: { stop: () => void } | null = null;
let _sessionTools: ToolDefinition[] = [];

interface BunServer {
  stop(): void;
}

interface BunGlobal {
  serve(options: {
    port: number;
    fetch(request: Request): Response | Promise<Response>;
  }): BunServer;
}

export function setSessionTools(tools: ToolDefinition[]) {
  _sessionTools = tools;
}

export function getSessionTools(): ToolDefinition[] {
  return _sessionTools;
}

function getBun(): BunGlobal | null {
  const bun = (globalThis as typeof globalThis & { Bun?: BunGlobal }).Bun;
  return bun ?? null;
}

function jsonResponse(body: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(body), {
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
    console.error('[daemon] Failed to parse tool result as JSON, returning raw string.');
    return result;
  }
}

function createMinimalToolContext(): ToolContext {
  return {
    agentId: 'sandbox-daemon',
    conversationId: 'sandbox-daemon',
    workspaceDir: '/workspace',
    knowledge: {
      query: async () => ({ items: [] }),
    },
  };
}

export function startToolApi(
  port: number = 8080,
  getTools: () => ToolDefinition[],
): { stop: () => void } {
  const bun = getBun();
  if (!bun) {
    console.error('[sandbox] Bun runtime unavailable — PTC tool API disabled');
    return {
      stop() {},
    };
  }

  const toolServer = bun.serve({
    port,
    fetch: async (request: Request) => {
      const url = new URL(request.url);

      if (request.method === 'GET' && url.pathname === '/tools') {
        return jsonResponse(getTools().map((tool) => tool.name));
      }

      if (request.method === 'POST' && url.pathname.startsWith('/tools/')) {
        const toolName = decodeURIComponent(url.pathname.slice('/tools/'.length));
        const tool = getTools().find((candidate) => candidate.name === toolName);

        if (!tool) {
          return jsonResponse({ error: `Tool not found: ${toolName}` }, 404);
        }

        let parsedBody: unknown;
        try {
          parsedBody = await request.json();
        } catch (parseErr: unknown) {
          console.error(`[daemon] Failed to parse tool request body for ${toolName}:`, parseErr);
          return jsonResponse({ error: 'Invalid request body: failed to parse JSON' }, 400);
        }

        try {
          const result = await tool.handler(parsedBody, createMinimalToolContext());
          return jsonResponse(parseToolResult(result));
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          return jsonResponse({ error: message }, 500);
        }
      }

      return jsonResponse({ error: `Not found: ${url.pathname}` }, 404);
    },
  });

  console.error(`[sandbox] tool API listening on :${port}`);

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
async function handleOpenSession(req: OpenSessionRequest) {
  console.error(`[sandbox] OpenSession called`);

  try {
    const resolvedSecrets = ensureSecrets();
    const result = await openSession(req, resolvedSecrets, {});

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
async function* handleDeliverTurn(req: DeliverTurnRequest) {
  yield* deliverTurn(req);
}

/**
 * SuspendSession — unary RPC.
 * Cooperatively suspends the running session at the next safe point,
 * captures a checkpoint, validates its size, and returns it.
 */
async function handleSuspendSession(req: SuspendSessionRequest) {
  console.error(`[sandbox] SuspendSession called — sessionId=${req.sessionId}, reason=${req.reason}`);

  try {
    const response = await suspendSession(req.reason);

    const json = JSON.stringify(response.sessionCheckpoint);
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

  await killSession();

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
    suspendSession: handleSuspendSession,
    killSession: handleKillSession,
  });
}

/* -------------------------------------------------------------------------- */
/*  Server lifecycle                                                           */
/* -------------------------------------------------------------------------- */

function buildSecretsFromEnv(): ResolvedSecrets {
  const result: ResolvedSecrets = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function ensureSecrets(): ResolvedSecrets {
  if (Object.keys(secrets).length > 0) return secrets;
  secrets = buildSecretsFromEnv();
  const count = Object.keys(secrets).length;
  console.error(`[sandbox] resolved ${count} env var(s) as potential secrets`);
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

  const connectHandler = connectNodeAdapter({
    routes: registerRoutes,
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
