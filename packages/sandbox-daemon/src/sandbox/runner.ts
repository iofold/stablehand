/**
 * Sandbox session-lifecycle manager — one persistent session per daemon process,
 * multi-turn delivery via the HarnessSession interface.
 *
 * This module is the core execution logic inside the sandbox container.
 * It is invoked by the daemon's HarnessService RPC handlers.
 *
 * Exports:
 *   openSession     — bootstrap a fresh or restored harness session
 *   deliverTurn     — stream events for a single conversation turn
 *   suspendSession  — export state and build a checkpoint for the orchestrator
 *   killSession     — cleanly close the active session
 */

import { mkdir } from 'node:fs/promises';
import { create } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import { createClient } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-node';
import type {
  OpenSessionRequest,
  OpenSessionResponse,
  DeliverTurnRequest,
  SuspendSessionResponse,
  KillSessionResponse,
  SessionEvent,
} from '@ctxmill/proto/sandbox/v1';
import {
  OrchestratorService,
  OpenSessionResponseSchema,
  SessionEventSchema,
  TurnCompletedSchema,
  TurnFailedSchema,
  SuspendSessionResponseSchema,
  KillSessionResponseSchema,
} from '@ctxmill/proto/sandbox/v1';

import { ArtifactStore } from '../artifact/artifact-store.js';
import type {
  AgentHarness,
  HarnessSession,
  ResolvedSecrets,
  ApprovalCallback,
  AgentEvent,
} from '../harness/types.js';
import type { ToolContext } from '../tool/types.js';
import type { ExecutionPhase } from './execution-phase.js';
import { ExecutionPhaseTracker } from './execution-phase.js';
import { SessionStateCollector } from './checkpoint.js';
import {
  protoFreshBootstrapToSessionConfig,
  protoRestoreBootstrapToRestorePoint,
  protoDeliverTurnToInput,
  agentEventToSessionEvent,
  messageToCommittedEvent,
  sessionCheckpointToProto,
  protoToToolDefs,
} from './proto-convert.js';
import { createArtifactHandlers } from './artifact-handler.js';
import { createSandboxCallbackAuthInterceptor } from './callback-auth.js';
import type { OrchestratorServiceClient } from './tool-proxy.js';
import { getToolApiToken, setSessionTools } from './daemon.js';
import { generatePtcScripts } from './ptc-codegen.js';

async function mkdirSafe(dir: string): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return;
    console.error(`[runner] Failed to create directory ${dir}:`, err);
    throw err;
  }
}

function createDaemonHandlersForSession(
  secrets: ResolvedSecrets,
  orcClient: OrchestratorServiceClient | undefined,
  agentId: string,
  workspaceDir: string,
): Map<string, (input: unknown) => Promise<string>> | undefined {
  const s3Endpoint = secrets.S3_ENDPOINT;
  const s3AccessKey = secrets.S3_ACCESS_KEY;
  const s3SecretKey = secrets.S3_SECRET_KEY;
  const s3Bucket = secrets.S3_BUCKET || 'ctxmill-artifacts';
  const s3Region = secrets.S3_REGION || 'us-east-1';

  if (!s3Endpoint || !s3AccessKey || !s3SecretKey || !orcClient) {
    return undefined;
  }

  const artifactStore = new ArtifactStore({
    s3Endpoint,
    s3Region,
    s3AccessKey,
    s3SecretKey,
    bucket: s3Bucket,
  });

  return createArtifactHandlers({
    artifactStore,
    orchestratorClient: orcClient,
    sessionId: activeRunId,
    agentId,
    workspaceDir,
  });
}

function createToolContext(agentId: string, conversationId: string, sessionId: string, workspaceDir: string): ToolContext {
  return {
    agentId,
    conversationId,
    instanceId: sessionId,
    workspaceDir,
  };
}

/* -------------------------------------------------------------------------- */
/*  Harness registry (lazy-loaded to keep startup fast)                        */
/* -------------------------------------------------------------------------- */

const harnessCache = new Map<string, AgentHarness>();

/**
 * Resolve a harness by name. The harness modules are loaded lazily so the
 * daemon startup doesn't pay the cost of importing all SDK dependencies.
 */
async function resolveHarness(name: string): Promise<AgentHarness> {
  const cached = harnessCache.get(name);
  if (cached) return cached;

  let harness: AgentHarness;

  switch (name) {
    case 'pi-agent': {
      const { PIAgentHarness } = await import('../harness/pi-agent.js');
      harness = new PIAgentHarness() as unknown as AgentHarness;
      break;
    }
    case 'deepagents':
    case 'langgraph': {
      const { LangGraphHarness } = await import('../harness/langgraph.js');
      harness = new LangGraphHarness() as unknown as AgentHarness;
      break;
    }
    case 'claude-agents': {
      const { ClaudeAgentsHarness } = await import('../harness/claude-agents.js');
      harness = new ClaudeAgentsHarness() as unknown as AgentHarness;
      break;
    }
    default:
      throw new Error(
        `Unknown harness: "${name}". Supported: pi-agent, langgraph/deepagents, claude-agents`,
      );
  }

  harnessCache.set(name, harness);
  return harness;
}

/* -------------------------------------------------------------------------- */
/*  Orchestrator gRPC client                                                   */
/* -------------------------------------------------------------------------- */

let orchestratorClient: OrchestratorServiceClient | undefined;

/**
 * Lazily create or reuse a ConnectRPC client for the OrchestratorService.
 *
 * The orchestrator URL is read from the `ORCHESTRATOR_URL` environment variable
 * (e.g., `http://orchestrator:3001`). If not set, returns undefined so
 * session startup can fail loudly when orchestrator-location tools are present.
 */
function getOrchestratorClient(): OrchestratorServiceClient | undefined {
  if (orchestratorClient) return orchestratorClient;

  const url = process.env.ORCHESTRATOR_URL;
  if (!url) {
    console.error('[sandbox] ORCHESTRATOR_URL not set');
    return undefined;
  }

  const callbackAuthInterceptor = createSandboxCallbackAuthInterceptor();
  const transport = createConnectTransport({
    baseUrl: url,
    httpVersion: '1.1',
    nodeOptions: { timeout: 0 },
    interceptors: callbackAuthInterceptor ? [callbackAuthInterceptor] : [],
  });

  const client = createClient(OrchestratorService, transport);
  orchestratorClient = client as unknown as OrchestratorServiceClient;
  return orchestratorClient;
}

/**
 * Reset the cached orchestrator client (useful for testing).
 */
export function resetOrchestratorClient(): void {
  orchestratorClient = undefined;
}

interface SessionContext {
  readonly session: HarnessSession;
  readonly sessionId: string;
  readonly conversationId: string;
  readonly harnessName: string;
  readonly stateCollector: SessionStateCollector;
  readonly phaseTracker: ExecutionPhaseTracker;
  readonly abortController: AbortController;
  currentTurnId: string | null;
}

/* -------------------------------------------------------------------------- */
/*  Module-level session state: SessionContext bundles session state with      */
/*  AbortController for race-safe lifecycle handling.                          */
/* -------------------------------------------------------------------------- */

let activeContext: SessionContext | null = null;
let openingContext: Promise<SessionContext> | null = null;
const activeRunId: { current: string } = { current: '' };

function validateRequestedSessionId(sessionId: string, operation: string): string {
  const requestedSessionId = sessionId.trim();
  if (!requestedSessionId) {
    throw new ConnectError(`[sandbox] ${operation}: session_id is required`, Code.InvalidArgument);
  }
  return requestedSessionId;
}

async function getContextForSession(
  requestedSessionId: string,
  operation: string,
): Promise<SessionContext> {
  const sessionId = validateRequestedSessionId(requestedSessionId, operation);
  let ctx = activeContext;
  if (!ctx && openingContext) {
    try {
      ctx = await openingContext;
    } catch (err) {
      throw new Error(
        `[sandbox] ${operation}: session open failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  if (!ctx) {
    throw new ConnectError(`[sandbox] ${operation}: no active session`, Code.NotFound);
  }

  if (ctx.sessionId !== sessionId) {
    throw new ConnectError(
      `[sandbox] ${operation}: requested session ${sessionId} does not match active session ${ctx.sessionId}`,
      Code.FailedPrecondition,
    );
  }

  return ctx;
}


function appendPtcDegradedNotice(systemPrompt: string, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return `${systemPrompt}

[CTXMill degraded mode] Programmatic tool-calling (PTC) setup failed, so /workspace/.tools scripts may be missing or stale. Use MCP/orchestrator tools directly and surface that PTC support is degraded if the task depends on generated scripts. Error: ${message}`;
}

/* -------------------------------------------------------------------------- */
/*  Phase tracking helper                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Map an AgentEvent type to the appropriate execution phase transition.
 */
function phaseForEvent(event: AgentEvent): ExecutionPhase | null {
  switch (event.type) {
    case 'text_delta':
      return 'llm_call_in_flight';
    case 'tool_call_start':
      return 'tool_execution';
    case 'tool_call_end':
      return 'llm_call_in_flight';
    case 'message_committed':
      return 'after_llm';
    case 'approval_needed':
      return 'hitl_wait';
    case 'approval_resolved':
      return 'before_tool';
    case 'error':
    case 'done':
      return 'idle';
    default:
      return null;
  }
}

function updatePendingTurnRequests(
  pendingRequests: Map<string, string>,
  event: AgentEvent,
): void {
  switch (event.type) {
    case 'tool_call_start':
      pendingRequests.set(event.id, `tool call "${event.name}"`);
      return;
    case 'tool_call_end':
      pendingRequests.delete(event.id);
      return;
    case 'approval_needed':
      pendingRequests.set(event.id, `approval for "${event.tool}"`);
      return;
    case 'approval_resolved':
      pendingRequests.delete(event.id);
      return;
    default:
      return;
  }
}

function pendingTurnRequestSummary(pendingRequests: Map<string, string>): string {
  if (pendingRequests.size === 0) return 'none';
  return Array.from(pendingRequests.entries())
    .map(([id, label]) => `${id} (${label})`)
    .join(', ');
}

/* -------------------------------------------------------------------------- */
/*  openSession                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Open a harness session from either a fresh bootstrap or a restored checkpoint.
 *
 * Stores the resulting session in module-level state and initialises the
 * SessionStateCollector and ExecutionPhaseTracker for the session lifetime.
 *
 * @param req     - The proto OpenSessionRequest (fresh or restore bootstrap).
 * @param secrets - Secrets read from the sandbox environment.
 * @param opts    - Optional abort signal and override orchestrator client.
 */
export async function openSession(
  req: OpenSessionRequest,
  secrets: ResolvedSecrets,
  opts?: {
    signal?: AbortSignal;
    /** Override the orchestrator gRPC client (for testing). */
    orchestratorClient?: OrchestratorServiceClient;
  },
): Promise<OpenSessionResponse> {
  if (activeContext) {
    throw new Error('[sandbox] openSession: a session is already active — call killSession() first');
  }
  if (openingContext) {
    throw new Error('[sandbox] openSession: session is already being opened');
  }

  openingContext = (async (): Promise<SessionContext> => {
    const orcClient = opts?.orchestratorClient ?? getOrchestratorClient();
    let harnessName: string;
    let session: HarnessSession;
    let conversationId: string;
    let sessionId: string;

    if (req.bootstrap.case === 'fresh') {
      const fresh = req.bootstrap.value;
      harnessName = fresh.harnessName;
      conversationId = fresh.conversationId;
      sessionId = validateRequestedSessionId(fresh.sessionId, 'openSession');

      const daemonHandlers = createDaemonHandlersForSession(
        secrets,
        orcClient,
        fresh.agentId,
        fresh.workspaceDir || '/workspace',
      );

      const tools = protoToToolDefs(fresh.tools, {
        orchestratorClient: orcClient,
        agentId: fresh.agentId,
        sessionIdRef: activeRunId,
        daemonHandlers,
      });
      const config = protoFreshBootstrapToSessionConfig(fresh, tools, secrets);
      setSessionTools(tools, createToolContext(fresh.agentId, fresh.conversationId, sessionId, config.workspaceDir));
      const ptcPort = parseInt(process.env.PTC_PORT ?? '8080', 10);

      try {
        const ptcEligible = tools.filter((t) => t.programmatic === true);
        console.error(`[sandbox] PTC: ${ptcEligible.length}/${tools.length} tools are programmatic`);

        const ptcScripts = await generatePtcScripts({
          tools,
          scriptDir: `${config.workspaceDir}/.tools`,
          daemonPort: ptcPort,
          token: getToolApiToken(),
        });

        if (ptcScripts.length > 0) {
          console.error(`[sandbox] PTC: generated ${ptcScripts.length} scripts in ${config.workspaceDir}/.tools`);
          config.systemPrompt += '\n\nSome tools use programmatic tool calling (PTC) — large results stay in code scope instead of your context. Call ctxmill-guide({ topic: "ptc" }) for usage details, or run `ls /workspace/.tools/` to see available scripts.';
        }
      } catch (err) {
        console.error('[sandbox] PTC script generation failed, continuing in degraded PTC mode:', err);
        config.systemPrompt = appendPtcDegradedNotice(config.systemPrompt, err);
      }

      if (opts?.signal) {
        config.signal = opts.signal;
      }

      await mkdirSafe(config.workspaceDir);

      const harness = await resolveHarness(harnessName);
      session = await harness.openSession(config);
    } else if (req.bootstrap.case === 'restore') {
      const restore = req.bootstrap.value;
      const checkpoint = restore.sessionCheckpoint;
      if (!checkpoint) {
        throw new Error('[sandbox] openSession: RestoreBootstrap missing session_checkpoint');
      }
      harnessName = checkpoint.harnessName;
      conversationId = checkpoint.conversationId;
      sessionId = checkpoint.sessionId;

      const restorePoint = protoRestoreBootstrapToRestorePoint(restore);
      const workspaceDir = checkpoint.workspaceRef?.reference || '/workspace';
      const daemonHandlers = createDaemonHandlersForSession(
        secrets,
        orcClient,
        restore.agentId,
        workspaceDir,
      );
      const tools = protoToToolDefs(restore.tools, {
        orchestratorClient: orcClient,
        agentId: restore.agentId,
        sessionIdRef: activeRunId,
        daemonHandlers,
      });

      const config = {
        agentId: restore.agentId,
        conversationId: checkpoint.conversationId,
        systemPrompt: restore.systemPrompt,
        tools,
        secrets,
        harnessConfigJson: restore.harnessConfigJson,
        workspaceDir,
        signal: opts?.signal,
      };
      setSessionTools(tools, createToolContext(restore.agentId, checkpoint.conversationId, sessionId, config.workspaceDir));

      const ptcPort = parseInt(process.env.PTC_PORT ?? '8080', 10);

      try {
        const ptcEligible = tools.filter((t) => t.programmatic === true);
        console.error(`[sandbox] PTC restore: ${ptcEligible.length}/${tools.length} tools are programmatic`);

        await generatePtcScripts({
          tools,
          scriptDir: `${config.workspaceDir}/.tools`,
          daemonPort: ptcPort,
          token: getToolApiToken(),
        });
      } catch (err) {
        console.error('[sandbox] PTC script generation failed during restore, continuing in degraded PTC mode:', err);
        config.systemPrompt = appendPtcDegradedNotice(config.systemPrompt, err);
      }

      await mkdirSafe(config.workspaceDir);

      const harness = await resolveHarness(harnessName);
      session = await harness.openSession(config, restorePoint);
    } else {
      throw new Error('[sandbox] openSession: missing bootstrap (neither fresh nor restore)');
    }

    activeContext = {
      session,
      sessionId,
      conversationId,
      harnessName,
      stateCollector: new SessionStateCollector(),
      phaseTracker: new ExecutionPhaseTracker(),
      abortController: new AbortController(),
      currentTurnId: null,
    };

    return activeContext;
  })();

  try {
    const ctx = await openingContext;
    console.error(`[sandbox] session ${ctx.sessionId} opened with harness "${ctx.harnessName}"`);

    return create(OpenSessionResponseSchema, {
      sessionId: ctx.sessionId,
      status: 'ready',
    });
  } catch (err) {
    openingContext = null;
    throw err;
  }
}

/* -------------------------------------------------------------------------- */
/*  deliverTurn                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Deliver a turn to the active session and stream back SessionEvent envelopes.
 *
 * Yields AG-UI events and MessageCommitted frames as they arrive, then yields
 * a TurnCompleted or TurnFailed terminal event. Phase transitions and state
 * collection happen inline so the session can be suspended at any safe point.
 *
 * @param req  - The proto DeliverTurnRequest (sessionId, messages, turnId).
 * @param opts - Optional abort signal and approval callback.
 */
export async function* deliverTurn(
  req: DeliverTurnRequest,
  opts?: {
    signal?: AbortSignal;
    onApprovalNeeded?: ApprovalCallback;
  },
): AsyncGenerator<SessionEvent> {
  const ctx = await getContextForSession(req.sessionId, 'deliverTurn');
  if (ctx.currentTurnId) {
    throw new Error('[sandbox] deliverTurn: turn already in progress');
  }

  const turnId = req.turnId;
  let seq = 0;
  let sawSemanticEnd = false;
  let suspendBreak = false;
  let abortBreak = false;
  const pendingTurnRequests = new Map<string, string>();

  ctx.currentTurnId = turnId;
  activeRunId.current = turnId;
  ctx.phaseTracker.startTurn(turnId);
  ctx.stateCollector.startTurn(turnId);

  try {
    const input = protoDeliverTurnToInput(req);
    const context = {
      signal: ctx.abortController.signal,
      onApprovalNeeded: opts?.onApprovalNeeded,
    };

    for await (const event of ctx.session.deliverTurn(input, context)) {
      if (!event || !event.type) continue;

      if (ctx.abortController.signal.aborted) {
        console.error(`[sandbox] turn ${turnId} aborted — session killed mid-stream after ${seq} events`);
        abortBreak = true;
        break;
      }

      seq++;

      const newPhase = phaseForEvent(event);
      if (newPhase) {
        ctx.phaseTracker.setPhase(newPhase);
      }

      ctx.stateCollector.processTurnEvent(event);
      updatePendingTurnRequests(pendingTurnRequests, event);
      if (event.type === 'done' || event.type === 'error') {
        sawSemanticEnd = true;
      }

      if (event.type === 'message_committed') {
        yield messageToCommittedEvent(event, turnId, seq);
      } else {
        yield agentEventToSessionEvent(event);
      }

      if (ctx.phaseTracker.checkSuspendAtSafePoint()) {
        console.error(
          `[sandbox] turn ${turnId} suspending at phase="${ctx.phaseTracker.getPhase()}" after event #${seq}`,
        );
        suspendBreak = true;
        break;
      }
    }

    if (sawSemanticEnd && pendingTurnRequests.size === 0 && !abortBreak) {
      yield create(SessionEventSchema, {
        payload: {
          case: 'turnCompleted',
          value: create(TurnCompletedSchema, { turnId }),
        },
      });

      console.error(`[sandbox] turn ${turnId} completed — ${seq} events emitted`);
    } else if (suspendBreak && !abortBreak) {
      console.error(
        `[sandbox] turn ${turnId} suspended after ${seq} events — no terminal frame emitted`,
      );
    } else {
      const cause = abortBreak
        ? 'session killed mid-turn'
        : 'harness stream ended without done event';
      const pendingSummary = pendingTurnRequestSummary(pendingTurnRequests);
      yield create(SessionEventSchema, {
        payload: {
          case: 'turnFailed',
          value: create(TurnFailedSchema, {
            turnId,
            errorMessage: `${cause}; pending requests: ${pendingSummary}`,
          }),
        },
      });

      console.error(
        `[sandbox] turn ${turnId} failed — ${cause}; pending requests: ${pendingSummary}; ${seq} events emitted`,
      );
    }
  } catch (err: unknown) {
    yield create(SessionEventSchema, {
      payload: {
        case: 'turnFailed',
        value: create(TurnFailedSchema, {
          turnId,
          errorMessage: err instanceof Error ? err.message : String(err),
        }),
      },
    });

    console.error(`[sandbox] turn ${turnId} failed:`, err);
  } finally {
    ctx.phaseTracker.endTurn();
    ctx.stateCollector.endTurn();
    ctx.currentTurnId = null;
  }
}

/* -------------------------------------------------------------------------- */
/*  suspendSession                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Export the harness state and build a portable SessionCheckpoint.
 *
 * The checkpoint can be stored by the orchestrator and later provided to
 * `openSession` via a RestoreBootstrap to resume the conversation.
 *
 * Suspend is cooperative: the runner first asks the phase tracker for a safe
 * point. If the harness is mid-LLM/tool-execution the request is queued and
 * resolves at the next safe phase (between turns or during idle). Callers can
 * cap the wait via `safePointTimeoutMs`; on timeout we throw rather than
 * capturing a partial checkpoint (ctx-6nu).
 *
 * @param reason - Human-readable reason for the suspension (logged only).
 * @param sessionId - Optional session id used to validate the request matches
 *   the active context.
 * @param safePointTimeoutMs - Maximum time to wait for the harness to reach
 *   a safe-suspend phase. Defaults to 30s. Set to 0 to fail immediately on an
 *   unsafe phase.
 */
export async function suspendSession(
  reason: string,
  sessionId?: string,
  safePointTimeoutMs = 30_000,
): Promise<SuspendSessionResponse> {
  const ctx = sessionId
    ? await getContextForSession(sessionId, 'suspendSession')
    : activeContext;
  if (!ctx) {
    throw new Error('[sandbox] suspendSession: no active session');
  }

  console.error(`[sandbox] suspending session ${ctx.sessionId}: ${reason}`);

  // Cooperative phase gate per ADR 005 / ctx-6nu.
  // - Idle / between-turn / hitl-wait: resolves immediately.
  // - In-flight tool/LLM execution: waits for the next safe phase boundary.
  // - Unsafe phase that does not reach a safe point in time: throws.
  if (!ctx.phaseTracker.isSuspendSafe()) {
    if (safePointTimeoutMs <= 0) {
      throw new ConnectError(
        `[sandbox] suspendSession: harness is at unsafe phase '${ctx.phaseTracker.getPhase()}' and safePointTimeoutMs=0`,
        Code.FailedPrecondition,
      );
    }
    console.error(
      `[sandbox] suspendSession: phase='${ctx.phaseTracker.getPhase()}' is unsafe; waiting up to ${safePointTimeoutMs}ms for a safe point`,
    );
    const reachedSafePoint = ctx.phaseTracker.requestSuspend();
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timeoutHandle = setTimeout(() => resolve('timeout'), safePointTimeoutMs);
    });
    try {
      const winner = await Promise.race([
        reachedSafePoint.then(() => 'ready' as const),
        timedOut,
      ]);
      if (winner === 'timeout') {
        ctx.phaseTracker.cancelSuspend();
        throw new ConnectError(
          `[sandbox] suspendSession: timed out after ${safePointTimeoutMs}ms waiting for safe phase (current='${ctx.phaseTracker.getPhase()}')`,
          Code.DeadlineExceeded,
        );
      }
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  const harnessState = await ctx.session.exportState();

  if (ctx.abortController.signal.aborted) {
    throw new Error('[sandbox] suspendSession: session killed during state export');
  }

  const checkpointFromCollector = ctx.stateCollector.getCheckpointSnapshot(
    ctx.sessionId,
    ctx.conversationId,
    ctx.harnessName,
    harnessState,
    { strategy: 'none', reference: '' },
  );

  const protoCheckpoint = sessionCheckpointToProto(checkpointFromCollector);

  openingContext = null;

  return create(SuspendSessionResponseSchema, {
    sessionCheckpoint: protoCheckpoint,
  });
}

/* -------------------------------------------------------------------------- */
/*  killSession                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Close the active session and clear all module-level state.
 *
 * Safe to call when no session is active — returns `no_session` status.
 */
export async function killSession(requestedSessionId?: string): Promise<KillSessionResponse> {
  if (requestedSessionId) {
    await getContextForSession(requestedSessionId, 'killSession');
  }

  if (!activeContext) {
    return create(KillSessionResponseSchema, { finalStatus: 'no_session' });
  }

  const ctx = activeContext;
  const sessionId = ctx.sessionId;
  console.error(`[sandbox] killing session ${sessionId}`);

  try {
    ctx.abortController.abort();
    await ctx.session.close();
  } catch (err: unknown) {
    console.error(`[sandbox] session ${sessionId} close error:`, err);
  } finally {
    activeContext = null;
    openingContext = null;
    setSessionTools([]);
  }

  return create(KillSessionResponseSchema, { finalStatus: 'killed' });
}
