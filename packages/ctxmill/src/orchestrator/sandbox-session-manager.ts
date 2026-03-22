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
 *  4. Startup recovery: reconcileOnStartup() compares DB records against live
 *     Docker containers and repairs any inconsistencies.
 */

import { createHash, randomUUID } from 'node:crypto';
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
import type { DatabaseRepository, SandboxSessionRow } from '../database/repository.js';
import type { PauseManager } from '../sandbox/pause-manager.js';
import { protoSessionEventToCustom } from '../sandbox/proto-convert.js';
import type { SessionEvent as CustomSessionEvent } from './sandbox-run-service.js';
import type { AgentDefinition, Message } from '../types.js';

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
  pauseManager: PauseManager;
  /** Allowlisted env-var secrets to inject into sandbox containers. */
  sandboxSecrets?: Readonly<Record<string, string>>;
  /** Resolves agent tool names to ToolMetadata for FreshBootstrap. */
  resolveToolsForAgent?: (toolNames: string[]) => ToolMetadata[];
  logger: Logger;
  config: {
    idleTimeoutMs: number;
    maxQueuedMessages: number;
  };
}

export interface SessionRecord {
  sessionId: string;
  conversationId: string;
  agentId: string;
  containerName: string;
  containerId: string;
  status: 'ACTIVE' | 'FROZEN' | 'CHECKPOINTED' | 'RESTORING';
  harnessName: string;
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

/**
 * Retry a gRPC call with exponential backoff. Retries only on network-level
 * errors (ECONNREFUSED, ECONNRESET). ConnectErrors (gRPC application errors)
 * are re-thrown immediately.
 */
async function retryGrpcCall<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  delayMs: number,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (err instanceof ConnectError && err.code !== Code.Unavailable) {
        throw err; // application-level gRPC error — don't retry
      }
      if (attempt < maxRetries) {
        await new Promise<void>((r) => setTimeout(r, delayMs * (attempt + 1)));
      }
    }
  }
  throw lastError;
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
  private readonly pauseManager: PauseManager;
  private readonly sandboxSecrets: Readonly<Record<string, string>>;
  private readonly resolveToolsForAgent: (toolNames: string[]) => ToolMetadata[];
  private readonly logger: Logger;
  private readonly config: { idleTimeoutMs: number; maxQueuedMessages: number };

  /** In-memory cache: conversationId → SessionRecord */
  private readonly sessions = new Map<string, SessionRecord>();

  /** Per-session queues for buffered turns: sessionId → TurnQueueEntry[] */
  private readonly turnQueues = new Map<string, TurnQueueEntry[]>();

  /** Sessions that currently have an in-flight gRPC turn */
  private readonly activeTurns = new Set<string>();

  constructor(deps: SandboxSessionManagerDeps) {
    this.containerManager = deps.containerManager;
    this.db = deps.db;
    this.pauseManager = deps.pauseManager;
    this.sandboxSecrets = deps.sandboxSecrets ?? {};
    this.resolveToolsForAgent = deps.resolveToolsForAgent ?? (() => []);
    this.logger = deps.logger;
    this.config = deps.config;
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
        const record = await this.reconnectToContainer(dbSession);
        this.sessions.set(conversationId, record);
        return record;
      }
      case 'FROZEN': {
        const record = await this.unfreezeContainer(dbSession);
        this.sessions.set(conversationId, record);
        return record;
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

    await this.db.deleteSandboxSession(sessionId);
    if (record) {
      this.sessions.delete(record.conversationId);
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

  // ── Startup recovery ───────────────────────────────────────────

  /**
   * Reconcile DB session records against live Docker containers on startup.
   *
   *  - ACTIVE/FROZEN session with running container → reconnect gRPC, cache in memory.
   *  - ACTIVE/FROZEN session with missing/stopped container:
   *      - Checkpoint exists → mark CHECKPOINTED.
   *      - No checkpoint → delete the session record.
   *  - Managed containers with no matching DB session record → remove (orphans).
   */
  async reconcileOnStartup(): Promise<void> {
    this.logger.info(`${TAG} reconciling sandbox sessions on startup`);

    const [dbSessions, liveContainers] = await Promise.all([
      this.db.getActiveSandboxSessions(),
      this.containerManager.listManagedContainers(),
    ]);

    // Index live containers by name for O(1) lookup
    const containerByName = new Map(liveContainers.map((c) => [c.containerName, c]));

    // Track which container names belong to known sessions
    const knownContainerNames = new Set<string>();
    let reconnected = 0;
    let markedCheckpointed = 0;
    let deleted = 0;

    for (const session of dbSessions) {
      const containerName = session.containerName ?? sessionContainerName(session.conversationId);
      knownContainerNames.add(containerName);

      const container = containerByName.get(containerName);
      const isAlive = container !== undefined
        && (container.status === 'running' || container.status === 'paused' || container.status === 'created');

      if (!isAlive) {
        // Container gone — check for checkpoint
        const checkpoint = await this.db.getCheckpointV2(session.id);
        if (checkpoint) {
          this.logger.info(
            `${TAG} session ${session.id}: container gone, checkpoint exists → CHECKPOINTED`,
          );
          await this.db.updateSandboxSessionStatus(session.id, 'CHECKPOINTED');
          markedCheckpointed++;
        } else {
          this.logger.info(
            `${TAG} session ${session.id}: container gone, no checkpoint → deleting`,
          );
          await this.db.deleteSandboxSession(session.id);
          deleted++;
        }
        continue;
      }

      // Container is alive — reconnect if ACTIVE (running), cache as FROZEN if paused
      if (session.status === 'ACTIVE' && container.status !== 'paused') {
        this.logger.info(
          `${TAG} session ${session.id}: container running, caching gRPC client`,
        );
        const baseUrl = `http://${containerName}:${GRPC_PORT}`;
        const { grpcClient } = await waitForContainerReady(baseUrl);

        const record: SessionRecord = {
          sessionId: session.id,
          conversationId: session.conversationId,
          agentId: session.agentId,
          containerName,
          containerId: session.containerId ?? container.containerId,
          status: 'ACTIVE',
          harnessName: session.harnessName,
          grpcClient,
        };
        this.sessions.set(session.conversationId, record);
        reconnected++;
      } else if (session.status === 'FROZEN' && container.status === 'paused') {
        this.logger.info(
          `${TAG} session ${session.id}: container paused (FROZEN), caching for lazy unfreeze`,
        );
        const record: SessionRecord = {
          sessionId: session.id,
          conversationId: session.conversationId,
          agentId: session.agentId,
          containerName,
          containerId: session.containerId ?? container.containerId,
          status: 'FROZEN',
          harnessName: session.harnessName,
        };
        this.sessions.set(session.conversationId, record);
        reconnected++;
      }
    }

    let orphansCleaned = 0;
    for (const container of liveContainers) {
      if (!knownContainerNames.has(container.containerName)) {
        this.logger.info(
          `${TAG} removing orphan container ${container.containerName} (${container.containerId})`,
        );
        try {
          await this.containerManager.stopContainer(container.containerId, 5);
          await this.containerManager.removeContainer(container.containerId, true);
          orphansCleaned++;
        } catch (err) {
          this.logger.warn(
            `${TAG} failed to remove orphan container ${container.containerName}:`,
            err,
          );
        }
      }
    }

    this.logger.info(
      `${TAG} reconciliation complete: reconnected=${reconnected}, markedCheckpointed=${markedCheckpointed}, deleted=${deleted}, orphansCleaned=${orphansCleaned}`,
    );
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

    // Create and start the container
    const containerInfo = await this.containerManager.createContainer({
      runId: sessionId,
      agentId: agentDef.name,
      harnessName,
      workspaceDir: agentDef.workspaceDir,
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
          agentId: agentDef.name,
          conversationId,
          harnessName,
          harnessConfigJson: JSON.stringify(agentDef.harnessConfig),
          systemPrompt: agentDef.systemPrompt,
          workspaceDir: agentDef.workspaceDir ?? '/workspace',
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
      agentId: agentDef.name,
      containerName: containerInfo.containerName,
      containerId: containerInfo.containerId,
      status: 'ACTIVE',
      harnessName,
      grpcClient,
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

    return {
      sessionId: dbSession.id,
      conversationId: dbSession.conversationId,
      agentId: dbSession.agentId,
      containerName,
      containerId: dbSession.containerId ?? '',
      status: 'ACTIVE',
      harnessName: dbSession.harnessName,
      grpcClient,
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

    return {
      sessionId: dbSession.id,
      conversationId: dbSession.conversationId,
      agentId: dbSession.agentId,
      containerName,
      containerId,
      status: 'ACTIVE',
      harnessName: dbSession.harnessName,
      grpcClient,
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

      // Spin up a fresh container
      const containerInfo = await this.containerManager.createContainer({
        runId: sessionId,
        agentId: agentDef.name,
        harnessName,
        workspaceDir: agentDef.workspaceDir,
        cpus: agentDef.resourceLimits?.cpus,
        memoryMb: agentDef.resourceLimits?.memoryMb,
        pidsLimit: agentDef.resourceLimits?.pidsLimit,
        timeoutSec: agentDef.resourceLimits?.timeoutSec,
        ...(Object.keys(this.sandboxSecrets).length > 0 && { secrets: { ...this.sandboxSecrets } }),
      });

      await this.containerManager.startContainer(containerInfo.containerId);

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
      };

      this.logger.info(`${TAG} session ${sessionId} restored from checkpoint`);
      return record;
    } catch (err) {
      // Restore failed — revert so a retry can attempt again
      await this.db.updateSandboxSessionStatus(sessionId, 'CHECKPOINTED');
      throw err;
    }
  }

  // ── Private — turn delivery internals ─────────────────────────

  private async *executeDeliverTurn(
    sessionId: string,
    messages: Message[],
    turnId: string,
  ): AsyncGenerator<CustomSessionEvent> {
    const record = this.findSessionById(sessionId);
    if (!record) {
      throw new Error(`Session ${sessionId} not found for turn delivery`);
    }

    // Cancel any pending idle freeze so the container stays running
    await this.pauseManager.cancelPause(sessionId);

    this.logger.debug(
      `${TAG} delivering turn ${turnId} to session ${sessionId} (${messages.length} message(s))`,
    );

    const request = create(DeliverTurnRequestSchema, {
      sessionId,
      turnId,
      messages: toProtoMessages(messages),
    });

    // Stream events from the container via gRPC
    const stream: AsyncIterable<ProtoSessionEvent> = record.grpcClient.deliverTurn(request);
    for await (const event of stream) {
      const converted = protoSessionEventToCustom(event, turnId);
      if (converted) {
        yield converted;
      }
    }

    await this.db.updateSandboxSessionStatus(sessionId, 'ACTIVE');
    this.pauseManager.schedulePause(sessionId, record.containerId);

    this.logger.debug(`${TAG} turn ${turnId} completed for session ${sessionId}`);
  }

  /**
   * Drain the per-session turn queue by coalescing all buffered entries into
   * one gRPC turn and broadcasting each SessionEvent to every waiting caller.
   * Recurses if new entries arrived during the coalesced turn.
   */
  private async drainCoalescedQueue(sessionId: string): Promise<void> {
    const queue = this.turnQueues.get(sessionId);
    if (!queue || queue.length === 0) return;

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
      // Signal completion to all waiters
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
      // Recurse: drain any entries that arrived during the coalesced turn
      await this.drainCoalescedQueue(sessionId);
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
  private findSessionById(sessionId: string): SessionRecord | undefined {
    for (const record of this.sessions.values()) {
      if (record.sessionId === sessionId) {
        return record;
      }
    }
    return undefined;
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
}
