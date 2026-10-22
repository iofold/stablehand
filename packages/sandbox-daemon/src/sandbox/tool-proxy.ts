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
import { randomUUID } from 'node:crypto';
import {
  type RegisterArtifactRequest,
  type RegisterArtifactResponse,
  type ResolveArtifactRequest,
  type ResolveArtifactResponse,
  type RequestToolRequest,
  RequestToolRequestSchema,
  type RequestToolResponse,
} from '@stablehand/proto/sandbox/v1';

import { retryWithBackoff } from '../util/retry.js';
import { callWithinOrchestratorWindow } from './callback-window.js';
import { stringifyJsonWithBigInts } from './json-serialization.js';
import {
  requireTurnDeliveryContext,
  snapshotTurnDeliveryCapability,
  type TurnDeliveryContext,
} from './turn-delivery-context.js';

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
    req: RequestToolRequest,
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

/** Canonical routing identity attached to every sandbox callback. */
export interface ToolCallbackRoute {
  sandboxSessionId: string;
  agentId: string;
  resolveDeliveryContext?: () => TurnDeliveryContext;
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
  route: ToolCallbackRoute,
  opts?: ToolProxyOptions,
): (input: unknown) => Promise<string> {
  const timeoutMs = opts?.timeoutMs
    ?? (Number(process.env.TOOL_PROXY_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
  const retryDelays = opts?.retryDelays ?? DEFAULT_RETRY_DELAYS;

  return async (input: unknown): Promise<string> => {
    const deliveryContext = route.resolveDeliveryContext?.()
      ?? requireTurnDeliveryContext({
        sandboxSessionId: route.sandboxSessionId,
        agentId: route.agentId,
      });
    const requestId = generateRequestId();
    const argsJson = typeof input === 'string' ? input : stringifyJsonWithBigInts(input ?? {});

    if ((deliveryContext.orphanGraceMs ?? 0) > 0) {
      // ADR 024: keep the same request id across an orchestrator restart so
      // its dedup row returns a result that was produced but never delivered.
      const response = await callWithinOrchestratorWindow(
        deliveryContext,
        `tool "${toolName}"`,
        (deliveryCapability, signal) => orchestratorClient.requestTool(
          create(RequestToolRequestSchema, {
            turnId: deliveryContext.identity.turnId,
            sandboxSessionId: deliveryContext.identity.sandboxSessionId,
            agentId: deliveryContext.identity.agentId,
            toolName,
            argsJson,
            requestId,
            deliveryCapability,
          }),
          { timeoutMs, signal },
        ),
        { attemptTimeoutMs: timeoutMs },
      );
      if (response.error) {
        throw new Error(response.error);
      }
      return response.result;
    }

    try {
      return await retryWithBackoff(
        async () => {
          const req = create(RequestToolRequestSchema, {
            turnId: deliveryContext.identity.turnId,
            sandboxSessionId: deliveryContext.identity.sandboxSessionId,
            agentId: deliveryContext.identity.agentId,
            toolName,
            argsJson,
            requestId,
            deliveryCapability: snapshotTurnDeliveryCapability(deliveryContext),
          });
          const response = await callWithTimeout(
            (signal) => orchestratorClient.requestTool(req, { timeoutMs, signal }),
            timeoutMs,
            deliveryContext.abortController.signal,
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
  parentSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const signal = parentSignal
      ? AbortSignal.any([controller.signal, parentSignal])
      : controller.signal;
    const result = await fn(signal);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

let requestCounter = 0;

function generateRequestId(): string {
  requestCounter++;
  return `rpc-${Date.now()}-${requestCounter}-${randomUUID()}`;
}
