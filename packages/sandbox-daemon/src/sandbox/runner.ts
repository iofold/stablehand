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
  type SessionCheckpoint as ProtoConvertSessionCheckpoint,
} from './proto-convert.js';
import { createArtifactHandlers } from './artifact-handler.js';
import type { OrchestratorServiceClient } from './tool-proxy.js';

async function mkdirSafe(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true }).catch(() => {});
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
 * (e.g., `http://orchestrator:3001`). If not set, returns undefined and
 * orchestrator-location tools will use the placeholder stub.
 */
function getOrchestratorClient(): OrchestratorServiceClient | undefined {
  if (orchestratorClient) return orchestratorClient;

  const url = process.env.ORCHESTRATOR_URL;
  if (!url) {
    console.error('[sandbox] ORCHESTRATOR_URL not set — orchestrator tool proxies will be stubbed');
    return undefined;
  }

  const transport = createConnectTransport({
    baseUrl: url,
    httpVersion: '1.1',
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

/* -------------------------------------------------------------------------- */
/*  Module-level session state (one session per daemon process)               */
/* -------------------------------------------------------------------------- */

let activeSession: HarnessSession | null = null;
let activeSessionId: string | null = null;
let stateCollector: SessionStateCollector | null = null;
let phaseTracker: ExecutionPhaseTracker | null = null;
let activeConversationId: string | null = null;
let activeHarnessName: string | null = null;
const activeRunId: { current: string } = { current: '' };

/* -------------------------------------------------------------------------- */
/*  Phase tracking helper                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Map an AgentEvent type to the appropriate execution phase transition.
 */
function phaseForEvent(event: AgentEvent): ExecutionPhase | null {
  switch (event.type) {
    case 'text_delta':
      return 'after_llm';
    case 'tool_call_start':
      return 'tool_execution';
    case 'tool_call_end':
      return 'after_tool';
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
 * @param secrets - Secrets read from the tmpfs mount.
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
  if (activeSession) {
    throw new Error('[sandbox] openSession: a session is already active — call killSession() first');
  }

  const orcClient = opts?.orchestratorClient ?? getOrchestratorClient();
  let harnessName: string;

  if (req.bootstrap.case === 'fresh') {
    const fresh = req.bootstrap.value;
    harnessName = fresh.harnessName;

    let daemonHandlers: Map<string, (input: unknown) => Promise<string>> | undefined;
    const s3Endpoint = secrets.S3_ENDPOINT;
    const s3AccessKey = secrets.S3_ACCESS_KEY;
    const s3SecretKey = secrets.S3_SECRET_KEY;
    const s3Bucket = secrets.S3_BUCKET || 'ctxmill-artifacts';
    const s3Region = secrets.S3_REGION || 'us-east-1';

    if (s3Endpoint && s3AccessKey && s3SecretKey && orcClient) {
      const artifactStore = new ArtifactStore({
        s3Endpoint,
        s3Region,
        s3AccessKey,
        s3SecretKey,
        bucket: s3Bucket,
      });

      daemonHandlers = createArtifactHandlers({
        artifactStore,
        orchestratorClient: orcClient,
        runId: activeRunId,
        agentId: fresh.agentId,
        workspaceDir: '/workspace',
      });
    }

    const tools = protoToToolDefs(fresh.tools, {
      orchestratorClient: orcClient,
      agentId: fresh.agentId,
      runIdRef: activeRunId,
      daemonHandlers,
    });

    const config = protoFreshBootstrapToSessionConfig(fresh, tools, secrets);
    if (opts?.signal) {
      config.signal = opts.signal;
    }

    await mkdirSafe(config.workspaceDir);

    const harness = await resolveHarness(harnessName);
    activeSession = await harness.openSession(config);
    activeConversationId = fresh.conversationId;
  } else if (req.bootstrap.case === 'restore') {
    const restore = req.bootstrap.value;
    const checkpoint = restore.sessionCheckpoint;
    if (!checkpoint) {
      throw new Error('[sandbox] openSession: RestoreBootstrap missing session_checkpoint');
    }
    harnessName = checkpoint.harnessName;

    const restorePoint = protoRestoreBootstrapToRestorePoint(restore);

    // Minimal config — the harness restores full configuration from its stored state.
    const config = {
      agentId: checkpoint.sessionId,
      conversationId: checkpoint.conversationId,
      systemPrompt: '',
      tools: [],
      secrets,
      harnessConfigJson: '{}',
      workspaceDir: checkpoint.workspaceRef?.reference || '/workspace',
      signal: opts?.signal,
    };

    await mkdirSafe(config.workspaceDir);

    const harness = await resolveHarness(harnessName);
    activeSession = await harness.openSession(config, restorePoint);
    activeConversationId = checkpoint.conversationId;
  } else {
    throw new Error('[sandbox] openSession: missing bootstrap (neither fresh nor restore)');
  }

  const sessionId = crypto.randomUUID();
  activeSessionId = sessionId;
  activeHarnessName = harnessName;
  stateCollector = new SessionStateCollector();
  phaseTracker = new ExecutionPhaseTracker();

  console.error(`[sandbox] session ${sessionId} opened with harness "${harnessName}"`);

  return create(OpenSessionResponseSchema, {
    sessionId,
    status: 'ready',
  });
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
  if (!activeSession || !stateCollector || !phaseTracker) {
    throw new Error('[sandbox] deliverTurn: no active session — call openSession() first');
  }

  const turnId = req.turnId;
  let seq = 0;

  activeRunId.current = turnId;
  phaseTracker.startTurn(turnId);
  stateCollector.startTurn(turnId);

  try {
    const input = protoDeliverTurnToInput(req);
    const context = {
      signal: opts?.signal,
      onApprovalNeeded: opts?.onApprovalNeeded,
    };

    for await (const event of activeSession.deliverTurn(input, context)) {
      if (!event || !event.type) continue;
      seq++;

      const newPhase = phaseForEvent(event);
      if (newPhase) {
        phaseTracker.setPhase(newPhase);
      }

      stateCollector.processTurnEvent(event);

      if (event.type === 'message_committed') {
        yield messageToCommittedEvent(event, turnId, seq);
      } else {
        yield agentEventToSessionEvent(event);
      }

      if (phaseTracker.checkSuspendAtSafePoint()) {
        console.error(
          `[sandbox] turn ${turnId} suspending at phase="${phaseTracker.getPhase()}" after event #${seq}`,
        );
        break;
      }
    }

    yield create(SessionEventSchema, {
      payload: {
        case: 'turnCompleted',
        value: create(TurnCompletedSchema, { turnId }),
      },
    });

    console.error(`[sandbox] turn ${turnId} completed — ${seq} events emitted`);
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
    phaseTracker?.endTurn();
    stateCollector?.endTurn();
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
 * @param reason - Human-readable reason for the suspension (logged only).
 */
export async function suspendSession(reason: string): Promise<SuspendSessionResponse> {
  if (
    !activeSession ||
    !stateCollector ||
    !activeSessionId ||
    !activeConversationId ||
    !activeHarnessName
  ) {
    throw new Error('[sandbox] suspendSession: no active session');
  }

  console.error(`[sandbox] suspending session ${activeSessionId}: ${reason}`);

  const harnessState = await activeSession.exportState();

  const checkpointFromCollector = stateCollector.getCheckpointSnapshot(
    activeSessionId,
    activeConversationId,
    activeHarnessName,
    harnessState,
    { strategy: 'none', reference: '' },
  );

  // Bridge checkpoint.ts::SessionCheckpoint → proto-convert.ts::SessionCheckpoint.
  // The key differences are:
  //   • pendingRequests.payload (Record) → payloadJson (JSON string)
  //   • harnessState (HarnessExportedState) → Record<string, unknown>
  const protoConvertCheckpoint: ProtoConvertSessionCheckpoint = {
    checkpointVersion: checkpointFromCollector.checkpointVersion,
    sessionId: checkpointFromCollector.sessionId,
    conversationId: checkpointFromCollector.conversationId,
    harnessName: checkpointFromCollector.harnessName,
    cursor: checkpointFromCollector.cursor,
    runnerState: {
      status: checkpointFromCollector.runnerState.status,
      pendingRequests: (checkpointFromCollector.runnerState.pendingRequests ?? []).map((pr) => ({
        type: pr.type,
        id: pr.id,
        payloadJson: JSON.stringify(pr.payload),
      })),
    },
    workspaceRef: checkpointFromCollector.workspaceRef,
    harnessState: checkpointFromCollector.harnessState as unknown as Record<string, unknown>,
  };

  const protoCheckpoint = sessionCheckpointToProto(protoConvertCheckpoint);

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
export async function killSession(): Promise<KillSessionResponse> {
  if (!activeSession) {
    return create(KillSessionResponseSchema, { finalStatus: 'no_session' });
  }

  const sessionId = activeSessionId;
  console.error(`[sandbox] killing session ${sessionId}`);

  try {
    await activeSession.close();
  } catch (err: unknown) {
    console.error(`[sandbox] session ${sessionId} close error:`, err);
  } finally {
    activeSession = null;
    activeSessionId = null;
    stateCollector = null;
    phaseTracker = null;
    activeConversationId = null;
    activeHarnessName = null;
  }

  return create(KillSessionResponseSchema, { finalStatus: 'killed' });
}
