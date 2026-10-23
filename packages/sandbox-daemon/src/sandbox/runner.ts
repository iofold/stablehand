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
import { SandboxSecretsSchema } from '@stablehand/contracts';
import { createClient } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-node';
import type {
  OpenSessionRequest,
  OpenSessionResponse,
  DeliverTurnRequest,
  AttachTurnRequest,
  CancelTurnRequest,
  CancelTurnResponse,
  RenewTurnDeliveryCapabilityRequest,
  RenewTurnDeliveryCapabilityResponse,
  SuspendSessionResponse,
  KillSessionResponse,
  SessionEvent,
} from '@stablehand/proto/sandbox/v1';
import {
  OrchestratorService,
  OpenSessionResponseSchema,
  SessionEventSchema,
  TurnCompletedSchema,
  TurnFailedSchema,
  RenewTurnDeliveryCapabilityResponseSchema,
  CancelTurnResponseSchema,
  SuspendSessionResponseSchema,
  KillSessionResponseSchema,
} from '@stablehand/proto/sandbox/v1';

import { ArtifactStore } from '../artifact/artifact-store.js';
import { createBrowserHandlers } from './browser-handler.js';
import type {
  AgentHarness,
  HarnessSession,
  ResolvedSecrets,
  ApprovalCallback,
  AgentEvent,
  HarnessSessionConfig,
} from '../harness/types.js';
import type { ToolContext, ToolDefinition } from '../tool/types.js';
import type { ExecutionPhase } from './execution-phase.js';
import { ExecutionPhaseTracker } from './execution-phase.js';
import { SessionStateCollector } from './checkpoint.js';
import {
  protoFreshBootstrapToSessionConfig,
  protoNativeToolPolicyToInternal,
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
import {
  assertMonotonicTurnDelivery,
  parseTurnDeliveryCapability,
  sameTurnDeliveryIdentity,
  type TurnDeliveryIdentity,
} from './turn-delivery-capability.js';
import {
  armTurnDeliveryExpiry,
  assertTurnDeliveryContextCurrent,
  clearTurnDeliveryExpiry,
  installTurnDeliveryCapability,
  isTurnDeliveryCapabilityExpired,
  registerPtcTurnDeliveryContext,
  revokePtcTurnDeliveryContext,
  runWithTurnDeliveryContext,
  type TurnDeliveryContext,
} from './turn-delivery-context.js';
import {
  resolveTurnOrphanGraceMs,
  TurnDeliveryJournal,
} from './turn-delivery-journal.js';
import { FanoutLimitHarnessTurnEnforcer, resolveTurnFanoutLimits } from '../harness/enforcement/fanout.js';

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
  sandboxSessionId: string,
  agentId: string,
  workspaceDir: string,
): Map<string, (input: unknown) => Promise<string>> | undefined {
  // Browser tools (ctx-lqas) need only the Chromium baked into the image, so
  // they are always available; artifact tools additionally require S3 +
  // orchestrator wiring. A DAEMON-location tool whose handler is absent still
  // fails fast per-tool at proto conversion.
  const handlers = createBrowserHandlers({ workspaceDir });

  const s3Endpoint = secrets.S3_ENDPOINT;
  const s3AccessKey = secrets.S3_ACCESS_KEY;
  const s3SecretKey = secrets.S3_SECRET_KEY;
  const s3Bucket = secrets.S3_BUCKET || 'stablehand-artifacts';
  const s3Region = secrets.S3_REGION || 'us-east-1';

  if (s3Endpoint && s3AccessKey && s3SecretKey && orcClient) {
    const artifactStore = new ArtifactStore({
      s3Endpoint,
      s3Region,
      s3AccessKey,
      s3SecretKey,
      bucket: s3Bucket,
    });

    const artifactHandlers = createArtifactHandlers({
      artifactStore,
      orchestratorClient: orcClient,
      sandboxSessionId,
      agentId,
      workspaceDir,
    });
    for (const [name, handler] of artifactHandlers) {
      handlers.set(name, handler);
    }
  }

  return handlers;
}

function createToolContext(
  agentId: string,
  conversationId: string,
  sandboxSessionId: string,
  workspaceDir: string,
): ToolContext {
  return {
    agentId,
    conversationId,
    sandboxSessionId,
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
  readonly agentId: string;
  readonly conversationId: string;
  readonly harnessName: string;
  readonly stateCollector: SessionStateCollector;
  readonly phaseTracker: ExecutionPhaseTracker;
  readonly abortController: AbortController;
  readonly ptcConfig: {
    tools: ToolDefinition[];
    scriptDir: string;
    daemonPort: number;
  };
  readonly highestDeliveryByTurn: Map<string, TurnDeliveryIdentity>;
  /** Re-attachable journals: the running delivery and recently finished ones. */
  readonly journalsByTurn: Map<string, RetainedJournal>;
  activeDelivery: ActiveTurnDelivery | null;
  closing: boolean;
  killPromise?: Promise<KillSessionResponse>;
  poisoned: boolean;
}

interface ActiveTurnDelivery {
  readonly context: TurnDeliveryContext;
  readonly settled: Promise<TurnDeliverySettlement>;
  readonly resolveSettlement: (settlement: TurnDeliverySettlement) => void;
  readonly journal: TurnDeliveryJournal;
  /** ADR 025 orphan grace; 0 means a dropped stream cancels the turn. */
  readonly orphanGraceMs: number;
  settlement?: TurnDeliverySettlement;
  consumer?: DeliveryConsumer;
  orphanTimer?: NodeJS.Timeout;
  pump?: Promise<void>;
}

interface DeliveryConsumer {
  readonly controller: AbortController;
}

interface RetainedJournal {
  readonly journal: TurnDeliveryJournal;
  readonly graceMs: number;
  expiryTimer?: NodeJS.Timeout;
}

type TurnDeliverySettlement = 'released' | 'poisoned';

/* -------------------------------------------------------------------------- */
/*  Module-level session state: SessionContext bundles session state with      */
/*  AbortController for race-safe lifecycle handling.                          */
/* -------------------------------------------------------------------------- */

let activeContext: SessionContext | null = null;
let openingContext: Promise<SessionContext> | null = null;

const KILL_ACTIVE_DELIVERY_TIMEOUT_MS = 30_000;
const ITERATOR_CLEANUP_TIMEOUT_MS = 10_000;
const MAX_ITERATOR_CLEANUP_STEPS = 16;

function validateTurnSecrets(turnSecrets: Readonly<Record<string, string>>): void {
  const parsed = SandboxSecretsSchema.safeParse(turnSecrets);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ConnectError(
      `Invalid turn secrets${issue?.path.length ? `.${issue.path.join('.')}` : ''}: `
      + (issue?.message ?? 'validation failed'),
      Code.InvalidArgument,
    );
  }
}

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

[Stablehand degraded mode] Programmatic tool-calling (PTC) setup failed, so /workspace/.tools scripts may be missing or stale. Use MCP/orchestrator tools directly and surface that PTC support is degraded if the task depends on generated scripts. Error: ${message}`;
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
    opts?.signal?.throwIfAborted();
    const orcClient = opts?.orchestratorClient ?? getOrchestratorClient();
    let harnessName: string;
    let session: HarnessSession;
    let conversationId: string;
    let sessionId: string;
    let agentId: string;
    let ptcConfig: SessionContext['ptcConfig'];
    let lastCompletedTurnId: string | undefined;

    if (req.bootstrap.case === 'fresh') {
      const fresh = req.bootstrap.value;
      harnessName = fresh.harnessName;
      conversationId = fresh.conversationId;
      sessionId = validateRequestedSessionId(fresh.sessionId, 'openSession');
      agentId = fresh.agentId;

      const daemonHandlers = createDaemonHandlersForSession(
        secrets,
        orcClient,
        sessionId,
        fresh.agentId,
        fresh.workspaceDir || '/workspace',
      );

      const tools = protoToToolDefs(fresh.tools, {
        orchestratorClient: orcClient,
        callbackRoute: {
          sandboxSessionId: sessionId,
          agentId: fresh.agentId,
        },
        daemonHandlers,
      });
      const config = protoFreshBootstrapToSessionConfig(fresh, tools, secrets);
      ptcConfig = {
        tools,
        scriptDir: `${config.workspaceDir}/.tools`,
        daemonPort: parseInt(process.env.PTC_PORT ?? '8080', 10),
      };
      setSessionTools(tools, createToolContext(fresh.agentId, fresh.conversationId, sessionId, config.workspaceDir));

      try {
        const ptcEligible = tools.filter((t) => t.programmatic === true);
        console.error(`[sandbox] PTC: ${ptcEligible.length}/${tools.length} tools are programmatic`);

        const ptcScripts = await generatePtcScripts({
          tools,
          scriptDir: ptcConfig.scriptDir,
          daemonPort: ptcConfig.daemonPort,
          token: getToolApiToken(),
        });

        if (ptcScripts.length > 0) {
          console.error(`[sandbox] PTC: generated ${ptcScripts.length} scripts in ${config.workspaceDir}/.tools`);
          config.systemPrompt += '\n\nSome tools use programmatic tool calling (PTC) — large results stay in code scope instead of your context. Call stablehand-guide({ topic: "ptc" }) for usage details, or run `ls /workspace/.tools/` to see available scripts.';
        }
      } catch (err) {
        console.error('[sandbox] PTC script generation failed, continuing in degraded PTC mode:', err);
        config.systemPrompt = appendPtcDegradedNotice(config.systemPrompt, err);
      }

      await mkdirSafe(config.workspaceDir);

      const harness = await resolveHarness(harnessName);
      config.turnEnforcer = new FanoutLimitHarnessTurnEnforcer(
        harness.enforcementCapabilities,
        resolveTurnFanoutLimits(config.harnessConfigJson),
      );
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
      agentId = restore.agentId;
      lastCompletedTurnId = checkpoint.cursor?.lastCompletedTurnId;

      const restorePoint = protoRestoreBootstrapToRestorePoint(restore);
      const workspaceDir = checkpoint.workspaceRef?.reference || '/workspace';
      const daemonHandlers = createDaemonHandlersForSession(
        secrets,
        orcClient,
        sessionId,
        restore.agentId,
        workspaceDir,
      );
      const tools = protoToToolDefs(restore.tools, {
        orchestratorClient: orcClient,
        callbackRoute: {
          sandboxSessionId: sessionId,
          agentId: restore.agentId,
        },
        daemonHandlers,
      });

      const config: HarnessSessionConfig = {
        agentId: restore.agentId,
        conversationId: checkpoint.conversationId,
        systemPrompt: restore.systemPrompt,
        tools,
        ...(restore.nativeToolPolicy
          ? { nativeToolPolicy: protoNativeToolPolicyToInternal(restore.nativeToolPolicy) }
          : {}),
        secrets,
        harnessConfigJson: restore.harnessConfigJson,
        workspaceDir,
      };
      ptcConfig = {
        tools,
        scriptDir: `${config.workspaceDir}/.tools`,
        daemonPort: parseInt(process.env.PTC_PORT ?? '8080', 10),
      };
      setSessionTools(tools, createToolContext(restore.agentId, checkpoint.conversationId, sessionId, config.workspaceDir));

      try {
        const ptcEligible = tools.filter((t) => t.programmatic === true);
        console.error(`[sandbox] PTC restore: ${ptcEligible.length}/${tools.length} tools are programmatic`);

        await generatePtcScripts({
          tools,
          scriptDir: ptcConfig.scriptDir,
          daemonPort: ptcConfig.daemonPort,
          token: getToolApiToken(),
        });
      } catch (err) {
        console.error('[sandbox] PTC script generation failed during restore, continuing in degraded PTC mode:', err);
        config.systemPrompt = appendPtcDegradedNotice(config.systemPrompt, err);
      }

      await mkdirSafe(config.workspaceDir);

      const harness = await resolveHarness(harnessName);
      config.turnEnforcer = new FanoutLimitHarnessTurnEnforcer(
        harness.enforcementCapabilities,
        resolveTurnFanoutLimits(config.harnessConfigJson),
      );
      session = await harness.openSession(config, restorePoint);
    } else {
      throw new Error('[sandbox] openSession: missing bootstrap (neither fresh nor restore)');
    }

    if (opts?.signal?.aborted) {
      await session.close();
      opts.signal.throwIfAborted();
    }

    activeContext = {
      session,
      sessionId,
      agentId,
      conversationId,
      harnessName,
      stateCollector: new SessionStateCollector(lastCompletedTurnId),
      phaseTracker: new ExecutionPhaseTracker(),
      abortController: new AbortController(),
      ptcConfig,
      highestDeliveryByTurn: new Map(),
      journalsByTurn: new Map(),
      activeDelivery: null,
      closing: false,
      poisoned: false,
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

function createActiveTurnDelivery(
  parsed: ReturnType<typeof parseTurnDeliveryCapability>,
  turnSecrets: Readonly<Record<string, string>>,
): ActiveTurnDelivery {
  let resolveSettlement!: (settlement: TurnDeliverySettlement) => void;
  const settled = new Promise<TurnDeliverySettlement>((resolve) => {
    resolveSettlement = resolve;
  });
  const orphanGraceMs = resolveTurnOrphanGraceMs();
  const context: TurnDeliveryContext = {
    identity: parsed.identity,
    capability: parsed.capability,
    leaseExpiresAtMs: parsed.leaseExpiresAtMs,
    abortController: new AbortController(),
    turnSecrets: Object.freeze({ ...turnSecrets }),
    orphanGraceMs,
    capabilityVersion: 0,
  };

  const delivery: ActiveTurnDelivery = {
    context,
    settled,
    resolveSettlement,
    journal: new TurnDeliveryJournal(parsed.identity.turnId),
    orphanGraceMs,
  };
  context.onCapabilityExpired = () => {
    startOrphanTimer(delivery, 'delivery capability expired without renewal');
  };
  context.abandonIfOrphaned = (reason) => abandonOrphanedDelivery(delivery, reason);
  return delivery;
}

function releaseActiveTurnDelivery(
  sessionContext: SessionContext,
  delivery: ActiveTurnDelivery,
): void {
  if (delivery.settlement) return;
  delivery.settlement = 'released';
  clearOrphanTimer(delivery);
  clearTurnDeliveryExpiry(delivery.context);
  revokePtcTurnDeliveryContext(delivery.context);
  if (!delivery.context.abortController.signal.aborted) {
    delivery.context.abortController.abort(
      new ConnectError('Turn delivery ended', Code.Canceled),
    );
  }
  if (sessionContext.activeDelivery === delivery) {
    sessionContext.activeDelivery = null;
  }
  delivery.resolveSettlement('released');
}

function poisonActiveTurnDelivery(
  sessionContext: SessionContext,
  delivery: ActiveTurnDelivery,
  reason: unknown,
): void {
  if (delivery.settlement) return;
  delivery.settlement = 'poisoned';
  sessionContext.poisoned = true;
  clearOrphanTimer(delivery);
  clearTurnDeliveryExpiry(delivery.context);
  revokePtcTurnDeliveryContext(delivery.context);
  if (!delivery.context.abortController.signal.aborted) {
    delivery.context.abortController.abort(reason);
  }
  if (!sessionContext.abortController.signal.aborted) {
    sessionContext.abortController.abort(reason);
  }
  delivery.resolveSettlement('poisoned');
}

async function awaitSafeDeliveryHandoff(
  active: ActiveTurnDelivery,
  successorLeaseExpiresAtMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const remainingMs = successorLeaseExpiresAtMs - Date.now();
  if (remainingMs <= 0) {
    throw new ConnectError(
      'Successor turn delivery capability expired before safe handoff',
      Code.FailedPrecondition,
    );
  }

  let timeout: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const timedOut = new Promise<'expired'>((resolve) => {
    timeout = setTimeout(() => resolve('expired'), remainingMs);
    timeout.unref();
  });
  const requestAborted = signal
    ? new Promise<'aborted'>((resolve) => {
      if (signal.aborted) {
        resolve('aborted');
        return;
      }
      onAbort = () => resolve('aborted');
      signal.addEventListener('abort', onAbort, { once: true });
    })
    : new Promise<never>(() => undefined);

  try {
    const result = await Promise.race([
      active.settled,
      timedOut,
      requestAborted,
    ]);
    if (result === 'expired') {
      throw new ConnectError(
        'Cannot prove safe handoff from expired predecessor delivery',
        Code.FailedPrecondition,
      );
    }
    if (result === 'aborted') {
      throw new ConnectError(
        'Successor delivery request was cancelled before safe handoff',
        Code.Canceled,
      );
    }
    if (result === 'poisoned') {
      throw new ConnectError(
        'Cannot prove safe handoff from poisoned predecessor delivery',
        Code.FailedPrecondition,
      );
    }
  } finally {
    if (timeout) clearTimeout(timeout);
    if (signal && onAbort) {
      signal.removeEventListener('abort', onAbort);
    }
  }
}

async function admitTurnDelivery(
  ctx: SessionContext,
  req: DeliverTurnRequest,
  signal?: AbortSignal,
): Promise<ActiveTurnDelivery> {
  if (
    ctx.poisoned
    || ctx.closing
    || ctx.abortController.signal.aborted
    || activeContext !== ctx
  ) {
    throw new ConnectError(
      'Sandbox session is closing or unavailable for turn delivery',
      Code.FailedPrecondition,
    );
  }
  let parsed = parseTurnDeliveryCapability(
    req.deliveryCapability,
    {
      turnId: req.turnId,
      sandboxSessionId: req.sessionId,
      agentId: ctx.agentId,
    },
  );
  const previous = ctx.highestDeliveryByTurn.get(req.turnId);
  assertMonotonicTurnDelivery(previous, parsed.identity);

  const active = ctx.activeDelivery;
  if (active) {
    if (active.context.identity.turnId !== req.turnId) {
      throw new ConnectError(
        '[sandbox] deliverTurn: turn already in progress',
        Code.FailedPrecondition,
      );
    }
    if (
      parsed.identity.fenceToken <= active.context.identity.fenceToken
    ) {
      throw new ConnectError(
        '[sandbox] deliverTurn: delivery is already in progress',
        Code.FailedPrecondition,
      );
    }
    if (active.context.abortController.signal.aborted) {
      throw new ConnectError(
        'Cannot prove safe handoff from an aborted predecessor delivery',
        Code.FailedPrecondition,
      );
    }

    // Publish the successor fence before asking the predecessor to stop. Any
    // concurrently arriving predecessor is stale from this point forward.
    ctx.highestDeliveryByTurn.set(req.turnId, parsed.identity);
    active.context.abortController.abort(new ConnectError(
      'Turn delivery superseded by a higher fence',
      Code.Canceled,
    ));
    await awaitSafeDeliveryHandoff(
      active,
      parsed.leaseExpiresAtMs,
      signal,
    );

    if (
      ctx.poisoned
      || ctx.closing
      || ctx.abortController.signal.aborted
      || activeContext !== ctx
    ) {
      throw new ConnectError(
        'Sandbox session began closing during turn delivery handoff',
        Code.FailedPrecondition,
      );
    }

    parsed = parseTurnDeliveryCapability(
      req.deliveryCapability,
      {
        turnId: req.turnId,
        sandboxSessionId: req.sessionId,
        agentId: ctx.agentId,
      },
    );
    assertMonotonicTurnDelivery(
      ctx.highestDeliveryByTurn.get(req.turnId),
      parsed.identity,
    );
    if (ctx.activeDelivery) {
      throw new ConnectError(
        'Cannot prove exclusive harness ownership for successor delivery',
        Code.FailedPrecondition,
      );
    }
  }

  signal?.throwIfAborted();
  if (
    ctx.poisoned
    || ctx.closing
    || ctx.abortController.signal.aborted
    || activeContext !== ctx
  ) {
    throw new ConnectError(
      'Sandbox session is closing or unavailable for turn delivery',
      Code.FailedPrecondition,
    );
  }
  ctx.highestDeliveryByTurn.set(req.turnId, parsed.identity);
  const delivery = createActiveTurnDelivery(parsed, req.turnSecrets);
  ctx.activeDelivery = delivery;
  armTurnDeliveryExpiry(delivery.context);
  return delivery;
}

export async function renewTurnDeliveryCapability(
  req: RenewTurnDeliveryCapabilityRequest,
): Promise<RenewTurnDeliveryCapabilityResponse> {
  const ctx = await getContextForSession(
    req.sessionId,
    'renewTurnDeliveryCapability',
  );
  const active = ctx.activeDelivery;
  if (!active || active.context.identity.turnId !== req.turnId) {
    // ADR 025: the harness may finish while its consumer is still draining
    // the journal (a takeover replay lags the pump). Acknowledge the current
    // authority so the consumer keeps its capability until it has read the
    // terminal frame; nothing can call back on a finished delivery.
    const retained = ctx.journalsByTurn.get(req.turnId);
    const highest = ctx.highestDeliveryByTurn.get(req.turnId);
    if (retained?.journal.finished && highest) {
      const parsed = parseTurnDeliveryCapability(
        req.deliveryCapability,
        {
          turnId: req.turnId,
          sandboxSessionId: req.sessionId,
          agentId: ctx.agentId,
        },
      );
      if (sameTurnDeliveryIdentity(highest, parsed.identity)) {
        return create(RenewTurnDeliveryCapabilityResponseSchema, { renewed: true });
      }
    }
    throw new ConnectError(
      'No active delivery matches the renewal request',
      Code.FailedPrecondition,
    );
  }
  if (active.context.abortController.signal.aborted) {
    throw new ConnectError(
      'Cannot renew an aborted turn delivery',
      Code.FailedPrecondition,
    );
  }

  const parsed = parseTurnDeliveryCapability(
    req.deliveryCapability,
    {
      turnId: req.turnId,
      sandboxSessionId: req.sessionId,
      agentId: ctx.agentId,
    },
  );
  if (!sameTurnDeliveryIdentity(active.context.identity, parsed.identity)) {
    throw new ConnectError(
      'Turn delivery renewal authority does not match the active delivery',
      Code.FailedPrecondition,
    );
  }
  if (parsed.leaseExpiresAtMs < active.context.leaseExpiresAtMs) {
    throw new ConnectError(
      'Turn delivery renewal cannot shorten the active lease',
      Code.FailedPrecondition,
    );
  }
  if (
    parsed.leaseExpiresAtMs === active.context.leaseExpiresAtMs
    && parsed.capability.signature !== active.context.capability.signature
  ) {
    throw new ConnectError(
      'Idempotent turn delivery renewal must repeat the same signature',
      Code.FailedPrecondition,
    );
  }

  installTurnDeliveryCapability(active.context, parsed);
  if (active.consumer) {
    clearOrphanTimer(active);
  }

  return create(RenewTurnDeliveryCapabilityResponseSchema, { renewed: true });
}

/**
 * True when the event proves the model/harness produced something — text,
 * tool or approval activity, a committed message, an error, or usage. A turn
 * whose stream carried none of these before its clean end is "provably
 * empty" (ctx-w03u) and safe to re-deliver: no side effect can have occurred.
 */
export function agentEventCarriesOutput(event: AgentEvent): boolean {
  switch (event.type) {
    case 'text_delta':
      return event.content.length > 0;
    case 'tool_call_start':
    case 'tool_call_end':
    case 'approval_needed':
    case 'approval_resolved':
    case 'custom_agui_event':
    case 'message_committed':
    case 'error':
      return true;
    case 'done':
      return Boolean(
        (event.result && event.result.length > 0)
        || (event.usage
          && (event.usage.inputTokens + event.usage.outputTokens + event.usage.totalTokens) > 0),
      );
    default:
      return false;
  }
}

/* -------------------------------------------------------------------------- */
/*  Delivery consumers and the orphan grace window (ADR 025)                   */
/* -------------------------------------------------------------------------- */

const CONSUMER_DETACHED = new ConnectError('Turn delivery consumer detached', Code.Canceled);

function abortTurnDelivery(delivery: ActiveTurnDelivery, reason: unknown): void {
  revokePtcTurnDeliveryContext(delivery.context);
  if (!delivery.context.abortController.signal.aborted) {
    delivery.context.abortController.abort(reason);
  }
}

function clearOrphanTimer(delivery: ActiveTurnDelivery): void {
  if (delivery.orphanTimer) {
    clearTimeout(delivery.orphanTimer);
    delivery.orphanTimer = undefined;
  }
}

/**
 * The orchestrator is gone (stream dropped or capability lapsed). Keep the
 * harness running for the grace window; abort only if nobody re-attaches.
 */
function startOrphanTimer(delivery: ActiveTurnDelivery, reason: string): void {
  if (delivery.settlement || delivery.orphanTimer) return;
  if (delivery.context.abortController.signal.aborted) return;
  const graceMs = delivery.orphanGraceMs;
  const turnId = delivery.context.identity.turnId;
  console.error(
    `[sandbox] turn ${turnId} lost its orchestrator (${reason}); `
    + `keeping it running for up to ${graceMs}ms while waiting for a re-attach`,
  );
  delivery.orphanTimer = setTimeout(() => {
    delivery.orphanTimer = undefined;
    if (delivery.settlement) return;
    if (
      delivery.consumer
      && !isTurnDeliveryCapabilityExpired(delivery.context)
    ) {
      return;
    }
    console.error(
      `[sandbox] turn ${turnId}: no orchestrator re-attached within ${graceMs}ms; abandoning the turn`,
    );
    abortTurnDelivery(delivery, orphanedDeliveryError(graceMs, reason));
  }, graceMs);
  delivery.orphanTimer.unref();
}

/**
 * The turn's error when no orchestrator came back for it. A plain Error keeps
 * the user-facing copy free of a "[deadline_exceeded]" transport prefix.
 */
function orphanedDeliveryError(graceMs: number, reason: string): Error {
  return new Error(
    `The orchestrator went away and did not reconnect within ${Math.round(graceMs / 1000)}s `
    + `(${reason}), so the sandbox stopped this turn. Messages saved before then are kept; retry to continue.`,
  );
}

/**
 * An orchestrator callback gave up after the grace window (ctx-2jp0). With no
 * live orchestrator attached, the turn is stopped the way the orphan timer
 * stops it instead of letting the harness carry on from a tool failure that
 * only means "nobody is listening": a model answering that failure would
 * complete the turn here while it is still parked on the orchestrator side,
 * and the late continuation would then be acknowledged as a duplicate.
 */
function abandonOrphanedDelivery(delivery: ActiveTurnDelivery, reason: string): boolean {
  if (delivery.context.abortController.signal.aborted) return true;
  if (delivery.settlement) return false;
  if (delivery.consumer && !isTurnDeliveryCapabilityExpired(delivery.context)) {
    return false;
  }
  clearOrphanTimer(delivery);
  console.error(
    `[sandbox] turn ${delivery.context.identity.turnId}: ${reason} within ${delivery.orphanGraceMs}ms `
    + 'and no orchestrator is attached; abandoning the turn',
  );
  abortTurnDelivery(delivery, orphanedDeliveryError(delivery.orphanGraceMs, reason));
  return true;
}

function attachDeliveryConsumer(delivery: ActiveTurnDelivery): DeliveryConsumer {
  const previous = delivery.consumer;
  const consumer: DeliveryConsumer = { controller: new AbortController() };
  delivery.consumer = consumer;
  if (previous && !previous.controller.signal.aborted) {
    previous.controller.abort(new ConnectError(
      'Turn delivery stream superseded by a re-attached consumer',
      Code.Aborted,
    ));
  }
  if (!isTurnDeliveryCapabilityExpired(delivery.context)) {
    clearOrphanTimer(delivery);
  }
  return consumer;
}

function detachDeliveryConsumer(
  delivery: ActiveTurnDelivery,
  consumer: DeliveryConsumer,
  reason: string,
): void {
  if (delivery.consumer !== consumer) return;
  delivery.consumer = undefined;
  if (delivery.settlement || delivery.orphanGraceMs <= 0) return;
  startOrphanTimer(delivery, reason);
}

/** Stream an in-flight delivery's journal to one consumer. */
async function* streamActiveDelivery(
  delivery: ActiveTurnDelivery,
  afterSeq: number,
  requestSignal?: AbortSignal,
): AsyncGenerator<SessionEvent> {
  const consumer = attachDeliveryConsumer(delivery);
  let detachReason = 'turn stream closed';
  let unlinkRequestAbort: (() => void) | undefined;
  if (requestSignal) {
    const onRequestAbort = (): void => {
      if (delivery.orphanGraceMs <= 0) {
        // Legacy contract: dropping the stream cancels the turn; keep reading
        // so the consumer still receives the terminal frame.
        abortTurnDelivery(
          delivery,
          requestSignal.reason
            ?? new ConnectError('Turn delivery request cancelled', Code.Canceled),
        );
        return;
      }
      detachReason = 'turn stream disconnected';
      if (!consumer.controller.signal.aborted) {
        consumer.controller.abort(CONSUMER_DETACHED);
      }
    };
    if (requestSignal.aborted) {
      onRequestAbort();
    } else {
      requestSignal.addEventListener('abort', onRequestAbort, { once: true });
      unlinkRequestAbort = () => requestSignal.removeEventListener('abort', onRequestAbort);
    }
  }

  try {
    for await (const event of delivery.journal.read(afterSeq, consumer.controller.signal)) {
      yield event;
    }
  } catch (error) {
    if (error === CONSUMER_DETACHED) {
      return;
    }
    throw error;
  } finally {
    unlinkRequestAbort?.();
    detachDeliveryConsumer(delivery, consumer, detachReason);
  }
}

function retainJournal(ctx: SessionContext, journal: TurnDeliveryJournal, graceMs: number): void {
  // Finished journals of other turns are no longer re-attachable targets.
  for (const [turnId, retained] of ctx.journalsByTurn) {
    if (turnId !== journal.turnId && retained.journal.finished) {
      if (retained.expiryTimer) clearTimeout(retained.expiryTimer);
      ctx.journalsByTurn.delete(turnId);
    }
  }
  const previous = ctx.journalsByTurn.get(journal.turnId);
  if (previous?.expiryTimer) clearTimeout(previous.expiryTimer);
  ctx.journalsByTurn.set(journal.turnId, { journal, graceMs });
}

function expireFinishedJournal(ctx: SessionContext, journal: TurnDeliveryJournal): void {
  const retained = ctx.journalsByTurn.get(journal.turnId);
  if (!retained || retained.journal !== journal) return;
  if (retained.graceMs <= 0) {
    ctx.journalsByTurn.delete(journal.turnId);
    return;
  }
  // A takeover may still need the terminal frame: the old owner can die
  // after reading it but before finalizing the turn.
  retained.expiryTimer = setTimeout(() => {
    const current = ctx.journalsByTurn.get(journal.turnId);
    if (current?.journal === journal) {
      ctx.journalsByTurn.delete(journal.turnId);
    }
  }, retained.graceMs);
  retained.expiryTimer.unref();
}

/**
 * Deliver a turn to the active session and stream back SessionEvent envelopes.
 *
 * The harness runs in a pump that writes every SessionEvent to the delivery
 * journal; this stream is one consumer of it. With an orphan grace window
 * (ADR 025) a dropped stream only detaches: the turn keeps running and a
 * successor orchestrator re-attaches with AttachTurn. Without one, dropping
 * the stream cancels the turn as before.
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
  const turnId = req.turnId;
  try {
    validateTurnSecrets(req.turnSecrets);
  } catch (error) {
    yield create(SessionEventSchema, {
      payload: {
        case: 'turnFailed',
        value: create(TurnFailedSchema, {
          turnId,
          errorMessage: error instanceof Error ? error.message : String(error),
        }),
      },
    });
    return;
  }
  const delivery = await admitTurnDelivery(ctx, req, opts?.signal);
  retainJournal(ctx, delivery.journal, delivery.orphanGraceMs);
  delivery.pump = runTurnPump(ctx, delivery, req, opts?.onApprovalNeeded)
    .finally(() => expireFinishedJournal(ctx, delivery.journal));
  yield* streamActiveDelivery(delivery, 0, opts?.signal);
}

/**
 * Re-attach to a delivery that outlived its consumer (ADR 025). The caller
 * presents a capability whose fence is at least the delivery's current one;
 * a higher fence becomes the delivery's authority for every later callback.
 * Events after `after_delivery_seq` are replayed from the journal, then the
 * stream continues live.
 */
export async function* attachTurn(
  req: AttachTurnRequest,
  opts?: { signal?: AbortSignal },
): AsyncGenerator<SessionEvent> {
  const ctx = await getContextForSession(req.sessionId, 'attachTurn');
  const turnId = req.turnId;
  const retained = ctx.journalsByTurn.get(turnId);
  if (!retained) {
    throw new ConnectError(
      `[sandbox] attachTurn: no delivery of turn ${turnId} is running or retained in session ${ctx.sessionId}`,
      Code.NotFound,
    );
  }
  const parsed = parseTurnDeliveryCapability(
    req.deliveryCapability,
    {
      turnId,
      sandboxSessionId: req.sessionId,
      agentId: ctx.agentId,
    },
  );
  assertMonotonicTurnDelivery(ctx.highestDeliveryByTurn.get(turnId), parsed.identity);
  const afterSeq = Number(req.afterDeliverySeq);
  if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
    throw new ConnectError('[sandbox] attachTurn: invalid after_delivery_seq', Code.InvalidArgument);
  }
  ctx.highestDeliveryByTurn.set(turnId, parsed.identity);

  const journal = retained.journal;
  const active = ctx.activeDelivery;
  console.error(
    `[sandbox] turn ${turnId} re-attached by owner ${parsed.identity.ownerId} `
    + `(fence ${parsed.identity.fenceToken}) after seq ${afterSeq}/${journal.lastSeq}`
    + `${journal.finished ? ' (delivery already finished)' : ''}`,
  );
  if (active && active.journal === journal && !active.settlement) {
    installTurnDeliveryCapability(active.context, parsed);
    yield* streamActiveDelivery(active, afterSeq, opts?.signal);
    return;
  }

  const readSignal = opts?.signal ?? new AbortController().signal;
  yield* journal.read(afterSeq, readSignal);
}

/**
 * Explicitly cancel a running delivery. Required because dropping a stream
 * no longer cancels the turn when an orphan grace window is configured.
 */
export async function cancelTurn(req: CancelTurnRequest): Promise<CancelTurnResponse> {
  const ctx = await getContextForSession(req.sessionId, 'cancelTurn');
  const active = ctx.activeDelivery;
  if (!active || active.settlement || active.context.identity.turnId !== req.turnId) {
    return create(CancelTurnResponseSchema, { cancelled: false });
  }
  // Expiry does not matter for cancellation; the fence does: a superseded
  // owner must not cancel the turn its successor adopted.
  const parsed = parseTurnDeliveryCapability(
    req.deliveryCapability,
    {
      turnId: req.turnId,
      sandboxSessionId: req.sessionId,
      agentId: ctx.agentId,
    },
    0,
  );
  if (parsed.identity.fenceToken < active.context.identity.fenceToken) {
    throw new ConnectError(
      'Stale turn delivery fence cannot cancel the current delivery',
      Code.FailedPrecondition,
    );
  }
  const reason = req.reason.trim() || 'cancelled by the orchestrator';
  console.error(`[sandbox] turn ${req.turnId} cancelled: ${reason}`);
  abortTurnDelivery(active, new ConnectError(`Turn cancelled: ${reason}`, Code.Canceled));
  return create(CancelTurnResponseSchema, { cancelled: true });
}

/**
 * Run one delivery's harness turn, writing every SessionEvent to the
 * delivery journal. Ends with a TurnCompleted or TurnFailed frame (or no
 * terminal frame when suspending at a safe point) and finishes the journal.
 */
async function runTurnPump(
  ctx: SessionContext,
  delivery: ActiveTurnDelivery,
  req: DeliverTurnRequest,
  onApprovalNeeded?: ApprovalCallback,
): Promise<void> {
  const turnId = req.turnId;
  const journal = delivery.journal;
  let seq = 0;
  let sawSemanticEnd = false;
  let attemptSawOutput = false;
  let emptyRetryUsed = false;
  let suspendBreak = false;
  let abortBreak = false;
  let phaseStarted = false;
  let stateStarted = false;
  let iterator: AsyncIterator<AgentEvent> | undefined;
  let iteratorDone = false;
  let iteratorClosePromise: Promise<void> | undefined;
  let deliveryReleased = false;
  const pendingTurnRequests = new Map<string, string>();

  const releaseDelivery = (): void => {
    if (deliveryReleased) return;
    deliveryReleased = true;
    if (phaseStarted) {
      ctx.phaseTracker.endTurn();
      phaseStarted = false;
    }
    if (stateStarted) {
      ctx.stateCollector.endTurn();
      stateStarted = false;
    }
    releaseActiveTurnDelivery(ctx, delivery);
  };

  const closeIterator = (): Promise<void> => {
    if (iteratorClosePromise) return iteratorClosePromise;
    iteratorClosePromise = (async () => {
      if (!iterator || iteratorDone || !iterator.return) return;

      const cleanupDeadlineAtMs = Date.now() + ITERATOR_CLEANUP_TIMEOUT_MS;
      const cleanupTimeoutError = new Error(
        `Iterator cleanup did not settle within ${ITERATOR_CLEANUP_TIMEOUT_MS}ms`,
      );
      const awaitCleanupStep = async <T>(operation: Promise<T>): Promise<T> => {
        const remainingMs = cleanupDeadlineAtMs - Date.now();
        if (remainingMs <= 0) throw cleanupTimeoutError;

        let timeout: NodeJS.Timeout | undefined;
        try {
          return await Promise.race([
            operation,
            new Promise<never>((_resolve, reject) => {
              timeout = setTimeout(() => reject(cleanupTimeoutError), remainingMs);
              timeout.unref();
            }),
          ]);
        } finally {
          if (timeout) clearTimeout(timeout);
        }
      };

      let result: IteratorResult<AgentEvent> | undefined;
      let lastError: unknown;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          result = await awaitCleanupStep(
            runWithTurnDeliveryContext(
              delivery.context,
              () => iterator!.return!(undefined),
            ),
          );
          break;
        } catch (error) {
          if (error === cleanupTimeoutError) throw error;
          lastError = error;
          console.error(
            `[sandbox] turn ${turnId} iterator close attempt ${attempt} failed:`,
            error,
          );
        }
      }

      if (!result) {
        throw lastError;
      }

      for (
        let cleanupStep = 0;
        result.done !== true && cleanupStep < MAX_ITERATOR_CLEANUP_STEPS;
        cleanupStep++
      ) {
        result = await awaitCleanupStep(
          runWithTurnDeliveryContext(
            delivery.context,
            () => iterator!.next(),
          ),
        );
      }
      if (result.done !== true) {
        throw new Error(
          `Iterator cleanup exceeded ${MAX_ITERATOR_CLEANUP_STEPS} steps`,
        );
      }
      iteratorDone = true;
    })();
    return iteratorClosePromise;
  };

  const poisonDelivery = (reason: unknown): never => {
    poisonActiveTurnDelivery(ctx, delivery, reason);
    throw new ConnectError(
      `Turn ${turnId} teardown could not prove exclusive sandbox ownership; session poisoned`,
      Code.Internal,
      undefined,
      undefined,
      reason,
    );
  };

  try {
    try {
      if (ctx.stateCollector.hasCompletedTurn(turnId)) {
        console.error(
          `[sandbox] turn ${turnId} already completed — acknowledging duplicate delivery without invoking harness`,
        );
        releaseDelivery();
        journal.append(create(SessionEventSchema, {
          payload: {
            case: 'turnCompleted',
            value: create(TurnCompletedSchema, { turnId }),
          },
        }));
        return;
      }

      delivery.context.abortController.signal.throwIfAborted();

      const ptcToken = registerPtcTurnDeliveryContext(delivery.context);
      await generatePtcScripts({
        ...ctx.ptcConfig,
        token: ptcToken,
      });
      assertTurnDeliveryContextCurrent(delivery.context);

      ctx.phaseTracker.startTurn(turnId);
      phaseStarted = true;
      ctx.stateCollector.startTurn(turnId);
      stateStarted = true;

      const input = protoDeliverTurnToInput(req);
      const turnSignal = AbortSignal.any([
        ctx.abortController.signal,
        delivery.context.abortController.signal,
      ]);
      turnSignal.throwIfAborted();
      const context = {
        signal: turnSignal,
        onApprovalNeeded,
        turnSecrets: delivery.context.turnSecrets,
      };

      // The capability deadline is checked once immediately before obtaining the
      // harness iterator and again before every state-advancing next() call.
      const obtainIterator = () => {
        assertTurnDeliveryContextCurrent(delivery.context);
        const iterable = runWithTurnDeliveryContext(
          delivery.context,
          () => ctx.session.deliverTurn(input, context),
        );
        return runWithTurnDeliveryContext(
          delivery.context,
          () => iterable[Symbol.asyncIterator](),
        );
      };
      iterator = obtainIterator();

      while (true) {
        assertTurnDeliveryContextCurrent(delivery.context);
        const next = await runWithTurnDeliveryContext(
          delivery.context,
          () => iterator!.next(),
        );
        if (turnSignal.aborted) {
          console.error(`[sandbox] turn ${turnId} aborted mid-stream after ${seq} events`);
          abortBreak = true;
          if (next.done) iteratorDone = true;
          break;
        }
        if (next.done) {
          // ctx-w03u: a stream that ended cleanly but provably produced nothing
          // (no text, no tool or approval activity, no committed message, no
          // usage) gets exactly one in-place re-delivery. Nothing external has
          // happened, so retrying cannot double a side effect; the retried
          // attempt continues the same journal.
          if (
            !emptyRetryUsed
            && sawSemanticEnd
            && !attemptSawOutput
            && pendingTurnRequests.size === 0
          ) {
            emptyRetryUsed = true;
            sawSemanticEnd = false;
            console.error(
              `[sandbox] turn ${turnId} model stream completed provably empty after ${seq} events — retrying delivery once`,
            );
            iterator = obtainIterator();
            continue;
          }
          iteratorDone = true;
          break;
        }
        const event = next.value;
        if (!event || !event.type) continue;

        seq++;
        if (agentEventCarriesOutput(event)) {
          attemptSawOutput = true;
        }

        if (event.type === 'tool_call_start' && typeof event.id === 'string') {
          ctx.phaseTracker.noteToolSpanStart(event.id);
        } else if (event.type === 'tool_call_end' && typeof event.id === 'string') {
          ctx.phaseTracker.noteToolSpanEnd(event.id);
        }
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
          journal.append(messageToCommittedEvent(event, turnId, seq));
        } else {
          journal.append(agentEventToSessionEvent(event));
        }

        if (ctx.phaseTracker.checkSuspendAtSafePoint()) {
          console.error(
            `[sandbox] turn ${turnId} suspending at phase="${ctx.phaseTracker.getPhase()}" after event #${seq}`,
          );
          suspendBreak = true;
          break;
        }
      }

      await closeIterator();

      let terminalEvent: SessionEvent | undefined;
      if (sawSemanticEnd && pendingTurnRequests.size === 0 && !abortBreak) {
        // Record acceptance before writing the terminal acknowledgement. If the
        // orchestrator disappears after receiving this frame but before marking
        // its durable resume attempt complete, a retry with the same turn ID
        // must stop here rather than invoke the model twice.
        ctx.stateCollector.endTurn(true);
        stateStarted = false;
        terminalEvent = create(SessionEventSchema, {
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
        const abortReason = turnSignal.reason instanceof Error
          ? turnSignal.reason.message
          : 'delivery aborted';
        const cause = abortBreak
          ? abortReason
          : 'harness stream ended without done event';
        const pendingSummary = pendingTurnRequestSummary(pendingTurnRequests);
        terminalEvent = create(SessionEventSchema, {
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

      releaseDelivery();
      if (terminalEvent) {
        journal.append(terminalEvent);
      }
    } catch (err: unknown) {
      try {
        await closeIterator();
      } catch (closeError) {
        poisonDelivery(closeError);
      }
      releaseDelivery();
      journal.append(create(SessionEventSchema, {
        payload: {
          case: 'turnFailed',
          value: create(TurnFailedSchema, {
            turnId,
            errorMessage: err instanceof Error ? err.message : String(err),
          }),
        },
      }));

      console.error(`[sandbox] turn ${turnId} failed:`, err);
    } finally {
      if (!deliveryReleased && delivery.settlement !== 'poisoned') {
        try {
          await closeIterator();
        } catch (closeError) {
          poisonDelivery(closeError);
        }
        releaseDelivery();
      }
    }
    journal.finish();
  } catch (fatal: unknown) {
    // Only an unprovable teardown (poisoned session) reaches here; surface it
    // to every consumer instead of a terminal frame.
    journal.fail(fatal);
  } finally {
    journal.finish();
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
  const ctx = requestedSessionId
    ? await getContextForSession(requestedSessionId, 'killSession')
    : activeContext;
  if (!ctx) {
    return create(KillSessionResponseSchema, { finalStatus: 'no_session' });
  }
  if (ctx.killPromise) {
    return ctx.killPromise;
  }

  // Close admission before the first await. Concurrent or handoff-waiting
  // deliveries will observe this gate and cannot install a new turn context.
  ctx.closing = true;
  ctx.killPromise = killSessionContext(ctx);
  return ctx.killPromise;
}

async function killSessionContext(ctx: SessionContext): Promise<KillSessionResponse> {
  const sessionId = ctx.sessionId;
  const activeDelivery = ctx.activeDelivery;
  console.error(`[sandbox] killing session ${sessionId}`);

  try {
    if (activeDelivery) {
      revokePtcTurnDeliveryContext(activeDelivery.context);
      if (!activeDelivery.context.abortController.signal.aborted) {
        activeDelivery.context.abortController.abort(
          new ConnectError('Sandbox session killed', Code.Canceled),
        );
      }
    }
    if (!ctx.abortController.signal.aborted) {
      ctx.abortController.abort(
        new ConnectError('Sandbox session killed', Code.Canceled),
      );
    }

    if (activeDelivery) {
      let timeout: NodeJS.Timeout | undefined;
      try {
        const result = await Promise.race([
          activeDelivery.settled,
          new Promise<'timeout'>((resolve) => {
            timeout = setTimeout(
              () => resolve('timeout'),
              KILL_ACTIVE_DELIVERY_TIMEOUT_MS,
            );
            timeout.unref();
          }),
        ]);
        if (result !== 'released') {
          if (result === 'timeout') {
            poisonActiveTurnDelivery(
              ctx,
              activeDelivery,
              new Error('Timed out waiting for active turn teardown during kill'),
            );
          }
          throw new ConnectError(
            'Sandbox session kill could not prove the active turn stopped; container termination required',
            Code.DeadlineExceeded,
          );
        }
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    }

    await ctx.session.close();
  } catch (err: unknown) {
    ctx.poisoned = true;
    console.error(`[sandbox] session ${sessionId} close error:`, err);
    throw err;
  }

  if (activeContext === ctx) {
    activeContext = null;
  }
  openingContext = null;
  setSessionTools([]);
  for (const retained of ctx.journalsByTurn.values()) {
    if (retained.expiryTimer) clearTimeout(retained.expiryTimer);
  }
  ctx.journalsByTurn.clear();

  return create(KillSessionResponseSchema, { finalStatus: 'killed' });
}
