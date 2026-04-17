/**
 * Sandbox-side tool proxy — proxies orchestrator-location tool calls via gRPC.
 *
 * When the LLM calls a tool that has `location: 'orchestrator'`, the sandbox
 * cannot execute it directly (it needs EventBus, DB access, etc.). Instead,
 * the proxy serializes the call and sends it to the orchestrator via the
 * `OrchestratorService.RequestTool` RPC, then returns the result.
 *
 * Retry policy: 3 retries with exponential backoff (100ms, 500ms, 2000ms).
 * Timeout: 5 minutes per call (configurable via `TOOL_PROXY_TIMEOUT_MS`).
 */

import { create } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import {
  type RegisterArtifactRequest,
  type RegisterArtifactResponse,
  type ResolveArtifactRequest,
  type ResolveArtifactResponse,
  RequestToolRequestSchema,
  type RequestToolResponse,
  ToolLocation,
  type ToolMetadata as ProtoToolMetadata,
} from '@ctxmill/proto/sandbox/v1';

import type { ToolDefinition } from '../tool/types.js';
import { jsonSchemaToZod } from '../tool/schema-convert.js';
import { retryWithBackoff } from '../util/retry.js';
import { stringifyJsonWithBigInts } from './json-serialization.js';

/* -------------------------------------------------------------------------- */
/*  Types                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Minimal interface for the OrchestratorService client.
 *
 * We define a narrow interface rather than importing the full generated client
 * to keep the module testable with simple mocks.
 */
export interface OrchestratorServiceClient {
  requestTool: (
    req: {
      sessionId: string;
      agentId: string;
      toolName: string;
      argsJson: string;
      requestId: string;
    },
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ) => Promise<RequestToolResponse>;
  registerArtifact: (
    req: RegisterArtifactRequest,
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ) => Promise<RegisterArtifactResponse>;
  resolveArtifact: (
    req: ResolveArtifactRequest,
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ) => Promise<ResolveArtifactResponse>;
}

/**
 * Options for tool proxy creation.
 */
export interface ToolProxyOptions {
  /** Timeout for individual tool calls in ms (default: 300000 = 5 min). */
  timeoutMs?: number;
  /** Retry delays in ms for exponential backoff (default: [100, 500, 2000]). */
  retryDelays?: number[];
}

/* -------------------------------------------------------------------------- */
/*  Constants                                                                  */
/* -------------------------------------------------------------------------- */

const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes
const DEFAULT_RETRY_DELAYS = [100, 500, 2000]; // 3 retries with exponential backoff

/* -------------------------------------------------------------------------- */
/*  Single tool proxy                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Creates a tool handler function that proxies execution to the orchestrator
 * via the OrchestratorService.RequestTool RPC.
 *
 * This is used inside the sandbox for tools with location='orchestrator'.
 * When the LLM calls the tool, the proxy:
 * 1. Serializes the tool input to JSON
 * 2. Sends RequestTool RPC to the orchestrator
 * 3. Waits for the response
 * 4. Returns the result (or throws on error)
 */
export function createToolProxy(
  toolName: string,
  orchestratorClient: OrchestratorServiceClient,
  sessionId: string | { current: string },
  agentId: string,
  opts?: ToolProxyOptions,
): (input: unknown) => Promise<string> {
  const timeoutMs = opts?.timeoutMs
    ?? (Number(process.env.TOOL_PROXY_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
  const retryDelays = opts?.retryDelays ?? DEFAULT_RETRY_DELAYS;

  return async (input: unknown): Promise<string> => {
    const resolvedSessionId = typeof sessionId === 'string' ? sessionId : sessionId.current;
    const requestId = generateRequestId();
    const argsJson = typeof input === 'string' ? input : stringifyJsonWithBigInts(input ?? {});

    const req = create(RequestToolRequestSchema, {
      sessionId: resolvedSessionId,
      agentId,
      toolName,
      argsJson,
      requestId,
    });

    try {
      return await retryWithBackoff(
        async () => {
          const response = await callWithTimeout(
            (signal) => orchestratorClient.requestTool(req, { timeoutMs, signal }),
            timeoutMs,
          );

          if (response.error) {
            throw new ConnectError(response.error, Code.FailedPrecondition);
          }

          return response.result;
        },
        {
          delays: retryDelays,
          shouldRetry: (err) =>
            !(err instanceof ConnectError && isNonRetryableCode(err.code)),
          onRetry: (err, attempt, delayMs) => {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(
              `[tool-proxy] "${toolName}" attempt ${attempt + 1} failed, retrying in ${delayMs}ms: ${msg}`,
            );
          },
        },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[tool-proxy] "${toolName}" all retries exhausted: ${msg}`);
      throw new Error(
        `Tool proxy for "${toolName}" failed after ${retryDelays.length + 1} attempts: ${msg}`,
        { cause: err },
      );
    }
  };
}

/* -------------------------------------------------------------------------- */
/*  Batch proxy creation                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Creates tool definitions for all orchestrator-side tools,
 * with proxy handlers wired to the gRPC client.
 *
 * Non-orchestrator tools are filtered out — this function only creates
 * proxied definitions for tools with `location === ORCHESTRATOR`.
 */
export function createOrchestratorToolProxies(
  tools: ProtoToolMetadata[],
  orchestratorClient: OrchestratorServiceClient,
  sessionId: string,
  agentId: string,
  opts?: ToolProxyOptions,
): ToolDefinition[] {
  return tools
    .filter((t) => t.location === ToolLocation.ORCHESTRATOR)
    .map((t) => {
      const inputJsonSchema = parseJsonOrThrow(t.inputSchemaJson, `tool ${t.name} input schema`);
      const zodSchema = jsonSchemaToZod(inputJsonSchema);

      const handler = createToolProxy(
        t.name,
        orchestratorClient,
        sessionId,
        agentId,
        opts,
      );

      return {
        name: t.name,
        description: t.description,
        input: zodSchema,
        handler,
      };
    });
}

/* -------------------------------------------------------------------------- */
/*  Internal helpers                                                           */
/* -------------------------------------------------------------------------- */

/**
 * ConnectRPC error codes that should NOT be retried (application-level errors).
 * Uses numeric Code enum values from @connectrpc/connect.
 */
const NON_RETRYABLE_CODES: ReadonlySet<number> = new Set([
  3,
  5,
  6,
  7,
  9,
  12,
  16,
]);

function isNonRetryableCode(code: number): boolean {
  return NON_RETRYABLE_CODES.has(code);
}

/**
 * Execute an async function with a timeout.
 */
async function callWithTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const result = await fn(controller.signal);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

let requestCounter = 0;

function generateRequestId(): string {
  requestCounter++;
  return `rpc-${Date.now()}-${requestCounter}`;
}

function parseJsonOrThrow(s: string, context: string): Record<string, unknown> {
  try {
    return JSON.parse(s);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse ${context}: ${message}`, { cause: err });
  }
}
