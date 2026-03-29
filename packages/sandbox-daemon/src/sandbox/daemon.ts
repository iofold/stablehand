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
 *   SECRETS_PATH — Path to secrets JSON (default: /run/secrets/config.json)
 */

import { createServer, type Http2Server } from 'node:http2';
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

import { readSecrets, DEFAULT_SECRETS_PATH } from './secret-reader.js';
import { openSession, deliverTurn, suspendSession, killSession } from './runner.js';
import { validateCheckpointSize } from './checkpoint.js';

import type { ResolvedSecrets } from '../harness/types.js';

/* -------------------------------------------------------------------------- */
/*  State                                                                      */
/* -------------------------------------------------------------------------- */

let secrets: ResolvedSecrets = {};
let server: Http2Server | null = null;
let activeAbort: AbortController | null = null;
let activeSessionMeta: { sessionId: string } | null = null;

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
    const resolvedSecrets = await ensureSecrets();
    const result = await openSession(req, resolvedSecrets, {});

    activeSessionMeta = { sessionId: result.sessionId };
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
  activeAbort = new AbortController();
  try {
    yield* deliverTurn(req, { signal: activeAbort.signal });
  } finally {
    activeAbort = null;
  }
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

  if (activeAbort) {
    activeAbort.abort();
    activeAbort = null;
  }

  await killSession();
  activeSessionMeta = null;

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

function resolveSecretsFromEnv(): ResolvedSecrets {
  const knownKeys = [
    'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL',
    'S3_ENDPOINT', 'S3_ACCESS_KEY', 'S3_SECRET_KEY', 'S3_BUCKET', 'S3_REGION',
  ];
  const result: ResolvedSecrets = {};
  for (const key of knownKeys) {
    if (process.env[key]) {
      result[key] = process.env[key]!;
    }
  }
  return result;
}

async function ensureSecrets(): Promise<ResolvedSecrets> {
  if (Object.keys(secrets).length > 0) return secrets;
  secrets = resolveSecretsFromEnv();
  if (Object.keys(secrets).length > 0) {
    console.error(`[sandbox] loaded ${Object.keys(secrets).length} secret(s) from env`);
    return secrets;
  }
  secrets = await readSecrets(DEFAULT_SECRETS_PATH);
  if (Object.keys(secrets).length > 0) {
    console.error(`[sandbox] loaded ${Object.keys(secrets).length} secret(s) from file`);
  } else {
    console.error(`[sandbox] no secrets found in env or file — running without API keys`);
  }
  return secrets;
}

/**
 * Start the gRPC server.
 *
 * @param port        - Port to listen on (default: 50051).
 * @param secretsPath - Path to the secrets JSON file.
 * @returns The HTTP/2 server instance.
 */
export async function startDaemon(
  port: number = Number(process.env.SANDBOX_PORT) || 50051,
  secretsPath: string = process.env.SECRETS_PATH || DEFAULT_SECRETS_PATH,
): Promise<Http2Server> {
  void secretsPath;

  const connectHandler = connectNodeAdapter({
    routes: registerRoutes,
  });

  server = createServer(connectHandler);

  await new Promise<void>((resolve) => {
    server!.listen(port, () => {
      console.error(`[sandbox] daemon listening on :${port}`);
      resolve();
    });
  });

  return server;
}

/**
 * Gracefully shut down the daemon.
 */
export async function stopDaemon(): Promise<void> {
  if (activeAbort) {
    activeAbort.abort();
    activeAbort = null;
  }

  // Ask the runner to clean up any active session (best-effort)
  await killSession().catch((err: unknown) => {
    console.error('[sandbox] killSession during stopDaemon failed:', err);
  });
  activeSessionMeta = null;

  if (server) {
    await new Promise<void>((resolve, reject) => {
      server!.close((err?: Error) => {
        if (err) reject(err);
        else resolve();
      });
    });
    server = null;
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
