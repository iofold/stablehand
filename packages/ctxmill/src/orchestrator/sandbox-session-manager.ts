/**
 * SandboxSessionManager — maps conversations to persistent sandbox containers.
 *
 * Responsibilities:
 *  1. Session lifecycle: ensureSession() checks in-memory cache/DB, then
 *     creates, unfreezes, or restores a session as needed.
 *  2. Turn coalescing: deliverTurn() buffers incoming messages when a turn is
 *     already in-flight. On turn completion, all buffered messages are merged
 *     into a single follow-up turn whose events are multicast to every waiter.
 *  3. State management: suspend (checkpoint), kill, freeze (docker pause),
 *     and unfreeze (docker unpause) sessions.
 */

import { createHash, randomUUID } from 'node:crypto';
import { promises as fsPromises } from 'node:fs';
import { resolve } from 'node:path';
import { create } from '@bufbuild/protobuf';
import type { JsonObject } from '@bufbuild/protobuf';
import { createClient, ConnectError, Code } from '@connectrpc/connect';
import { createGrpcTransport } from '@connectrpc/connect-node';
import {
  HarnessService,
  OpenSessionRequestSchema,
  DeliverTurnRequestSchema,
  SuspendSessionRequestSchema,
  KillSessionRequestSchema,
  type SessionEvent as ProtoSessionEvent,
  type SessionCheckpoint,
} from '@ctxmill/proto/sandbox/v1';

import type { ContainerManager } from '../sandbox/container-manager.js';
import { WorkspaceDiffService } from '../sandbox/workspace-diff.js';
import type { DatabaseRepository, SandboxSessionRow } from '../database/repository.js';
import type { ContainerLifecyclePolicy } from './container-lifecycle-policy.js';
import type { InterruptManager } from './interrupt.js';
import { protoSessionEventToCustom } from '../sandbox/proto-convert.js';
import type { SessionEvent as CustomSessionEvent } from './sandbox-run-service.js';
import type { AgentDefinition, Message } from '../types.js';
import { retryWithBackoff } from '../util/retry.js';
import {
  getSessionDir,
  getSessionWorkspacePath,
  copyBaseToSession,
  cleanupSession,
} from '../workspace/session-workspace.js';

type ToolMetadata = {
  name: string;
  description: string;
  inputSchemaJson: string;
  location: number;
};

// ── Logger interface ───────────────────────────────────────────

interface Logger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
}

// ── Public types ───────────────────────────────────────────────

export interface SandboxSessionManagerDeps {
  containerManager: ContainerManager;
  db: DatabaseRepository;
  lifecyclePolicy: ContainerLifecyclePolicy;
  interruptManager?: InterruptManager;
  sandboxSecrets?: Readonly<Record<string, string>>;
  resolveToolsForAgent?: (toolNames: string[]) => ToolMetadata[];
  logger: Logger;
  config: {
    idleTimeoutMs: number;
    maxQueuedMessages: number;
    turnTimeoutMs?: number;
  };
  dataDir?: string;
  workspaceDiffService: WorkspaceDiffService;
}

export interface SessionRecord {
  sessionId: string;
  conversationId: string;
  agentId: string;
  containerName: string;
  containerId: string;
  status: 'ACTIVE' | 'FROZEN' | 'CHECKPOINTED' | 'RESTORING';
  harnessName: string;
  sessionWorkspaceDir?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  grpcClient?: any; // ConnectRPC client — typed as any per spec
}

// ── Internal types ─────────────────────────────────────────────

interface TurnQueueEntry {
  messages: Message[];
  turnId: string;
  channel: AsyncChannel<CustomSessionEvent>;
}

interface ChannelState<T> {
  buffer: T[];
  done: boolean;
  error: Error | null;
  waiter: { resolve: () => void; reject: (err: Error) => void } | null;
}

// ── AsyncChannel ───────────────────────────────────────────────

/**
 * Single-consumer async channel. Push-based emission on one side,
 * pull-based AsyncGenerator on the other.
 */
class AsyncChannel<T> {
  private readonly state: ChannelState<T> = {
    buffer: [],
    done: false,
    error: null,
    waiter: null,
  };

  push(value: T): void {
    this.state.buffer.push(value);
    if (this.state.waiter) {
      const { resolve } = this.state.waiter;
      this.state.waiter = null;
      resolve();
    }
  }

  close(): void {
    this.state.done = true;
    if (this.state.waiter) {
      const { resolve } = this.state.waiter;
      this.state.waiter = null;
      resolve();
    }
  }

  fail(err: Error): void {
    this.state.error = err;
    if (this.state.waiter) {
      const { reject } = this.state.waiter;
      this.state.waiter = null;
      reject(err);
    }
  }

  generator(): AsyncGenerator<T> {
    const state = this.state;
    return (async function* () {
      while (true) {
        // Drain buffered items first
        while (state.buffer.length > 0) {
          yield state.buffer.shift()!;
        }
        if (state.error !== null) {
          throw state.error;
        }
        if (state.done) {
          return;
        }
        // Wait for push(), close(), or fail()
        await new Promise<void>((resolve, reject) => {
          state.waiter = { resolve, reject };
        });
      }
    })();
  }
}

// ── Constants ──────────────────────────────────────────────────

const TAG = '[SandboxSessionManager]';
const GRPC_PORT = 50051;
const HEALTH_CHECK_TIMEOUT_MS = 10_000;
/** Safety limit for iterative queue draining to prevent unbounded loops. */
const MAX_DRAIN_ITERATIONS = 100;
/** Default timeout for a single gRPC deliverTurn stream (5 minutes). */
const DEFAULT_TURN_TIMEOUT_MS = 5 * 60 * 1000;

// ── Helpers ────────────────────────────────────────────────────

/** First 12 hex chars of SHA-256 of the input string. */
function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 12);
}

/** Deterministic container name for a conversation (fallback when not stored in DB). */
function sessionContainerName(conversationId: string): string {
  return `ctxmill-session-${shortHash(conversationId)}`;
}

/**
 * Poll a container's gRPC endpoint until it responds or the timeout is reached.
 * A ConnectError response (any gRPC error code) means the server is up.
 * A network-level error (ECONNREFUSED etc.) means the server is not ready.
 */
interface ReadyClient {
  transport: ReturnType<typeof createGrpcTransport>;
  grpcClient: ReturnType<typeof createClient<typeof HarnessService>>;
}

async function waitForContainerReady(baseUrl: string, timeoutMs = HEALTH_CHECK_TIMEOUT_MS): Promise<ReadyClient> {
  const transport = createGrpcTransport({ baseUrl });
  const grpcClient = createClient(HarnessService, transport);
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      await grpcClient.killSession(
        create(KillSessionRequestSchema, { sessionId: 'probe', reason: 'probe' }),
      );
      // Unexpected success — server is up and (somehow) accepted the probe
      return { transport, grpcClient };
    } catch (err) {
      if (err instanceof ConnectError) {
        // gRPC server responded with an error code — server is alive
        return { transport, grpcClient };
      }
      // Network-level error — server not ready yet
    }
    await new Promise<void>((r) => setTimeout(r, 500));
  }

  throw new Error(`Container health check timed out after ${timeoutMs}ms at ${baseUrl}`);
}

async function retryGrpcCall<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  delayMs: number,
): Promise<T> {
  return retryWithBackoff(fn, {
    delays: Array.from({ length: maxRetries }, (_, i) => delayMs * (i + 1)),
    shouldRetry: (err) =>
      !(err instanceof ConnectError && err.code !== Code.Unavailable),
  });
}

function unrefTimer(timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>): void {
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
    timer.unref();
  }
}

/** Convert an orchestrator Message to the proto-compatible shape for gRPC calls. */
function toProtoMessages(messages: Message[]): Array<{
  id: string;
  role: string;
  content: string;
  toolCallId?: string;
  toolCalls: Array<{ id: string; name: string; argumentsJson: string }>;
}> {
  return messages.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    ...(m.toolCallId !== undefined ? { toolCallId: m.toolCallId } : {}),
    toolCalls:
      m.toolCalls?.map((tc) => ({
        id: tc.id,
        name: tc.name,
        argumentsJson: JSON.stringify(tc.arguments),
      })) ?? [],
  }));
}

// ── SandboxSessionManager ──────────────────────────────────────

export class SandboxSessionManager {
  private readonly containerManager: ContainerManager;
  private readonly db: DatabaseRepository;
  private readonly lifecyclePolicy: ContainerLifecyclePolicy;
  private readonly interruptManager: InterruptManager | undefined;
  private readonly sandboxSecrets: Readonly<Record<string, string>>;
  private readonly resolveToolsForAgent: (toolNames: string[]) => ToolMetadata[];
  private readonly logger: Logger;
  private readonly config: {
    idleTimeoutMs: number;
    maxQueuedMessages: number;
    turnTimeoutMs?: number;
  };
  private readonly dataDir: string | undefined;
  private readonly workspaceDiffService: WorkspaceDiffService;

  /** In-memory cache: conversationId → SessionRecord */
  private readonly sessions = new Map<string, SessionRecord>();

  /** Per-session queues for buffered turns: sessionId → TurnQueueEntry[] */
  private readonly turnQueues = new Map<string, TurnQueueEntry[]>();

  /** Sessions that currently have an in-flight gRPC turn */
  private readonly activeTurns = new Set<string>();

  /** Cached agent definitions for turn-retry recovery: conversationId → AgentDefinition */
  private readonly agentDefs = new Map<string, AgentDefinition>();

  constructor(deps: SandboxSessionManagerDeps) {
    this.containerManager = deps.containerManager;
    this.db = deps.db;
    this.lifecyclePolicy = deps.lifecyclePolicy;
    this.interruptManager = deps.interruptManager;
    this.sandboxSecrets = deps.sandboxSecrets ?? {};
    this.resolveToolsForAgent = deps.resolveToolsForAgent ?? (() => []);
    this.logger = deps.logger;
    this.config = deps.config;
    this.dataDir = deps.dataDir;
    this.workspaceDiffService = deps.workspaceDiffService;
  }

  // ── Session lifecycle ──────────────────────────────────────────

  /**
   * Ensure a ready session for a conversation.
   *
   * Decision tree:
   *  1. In-memory cache hit (ACTIVE) → return immediately.
   *  2. DB miss → create a fresh container + OpenSession(FreshBootstrap).
   *  3. DB ACTIVE → reconnect gRPC client (container may still be running).
   *  4. DB FROZEN → docker unpause + reconnect gRPC.
   *  5. DB CHECKPOINTED → create container + OpenSession(RestoreBootstrap).
   *  6. DB RESTORING → throw; caller should retry later.
   */
  async ensureSession(
    conversationId: string,
    agentDef: AgentDefinition,
    agentId?: string,
  ): Promise<SessionRecord> {
    this.agentDefs.set(conversationId, agentDef);

    // 1. In-memory cache
    const cached = this.sessions.get(conversationId);
    if (cached && cached.status === 'ACTIVE') {
      return cached;
    }

    // 2. DB lookup
    const dbSession = await this.db.getSandboxSessionByConversation(conversationId);
    if (!dbSession) {
      return this.createFreshSession(conversationId, agentDef, agentId);
    }

    switch (dbSession.status) {
      case 'ACTIVE': {
        try {
          const record = await this.reconnectToContainer(dbSession);
          this.sessions.set(conversationId, record);
          return record;
        } catch (err) {
          return this.recoverDeadSession(dbSession, conversationId, agentDef, agentId, 'reconnect', err);
        }
      }
      case 'FROZEN': {
        try {
          const record = await this.unfreezeContainer(dbSession);
          this.sessions.set(conversationId, record);
          return record;
        } catch (err) {
          return this.recoverDeadSession(dbSession, conversationId, agentDef, agentId, 'unfreeze', err);
        }
      }
      case 'CHECKPOINTED': {
        const record = await this.restoreFromCheckpoint(dbSession, agentDef);
        this.sessions.set(conversationId, record);
        return record;
      }
      case 'RESTORING': {
        throw new Error(
          `Session ${dbSession.id} for conversation ${conversationId} is currently being restored. Try again shortly.`,
        );
      }
      default: {
        this.logger.warn(
          `${TAG} unknown status '${dbSession.status}' for session ${dbSession.id}, creating fresh session`,
        );
        return this.createFreshSession(conversationId, agentDef, agentId);
      }
    }
  }

  /**
   * Cache a reconnected session record. Called by ContainerLifecyclePolicy
   * during reconciliation when a live container is found for a DB session.
   */
  onSessionReconnected(conversationId: string, record: SessionRecord): void {
    this.sessions.set(conversationId, record);
  }

  /**
   * Evict a session from in-memory caches. Called by ContainerLifecyclePolicy
   * during reconciliation when a container is detected as dead.
   */
  onSessionEvicted(sessionId: string, conversationId: string): void {
    this.sessions.delete(conversationId);
    this.agentDefs.delete(conversationId);
    this.turnQueues.delete(sessionId);
    this.activeTurns.delete(sessionId);
  }

  // ── Turn delivery with coalescing ──────────────────────────────

  /**
   * Deliver messages as a turn to a session, with per-session coalescing.
   *
   * If a turn is already in-flight:
   *   – Messages are buffered in a per-session queue.
   *   – The caller's generator blocks until the in-flight turn completes,
   *     at which point all buffered messages are coalesced into one turn
   *     and events are broadcast to every waiting caller.
   *
   * If no turn is in-flight:
   *   – Messages are delivered to the container via gRPC immediately.
   *   – On completion, the queue is drained (recursive coalescing).
   */
  async *deliverTurn(
    sessionId: string,
    messages: Message[],
    turnId: string,
  ): AsyncGenerator<CustomSessionEvent> {
    if (this.activeTurns.has(sessionId)) {
      // Turn in-flight — buffer and wait
      const queue = this.getOrCreateQueue(sessionId);
      if (queue.length >= this.config.maxQueuedMessages) {
        throw new Error(
          `Session ${sessionId} turn queue is full (max=${this.config.maxQueuedMessages})`,
        );
      }
      const channel = new AsyncChannel<CustomSessionEvent>();
      queue.push({ messages, turnId, channel });
      this.logger.debug(
        `${TAG} session ${sessionId}: buffering turn ${turnId} (queue depth: ${queue.length})`,
      );
      yield* channel.generator();
      return;
    }

    // No turn in-flight — deliver immediately
    this.activeTurns.add(sessionId);
    try {
      yield* this.executeDeliverTurn(sessionId, messages, turnId);
    } finally {
      this.activeTurns.delete(sessionId);
      // Drain any messages that buffered during this turn
      await this.drainCoalescedQueue(sessionId);
    }
  }

  // ── State management ───────────────────────────────────────────

  /**
   * Suspend a session by calling the gRPC SuspendSession RPC.
   * Persists the returned checkpoint to the database and marks the session CHECKPOINTED.
   */
  async suspendSession(sessionId: string, reason: string): Promise<SessionCheckpoint> {
    const record = this.findSessionById(sessionId);
    if (!record) {
      throw new Error(`Session ${sessionId} not found in active sessions`);
    }

    this.logger.info(`${TAG} suspending session ${sessionId} (reason=${reason})`);

    const response = await record.grpcClient.suspendSession(
      create(SuspendSessionRequestSchema, { sessionId, reason }),
    );

    const checkpoint: SessionCheckpoint | undefined = response.sessionCheckpoint;
    if (!checkpoint) {
      throw new Error(`SuspendSession response missing sessionCheckpoint for session ${sessionId}`);
    }

    let workspaceRef = 'none';
    try {
      workspaceRef = await this.workspaceDiffService.capture(sessionId, record.containerId);
      this.logger.info(`${TAG} workspace captured for session ${sessionId}: ${workspaceRef}`);
    } catch (err) {
      this.logger.warn(
        `${TAG} workspace capture failed for session ${sessionId}, continuing without workspace snapshot:`,
        err,
      );
    }

    await this.db.createCheckpointV2({
      sessionId,
      agentId: record.agentId,
      checkpointData: {
        harnessName: record.harnessName,
        conversationId: record.conversationId,
        checkpointVersion: checkpoint.checkpointVersion,
        sessionId: checkpoint.sessionId,
      },
      harnessState: checkpoint.harnessState as Record<string, unknown> | undefined,
      workspaceRef,
      suspendReason: reason,
    });

    await this.db.updateSandboxSessionStatus(sessionId, 'CHECKPOINTED');
    record.status = 'CHECKPOINTED';

    this.logger.info(`${TAG} session ${sessionId} suspended`);
    return checkpoint;
  }

  /**
   * Kill a session: call the gRPC KillSession RPC (best-effort), stop and
   * remove the Docker container, then delete the DB record and in-memory cache.
   */
  async killSession(sessionId: string): Promise<void> {
    const record = this.findSessionById(sessionId);
    this.logger.info(`${TAG} killing session ${sessionId}`);

    // Cancel any pending lifecycle timers before tearing down the session.
    // Without this, a scheduled idle-freeze timer can fire after the session
    // is removed from our maps, causing "Session X not found" errors.
    await this.lifecyclePolicy.cancelIdleTimeout(sessionId);
    await this.lifecyclePolicy.cancelPause(sessionId);

    if (record?.grpcClient) {
      try {
        await record.grpcClient.killSession(
          create(KillSessionRequestSchema, { sessionId, reason: 'killed' }),
        );
      } catch (err) {
        this.logger.warn(`${TAG} KillSession RPC failed for session ${sessionId}:`, err);
      }
    }

    if (record?.containerId) {
      try {
        await this.containerManager.stopContainer(record.containerId, 10);
        await this.containerManager.removeContainer(record.containerId, true);
      } catch (err) {
        this.logger.warn(`${TAG} container cleanup failed for session ${sessionId}:`, err);
      }
    }

    if (record?.sessionWorkspaceDir) {
      try {
        const sessionDir = resolve(record.sessionWorkspaceDir, '..');
        await cleanupSession(sessionDir);
        this.logger.debug(`${TAG} cleaned up session workspace for ${sessionId}`);
      } catch (err) {
        this.logger.warn(`${TAG} session workspace cleanup failed for ${sessionId}:`, err);
      }
    }

    await this.db.deleteSandboxSession(sessionId);
    if (record) {
      this.sessions.delete(record.conversationId);
      this.agentDefs.delete(record.conversationId);
    }
    this.turnQueues.delete(sessionId);
    this.activeTurns.delete(sessionId);

    this.logger.info(`${TAG} session ${sessionId} killed`);
  }

  /**
   * Freeze a session by pausing its Docker container.
   * Used to free CPU for idle sessions while preserving full in-memory state.
   */
  async freezeSession(sessionId: string): Promise<void> {
    const record = this.findSessionById(sessionId);
    if (!record) {
      throw new Error(`Session ${sessionId} not found`);
    }
    this.logger.info(`${TAG} freezing session ${sessionId}`);
    await this.containerManager.pauseContainer(record.containerId);
    await this.db.updateSandboxSessionStatus(sessionId, 'FROZEN');
    record.status = 'FROZEN';
    this.logger.info(`${TAG} session ${sessionId} frozen`);
  }

  /**
   * Unfreeze a session by unpausing its Docker container.
   */
  async unfreezeSession(sessionId: string): Promise<void> {
    const record = this.findSessionById(sessionId);
    if (!record) {
      throw new Error(`Session ${sessionId} not found`);
    }
    this.logger.info(`${TAG} unfreezing session ${sessionId}`);
    await this.containerManager.unpauseContainer(record.containerId);
    await this.db.updateSandboxSessionStatus(sessionId, 'ACTIVE');
    record.status = 'ACTIVE';
    this.logger.info(`${TAG} session ${sessionId} unfrozen`);
  }

  async resumeWithInterruptResolution(
    sessionId: string,
    runId: string,
    agentId: string,
  ): Promise<void> {
    this.logger.info(
      `${TAG} resuming session ${sessionId} with interrupt resolution (run=${runId}, agent=${agentId})`,
    );

    const dbSession = await this.db.getSandboxSession(sessionId);
    if (!dbSession) {
      throw new Error(`Session ${sessionId} not found in database`);
    }

    const conversationId = dbSession.conversationId;
    let agentDef = this.agentDefs.get(conversationId);
    if (!agentDef) {
      const minimalAgentDef: AgentDefinition = {
        name: agentId,
        harness: dbSession.harnessName,
        harnessConfig: {},
        tools: [],
        systemPrompt: '',
      };
      agentDef = minimalAgentDef;
      this.agentDefs.set(conversationId, agentDef);
    }

    const record = await this.ensureSession(conversationId, agentDef, agentId);

    const resolvedInterrupts = await this.db.getResolvedInterruptsForSession(sessionId);
    const interrupt = resolvedInterrupts.find((entry) => entry.runId === runId);
    if (!interrupt) {
      this.logger.warn(
        `${TAG} no resolved interrupt matching runId=${runId} for session ${sessionId} (found ${resolvedInterrupts.length} other interrupts), skipping continuation turn`,
      );
      return;
    }

    const elapsed = interrupt.resolvedAt != null
      ? this.formatElapsed(interrupt.createdAt, interrupt.resolvedAt)
      : 'unknown';
    const decision = interrupt.resolvedAction === 'approve'
      ? 'APPROVED'
      : interrupt.resolvedAction === 'timeout'
        ? 'TIMED OUT'
        : 'REJECTED';
    const requestSummary = typeof interrupt.args === 'object' && interrupt.args !== null
      ? interrupt.args.reason ?? JSON.stringify(interrupt.args)
      : String(interrupt.args);

    const continuationContent = [
      '[HITL Resolution] Your previous approval request has been resolved.',
      '',
      `Tool: ${interrupt.toolName}`,
      `Request: ${String(requestSummary)}`,
      `Decision: ${decision}`,
      ...(interrupt.resolvedData != null
        ? [
            `Reviewer data: ${typeof interrupt.resolvedData === 'string' ? interrupt.resolvedData : JSON.stringify(interrupt.resolvedData)}`,
          ]
        : []),
      `Time elapsed: ${elapsed}`,
      '',
      decision === 'APPROVED'
        ? 'Continue with the approved action.'
        : decision === 'TIMED OUT'
          ? 'The approval request timed out. Handle this gracefully.'
          : 'The request was rejected. Do not proceed with the rejected action.',
    ].join('\n');

    const continuationMessage: Message = {
      id: `hitl-resume-${randomUUID().slice(0, 8)}`,
      agentId,
      role: 'system',
      content: continuationContent,
      createdAt: new Date(),
    };

    const turnId = `hitl-resume-${runId.slice(0, 8)}-${Date.now()}`;
    this.logger.info(
      `${TAG} delivering continuation turn ${turnId} for session ${record.sessionId}`,
    );

    for await (const _event of this.deliverTurn(record.sessionId, [continuationMessage], turnId)) {}

    this.logger.info(
      `${TAG} continuation turn ${turnId} completed for session ${record.sessionId}`,
    );
  }

  private formatElapsed(startMs: number, endMs: number): string {
    const totalSec = Math.floor((endMs - startMs) / 1000);
    const days = Math.floor(totalSec / 86400);
    const hours = Math.floor((totalSec % 86400) / 3600);
    const minutes = Math.floor((totalSec % 3600) / 60);

    const parts: string[] = [];
    if (days > 0) parts.push(`${days} day${days !== 1 ? 's' : ''}`);
    if (hours > 0) parts.push(`${hours} hour${hours !== 1 ? 's' : ''}`);
    if (minutes > 0) parts.push(`${minutes} minute${minutes !== 1 ? 's' : ''}`);
    return parts.length > 0 ? parts.join(', ') : 'less than a minute';
  }

  // ── Queries ────────────────────────────────────────────────────

  async getSession(conversationId: string): Promise<SessionRecord | null> {
    const cached = this.sessions.get(conversationId);
    if (cached) return cached;

    const dbSession = await this.db.getSandboxSessionByConversation(conversationId);
    if (!dbSession) return null;
    return this.dbSessionToRecord(dbSession);
  }

  async getActiveSessions(): Promise<SessionRecord[]> {
    const rows = await this.db.getActiveSandboxSessions();
    return rows.map((r) => this.dbSessionToRecord(r));
  }

  async getSessionsByAgent(agentId: string): Promise<SessionRecord[]> {
    const rows = await this.db.getSandboxSessionsByAgent(agentId);
    return rows.map((r) => this.dbSessionToRecord(r));
  }

  // ── Private — session creation / restoration ───────────────────

  private async createFreshSession(
    conversationId: string,
    agentDef: AgentDefinition,
    agentId?: string,
  ): Promise<SessionRecord> {
    const harnessName = agentDef.harness ?? 'langgraph';
    const sessionId = randomUUID();

    this.logger.info(
      `${TAG} creating fresh session ${sessionId} for conversation ${conversationId} (harness=${harnessName})`,
    );

    let workspaceDir = agentDef.workspaceDir;
    let sessionWorkspaceDir: string | undefined;

    if (this.dataDir && agentDef.workspaceDir) {
      const effectiveAgentId = agentId ?? agentDef.name;
      const sessionDir = getSessionDir(this.dataDir, effectiveAgentId, sessionId);
      await copyBaseToSession(agentDef.workspaceDir, sessionDir);
      sessionWorkspaceDir = getSessionWorkspacePath(this.dataDir, effectiveAgentId, sessionId);
      workspaceDir = sessionWorkspaceDir;

      this.logger.debug(`${TAG} created session workspace at ${sessionWorkspaceDir}`);
    }

    // Create and start the container
    const containerInfo = await this.containerManager.createContainer({
      runId: sessionId,
      agentId: agentId ?? agentDef.name,
      harnessName,
      workspaceDir,
      cpus: agentDef.resourceLimits?.cpus,
      memoryMb: agentDef.resourceLimits?.memoryMb,
      pidsLimit: agentDef.resourceLimits?.pidsLimit,
      timeoutSec: agentDef.resourceLimits?.timeoutSec,
      ...(Object.keys(this.sandboxSecrets).length > 0 && { secrets: { ...this.sandboxSecrets } }),
    });

    await this.containerManager.startContainer(containerInfo.containerId);

    const baseUrl = `http://${containerInfo.containerName}:${GRPC_PORT}`;
    this.logger.debug(`${TAG} waiting for container at ${baseUrl}`);
    const { grpcClient } = await waitForContainerReady(baseUrl);

    const openReq = create(OpenSessionRequestSchema, {
      bootstrap: {
        case: 'fresh',
        value: {
          agentId: agentId ?? agentDef.name,
          conversationId,
          harnessName,
          harnessConfigJson: JSON.stringify(agentDef.harnessConfig),
          systemPrompt: agentDef.systemPrompt,
          workspaceDir: workspaceDir ?? '/workspace',
          tools: this.resolveToolsForAgent(agentDef.tools ?? []),
        },
      },
    });

    this.logger.debug(`${TAG} opening session on container ${containerInfo.containerName}`);
    await retryGrpcCall(() => grpcClient.openSession(openReq), 5, 1000);

    // Persist to DB
    const dbSession = await this.db.createSandboxSession({
      id: sessionId,
      conversationId,
      agentId: agentId ?? agentDef.name,
      containerName: containerInfo.containerName,
      containerId: containerInfo.containerId,
      harnessName,
      status: 'ACTIVE',
    });

    const record: SessionRecord = {
      sessionId: dbSession.id,
      conversationId,
      agentId: agentId ?? agentDef.name,
      containerName: containerInfo.containerName,
      containerId: containerInfo.containerId,
      status: 'ACTIVE',
      harnessName,
      grpcClient,
      sessionWorkspaceDir,
    };

    this.sessions.set(conversationId, record);
    this.logger.info(`${TAG} session ${sessionId} created and ready`);
    return record;
  }

  private async reconnectToContainer(dbSession: SandboxSessionRow): Promise<SessionRecord> {
    const containerName = dbSession.containerName ?? sessionContainerName(dbSession.conversationId);
    const baseUrl = `http://${containerName}:${GRPC_PORT}`;

    this.logger.info(
      `${TAG} reconnecting to container ${containerName} for session ${dbSession.id}`,
    );

    const { grpcClient } = await waitForContainerReady(baseUrl);

    const sessionWorkspaceDir = await this.getExistingSessionWorkspaceDir(dbSession.agentId, dbSession.id);

    return {
      sessionId: dbSession.id,
      conversationId: dbSession.conversationId,
      agentId: dbSession.agentId,
      containerName,
      containerId: dbSession.containerId ?? '',
      status: 'ACTIVE',
      harnessName: dbSession.harnessName,
      grpcClient,
      sessionWorkspaceDir,
    };
  }

  private async unfreezeContainer(dbSession: SandboxSessionRow): Promise<SessionRecord> {
    const containerName = dbSession.containerName ?? sessionContainerName(dbSession.conversationId);
    const containerId = dbSession.containerId ?? '';

    this.logger.info(
      `${TAG} unfreezing container ${containerName} for session ${dbSession.id}`,
    );

    await this.containerManager.unpauseContainer(containerId);
    await this.db.updateSandboxSessionStatus(dbSession.id, 'ACTIVE');

    const baseUrl = `http://${containerName}:${GRPC_PORT}`;
    const { grpcClient } = await waitForContainerReady(baseUrl);

    const sessionWorkspaceDir = await this.getExistingSessionWorkspaceDir(dbSession.agentId, dbSession.id);

    return {
      sessionId: dbSession.id,
      conversationId: dbSession.conversationId,
      agentId: dbSession.agentId,
      containerName,
      containerId,
      status: 'ACTIVE',
      harnessName: dbSession.harnessName,
      grpcClient,
      sessionWorkspaceDir,
    };
  }

  private async restoreFromCheckpoint(
    dbSession: SandboxSessionRow,
    agentDef: AgentDefinition,
  ): Promise<SessionRecord> {
    const harnessName = dbSession.harnessName;
    const sessionId = dbSession.id;

    this.logger.info(`${TAG} restoring session ${sessionId} from checkpoint`);

    // Mark as RESTORING to block concurrent restore attempts
    await this.db.updateSandboxSessionStatus(sessionId, 'RESTORING');

    try {
      // Load the latest checkpoint
      const checkpoint = await this.db.getCheckpointV2(sessionId);
      if (!checkpoint) {
        throw new Error(`No checkpoint found for session ${sessionId}`);
      }

      const workspaceDir = agentDef.workspaceDir;

      // Spin up a fresh container
      const containerInfo = await this.containerManager.createContainer({
        runId: sessionId,
        agentId: agentDef.name,
        harnessName,
        workspaceDir,
        cpus: agentDef.resourceLimits?.cpus,
        memoryMb: agentDef.resourceLimits?.memoryMb,
        pidsLimit: agentDef.resourceLimits?.pidsLimit,
        timeoutSec: agentDef.resourceLimits?.timeoutSec,
        ...(Object.keys(this.sandboxSecrets).length > 0 && { secrets: { ...this.sandboxSecrets } }),
      });

      await this.containerManager.startContainer(containerInfo.containerId);

      try {
        await this.workspaceDiffService.restore(sessionId, containerInfo.containerId);
        this.logger.info(`${TAG} workspace restored for session ${sessionId}`);
      } catch (err) {
        this.logger.warn(
          `${TAG} workspace restore failed for session ${sessionId}, continuing with base workspace:`,
          err,
        );
      }

      const baseUrl = `http://${containerInfo.containerName}:${GRPC_PORT}`;
      const { grpcClient } = await waitForContainerReady(baseUrl);

      const openReq = create(OpenSessionRequestSchema, {
        bootstrap: {
          case: 'restore',
          value: {
            sessionCheckpoint: {
              checkpointVersion: checkpoint.checkpointVersion,
              sessionId,
              conversationId: dbSession.conversationId,
              harnessName,
              harnessState: (checkpoint.harnessState ?? {}) as JsonObject,
            },
          },
        },
      });

      await grpcClient.openSession(openReq);

      await this.db.updateSandboxSessionStatus(sessionId, 'ACTIVE', {
        containerName: containerInfo.containerName,
        containerId: containerInfo.containerId,
      });

      const record: SessionRecord = {
        sessionId,
        conversationId: dbSession.conversationId,
        agentId: dbSession.agentId,
        containerName: containerInfo.containerName,
        containerId: containerInfo.containerId,
        status: 'ACTIVE',
        harnessName,
        grpcClient,
        sessionWorkspaceDir: undefined,
      };

      this.logger.info(`${TAG} session ${sessionId} restored from checkpoint`);
      return record;
    } catch (err) {
      // Restore failed — revert so a retry can attempt again
      await this.db.updateSandboxSessionStatus(sessionId, 'CHECKPOINTED');
      throw err;
    }
  }

  /**
   * Recover from a dead container when ensureSession finds ACTIVE or FROZEN
   * status but the container is unreachable.
   *
   * Recovery strategy:
   *  1. If a checkpoint exists → mark CHECKPOINTED and restore from it.
   *  2. If no checkpoint → create a fresh session (harness state lost).
   */
  private async recoverDeadSession(
    dbSession: SandboxSessionRow,
    conversationId: string,
    agentDef: AgentDefinition,
    agentId: string | undefined,
    failedOp: string,
    err: unknown,
  ): Promise<SessionRecord> {
    this.logger.warn(
      `${TAG} ${failedOp} failed for session ${dbSession.id}, attempting recovery`,
      err instanceof Error ? err.message : err,
    );

    const checkpoint = await this.db.getCheckpointV2(dbSession.id);
    if (checkpoint) {
      this.logger.info(
        `${TAG} checkpoint found for session ${dbSession.id}, restoring from checkpoint`,
      );
      await this.db.updateSandboxSessionStatus(dbSession.id, 'CHECKPOINTED');
      const record = await this.restoreFromCheckpoint(dbSession, agentDef);
      this.sessions.set(conversationId, record);
      return record;
    }

    this.logger.warn(
      `${TAG} no checkpoint for session ${dbSession.id}, creating fresh session`,
    );
    return this.createFreshSession(conversationId, agentDef, agentId);
  }

  // ── Private — turn delivery internals ─────────────────────────

  private async *executeDeliverTurn(
    sessionId: string,
    messages: Message[],
    turnId: string,
    _retried = false,
  ): AsyncGenerator<CustomSessionEvent> {
    const record = this.findSessionById(sessionId);
    if (!record) {
      throw new Error(`Session ${sessionId} not found for turn delivery`);
    }

    // Cancel any pending idle freeze so the container stays running
    await this.lifecyclePolicy.cancelIdleTimeout(sessionId);
    await this.lifecyclePolicy.cancelPause(sessionId);

    // Defensive: ensure container is actually unpaused. After an orchestrator
    // restart, in-memory lifecycle state is lost but containers may still be
    // Docker-paused, which would cause the gRPC stream to hang indefinitely.
    try {
      await this.containerManager.unpauseContainer(record.containerId);
    } catch {
      // Best-effort — container may not be paused or may not exist
    }

    this.logger.debug(
      `${TAG} delivering turn ${turnId} to session ${sessionId} (${messages.length} message(s))`,
    );

    const request = create(DeliverTurnRequestSchema, {
      sessionId,
      turnId,
      messages: toProtoMessages(messages),
    });

    try {
      const stream: AsyncIterable<ProtoSessionEvent> = record.grpcClient.deliverTurn(request);
      const turnTimeout = this.config.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
      const abortController = new AbortController();
      let timeoutId: ReturnType<typeof setTimeout> | undefined = setTimeout(
        () => abortController.abort(),
        turnTimeout,
      );
      unrefTimer(timeoutId);
      let hitlActive = false;

      try {
        const iterator = stream[Symbol.asyncIterator]();
        const timeoutError = () =>
          new Error(`Turn ${turnId} timed out after ${turnTimeout}ms for session ${sessionId}`);
        const waitForNext = async () => {
          let onAbort: (() => void) | null = null;
          const onAbortError = new Promise<never>((_, reject) => {
            const listener = () => {
              reject(timeoutError());
            };
            onAbort = listener;

            if (abortController.signal.aborted) {
              listener();
              return;
            }

            abortController.signal.addEventListener('abort', listener, { once: true });
          });

          try {
            return await Promise.race<IteratorResult<ProtoSessionEvent>>([
              iterator.next(),
              onAbortError,
            ]);
          } finally {
            if (onAbort) {
              abortController.signal.removeEventListener('abort', onAbort);
            }
          }
        };

        while (true) {
          const next = await waitForNext();
          if (next.done) {
            break;
          }

          const event = next.value;
          const converted = protoSessionEventToCustom(event, turnId);
          if (converted) {
            // HITL timeout management: cancel turn timeout during HITL wait
            // so it doesn't race with the InterruptManager's approval timeout.
            // Re-arm when events resume after approval is delivered.
            if (converted.type === 'ag_ui_event' && converted.event.type === 'HITL_PAUSE') {
              if (timeoutId !== undefined) {
                clearTimeout(timeoutId);
                timeoutId = undefined;
              }
              hitlActive = true;
              this.interruptManager?.cancelTimeoutForSession(sessionId);
              void Promise.resolve()
                .then(() => this.lifecyclePolicy.schedulePause(sessionId, record.containerId))
                .catch((err) => {
                  this.logger.warn(`${TAG} failed to schedule Docker pause for session ${sessionId}:`, err);
                });
              this.logger.debug(
                `${TAG} HITL_PAUSE detected for session ${sessionId}, turn timeout suspended, Docker pause scheduled`,
              );
            } else if (hitlActive) {
              hitlActive = false;
              await this.lifecyclePolicy.cancelPause(sessionId);
              timeoutId = setTimeout(() => abortController.abort(), turnTimeout);
              unrefTimer(timeoutId);
              this.logger.debug(
                `${TAG} HITL resolved for session ${sessionId}, container unpaused, turn timeout re-armed`,
              );
            }

            yield converted;
          }
        }
      } finally {
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId);
        }
      }
    } catch (err) {
      const agentDef = this.agentDefs.get(record.conversationId);
      if (this.isStaleContainerError(err) && agentDef && !_retried) {
        this.logger.warn(
          `${TAG} stale container for session ${sessionId}, recovering and retrying turn`,
        );
        this.sessions.delete(record.conversationId);
        await this.db.updateSandboxSessionStatus(sessionId, 'TERMINATED');
        const newRecord = await this.ensureSession(record.conversationId, agentDef, record.agentId);
        yield* this.executeDeliverTurn(newRecord.sessionId, messages, turnId, true);
        return;
      }
      throw err;
    }

    await this.db.updateSandboxSessionStatus(sessionId, 'ACTIVE');
    this.lifecyclePolicy.scheduleIdleTimeout(sessionId, record.containerId, {
      onFreeze: (sid) => this.freezeSession(sid),
      onCheckpoint: async (sid) => {
        await this.suspendSession(sid, 'idle-checkpoint');
      },
      onContainerGone: async (sid) => {
        this.logger.warn(`${TAG} container gone for session ${sid}, marking TERMINATED`);
        const rec = this.findSessionById(sid);
        if (rec) {
          await this.db.updateSandboxSessionStatus(sid, 'TERMINATED');
          this.sessions.delete(rec.conversationId);
          this.agentDefs.delete(rec.conversationId);
        }
        this.turnQueues.delete(sid);
        this.activeTurns.delete(sid);
      },
    });

    this.logger.debug(`${TAG} turn ${turnId} completed for session ${sessionId}`);
  }

  /**
   * Drain the per-session turn queue by coalescing all buffered entries into
   * one gRPC turn and broadcasting each SessionEvent to every waiting caller.
   * Iterates until the queue is empty or the safety limit is reached.
   */
  private async drainCoalescedQueue(sessionId: string): Promise<void> {
    let iterations = 0;
    while (iterations < MAX_DRAIN_ITERATIONS) {
      const queue = this.turnQueues.get(sessionId);
      if (!queue || queue.length === 0) return;

      iterations++;
      const coalesced = queue.splice(0);
      const mergedMessages = coalesced.flatMap((e) => e.messages);
      const coalescedTurnId = `coalesced-${randomUUID().slice(0, 8)}`;

      this.logger.debug(
        `${TAG} coalescing ${coalesced.length} buffered turn(s) → ${coalescedTurnId} (session ${sessionId})`,
      );

      this.activeTurns.add(sessionId);
      try {
        for await (const event of this.executeDeliverTurn(sessionId, mergedMessages, coalescedTurnId)) {
          for (const entry of coalesced) {
            entry.channel.push(event);
          }
        }
        for (const entry of coalesced) {
          entry.channel.close();
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        for (const entry of coalesced) {
          entry.channel.fail(error);
        }
      } finally {
        this.activeTurns.delete(sessionId);
      }
    }

    if (iterations >= MAX_DRAIN_ITERATIONS) {
      this.logger.warn(
        `${TAG} drain loop hit safety limit (${MAX_DRAIN_ITERATIONS}) for session ${sessionId} — remaining items dropped`,
      );
      const remaining = this.turnQueues.get(sessionId);
      if (remaining) {
        const error = new Error(`Turn queue drain exceeded ${MAX_DRAIN_ITERATIONS} iterations`);
        for (const entry of remaining.splice(0)) {
          entry.channel.fail(error);
        }
      }
    }
  }

  // ── Private — utilities ────────────────────────────────────────

  private getOrCreateQueue(sessionId: string): TurnQueueEntry[] {
    let queue = this.turnQueues.get(sessionId);
    if (!queue) {
      queue = [];
      this.turnQueues.set(sessionId, queue);
    }
    return queue;
  }

  /** Linear scan over in-memory sessions to find by sessionId. */
  public findSessionById(sessionId: string): SessionRecord | undefined {
    for (const record of this.sessions.values()) {
      if (record.sessionId === sessionId) {
        return record;
      }
    }
    return undefined;
  }

  private isStaleContainerError(err: unknown): boolean {
    if (err instanceof ConnectError && err.code === Code.Unavailable) return true;
    if (err instanceof Error && /ENOTFOUND|ECONNREFUSED|ECONNRESET/.test(err.message)) return true;
    return false;
  }

  /** Convert a DB row to a SessionRecord without a gRPC client (queries only). */
  private dbSessionToRecord(row: SandboxSessionRow): SessionRecord {
    return {
      sessionId: row.id,
      conversationId: row.conversationId,
      agentId: row.agentId,
      containerName: row.containerName ?? '',
      containerId: row.containerId ?? '',
      status: (row.status as SessionRecord['status']) ?? 'ACTIVE',
      harnessName: row.harnessName,
    };
  }

  private async getExistingSessionWorkspaceDir(agentId: string, sessionId: string): Promise<string | undefined> {
    if (!this.dataDir) {
      return undefined;
    }

    const candidatePath = getSessionWorkspacePath(this.dataDir, agentId, sessionId);
    try {
      await fsPromises.access(candidatePath);
      return candidatePath;
    } catch {
      return undefined;
    }
  }
}
