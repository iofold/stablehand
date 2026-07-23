import { describe, expect, it, vi } from 'vitest';

import type { AgentDefinition } from '@ctxmill/sandbox-daemon';
import type { MessageCommittedEvent } from '@ctxmill/shared';
import { AgentTurnService } from '../../packages/ctxmill/src/orchestrator/agent-turn-service.js';
import { TypedEventBus } from '../../packages/ctxmill/src/events/bus.js';
import type {
  DatabaseRepository,
  InterruptResumeAttemptRow,
} from '../../packages/ctxmill/src/database/repository.js';
import { InterruptResumeAttemptWorker } from '../../packages/ctxmill/src/orchestrator/interrupt-resume-attempt-worker.js';
import {
  SandboxSessionManager,
  type SessionRecord,
} from '../../packages/ctxmill/src/orchestrator/sandbox-session-manager.js';
import type { SessionTurnExecutor } from '../../packages/ctxmill/src/orchestrator/session-turn-service.js';
import { SessionStateStore } from '../../packages/ctxmill/src/orchestrator/session-manager/session-state-store.js';
import { SessionStatusCoordinator } from '../../packages/ctxmill/src/orchestrator/session-manager/session-status-coordinator.js';
import type { ContainerLifecyclePolicy } from '../../packages/ctxmill/src/orchestrator/container-lifecycle-policy.js';
import type { ContainerManager } from '../../packages/ctxmill/src/sandbox/container-manager.js';
import { WorkspaceDiffService } from '../../packages/ctxmill/src/sandbox/workspace-diff.js';

const AGENT_DEF: AgentDefinition = {
  name: 'approval-agent',
  harness: 'langgraph',
  harnessConfig: {},
  tools: [],
  systemPrompt: 'continue after approval',
};

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createAttempt(
  overrides: Partial<InterruptResumeAttemptRow> = {},
): InterruptResumeAttemptRow {
  return {
    id: 'attempt-1',
    interruptId: 'interrupt-1',
    turnId: 'turn-1',
    sandboxSessionId: 'sandbox-old',
    agentId: 'agent-1',
    status: 'pending',
    attempts: 0,
    lastError: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    completedAt: null,
    ...overrides,
  };
}

function committed(content: string): MessageCommittedEvent {
  return {
    type: 'MESSAGE_COMMITTED',
    timestamp: Date.now(),
    runId: 'turn-1',
    turnId: 'turn-1',
    messageSeq: 1,
    role: 'assistant',
    content,
  };
}

function createDurableStore(options: {
  failAttemptCompletionOnce?: boolean;
} = {}) {
  let fenceToken = 0;
  let currentFence: { ownerId: string; fenceToken: number } | undefined;
  let leaseLive = false;
  let terminal = false;
  let completionFailuresRemaining = options.failAttemptCompletionOnce ? 1 : 0;
  let messageSeq = 0;
  let attempt = createAttempt();
  const messages = new Map<string, Record<string, unknown>>();

  const owns = (fence?: { ownerId: string; fenceToken: number }) =>
    !fence || (
      leaseLive
      && currentFence?.ownerId === fence.ownerId
      && currentFence.fenceToken === fence.fenceToken
    );

  const db = {
    getAgent: vi.fn().mockResolvedValue(null),
    getTurn: vi.fn().mockImplementation(async () => ({
      id: 'turn-1',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      sandboxSessionId: 'sandbox-active',
      status: terminal ? 'completed' : 'running',
      completedAt: terminal ? 5_000 : null,
      mode: 'interactive',
      taskDescription: 'continue the approved task',
      error: null,
    })),
    getSandboxSession: vi.fn().mockResolvedValue({
      id: 'sandbox-old',
      conversationId: 'conversation-1',
      agentId: 'agent-1',
      containerName: 'sandbox-old',
      containerId: 'container-old',
      status: 'CHECKPOINTED',
      harnessName: 'langgraph',
      checkpointRef: 'checkpoint-1',
      createdAt: 1_000,
      updatedAt: 1_000,
      lastActivityAt: 1_000,
    }),
    getCheckpointV2: vi.fn().mockResolvedValue({
      id: 'checkpoint-1',
      sandboxSessionId: 'sandbox-old',
      agentId: 'agent-1',
      checkpointVersion: 2,
      checkpointData: {
        runnerState: {
          pendingRequests: [{
            type: 'approval',
            id: 'approval-1',
            payload: {
              tool: 'send_email',
              args: { to: 'person@example.com' },
            },
          }],
        },
      },
      harnessState: {},
      workspaceRef: null,
      suspendReason: 'hitl-wait',
      createdAt: 1_000,
    }),
    getInterruptById: vi.fn().mockResolvedValue({
      id: 'interrupt-1',
      turnId: 'turn-1',
      agentId: 'agent-1',
      sandboxSessionId: 'sandbox-old',
      toolCallId: 'approval-1',
      toolName: 'request-approval',
      args: {
        tool: 'send_email',
        args: { to: 'person@example.com' },
      },
      timeoutMs: 300_000,
      createdAt: 1_000,
      expiresAt: 301_000,
      resolvedAt: 2_000,
      resolvedAction: 'approve',
      resolvedData: null,
      status: 'resolved',
    }),
    addCanonicalMessage: vi.fn().mockImplementation(async (
      input: Record<string, unknown>,
      fence?: { ownerId: string; fenceToken: number },
    ) => {
      if (!owns(fence)) {
        return undefined;
      }
      const id = String(input.id);
      const existing = messages.get(id);
      if (existing) {
        return existing;
      }
      const row = {
        ...input,
        id,
        messageSeq: messageSeq++,
        messageRevision: 0,
        publishedRevision: -1,
        createdAt: Date.now(),
      };
      messages.set(id, row);
      return row;
    }),
    getMessage: vi.fn().mockImplementation(
      async (id: string) => messages.get(id),
    ),
    getMessagesPendingCanonicalPublish: vi.fn().mockResolvedValue([]),
    stageAssistantMessageUpdate: vi.fn(),
    isTurnDeliveryFenceCurrent: vi.fn().mockImplementation(
      async (_turnId: string, fence: {
        ownerId: string;
        fenceToken: number;
      }) => owns(fence),
    ),
    claimInterruptResumeDelivery: vi.fn().mockImplementation(async (
      input: {
        sandboxSessionId: string;
        ownerId: string;
      },
    ) => {
      if (terminal) {
        return undefined;
      }
      currentFence = {
        ownerId: input.ownerId,
        fenceToken: ++fenceToken,
      };
      leaseLive = true;
      attempt = {
        ...attempt,
        sandboxSessionId: input.sandboxSessionId,
        status: 'in_progress',
        attempts: attempt.attempts + 1,
      };
      return {
        attempt,
        lease: {
          turnId: 'turn-1',
          ...currentFence,
          leaseExpiresAt: Date.now() + 60_000,
          updatedAt: Date.now(),
        },
      };
    }),
    renewTurnDeliveryLease: vi.fn().mockImplementation(async (
      _turnId: string,
      ownerId: string,
      token: number,
      leaseDurationMs: number,
    ) => owns({ ownerId, fenceToken: token })
      ? {
          turnId: 'turn-1',
          ownerId,
          fenceToken: token,
          leaseExpiresAt: Date.now() + leaseDurationMs,
          updatedAt: Date.now(),
        }
      : undefined),
    releaseTurnDeliveryLease: vi.fn().mockImplementation(async (
      _turnId: string,
      ownerId: string,
      token: number,
    ) => {
      if (!owns({ ownerId, fenceToken: token })) {
        return false;
      }
      leaseLive = false;
      return true;
    }),
    finalizeTurnIfOpen: vi.fn().mockImplementation(async (
      _turnId: string,
      _updates: Record<string, unknown>,
      fence?: { ownerId: string; fenceToken: number },
    ) => {
      if (terminal || !owns(fence)) {
        return false;
      }
      terminal = true;
      return true;
    }),
    completeInterruptResumeDelivery: vi.fn().mockImplementation(async (
      _attemptId: string,
      fence: { ownerId: string; fenceToken: number },
    ) => {
      if (completionFailuresRemaining > 0) {
        completionFailuresRemaining--;
        throw new Error('crash after terminal turn write');
      }
      if (!owns(fence)) {
        return undefined;
      }
      attempt = {
        ...attempt,
        status: 'completed',
        completedAt: Date.now(),
      };
      return attempt;
    }),
    failInterruptResumeDelivery: vi.fn().mockImplementation(async (
      _attemptId: string,
      fence: { ownerId: string; fenceToken: number },
      error: string,
    ) => {
      if (!owns(fence)) {
        return undefined;
      }
      attempt = { ...attempt, status: 'failed', lastError: error };
      return attempt;
    }),
    completeTerminalInterruptResumeAttempt: vi.fn().mockImplementation(
      async () => {
        if (!terminal) {
          return undefined;
        }
        attempt = {
          ...attempt,
          status: 'completed',
          completedAt: Date.now(),
        };
        return attempt;
      },
    ),
    failUnclaimedInterruptResumeAttempt: vi.fn(),
    getRecoverableInterruptResumeAttempts: vi.fn().mockImplementation(
      async () => [attempt],
    ),
  };

  return {
    db,
    messages,
    get attempt() {
      return attempt;
    },
    get terminal() {
      return terminal;
    },
  };
}

function createRuntime(
  db: ReturnType<typeof createDurableStore>['db'],
  executeSessionTurn: SessionTurnExecutor['executeSessionTurn'],
) {
  const eventBus = new TypedEventBus();
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const stateStore = new SessionStateStore();
  const activeSession: SessionRecord = {
    sessionId: 'sandbox-active',
    conversationId: 'conversation-1',
    agentId: 'agent-1',
    containerName: 'sandbox-active',
    containerId: 'container-active',
    restoreFenceToken: 0,
    status: 'ACTIVE',
    harnessName: 'langgraph',
  };
  stateStore.setSession('conversation-1', activeSession);
  stateStore.setAgentDef('conversation-1', AGENT_DEF);
  const containerManager = {
    extractWorkspaceDiff: vi.fn().mockResolvedValue(null),
  } as unknown as ContainerManager;
  const agentTurnServiceHolder: { current?: AgentTurnService } = {};
  const manager = new SandboxSessionManager({
    containerManager,
    db: db as unknown as DatabaseRepository,
    lifecyclePolicy: {
      cancelIdleTimeout: vi.fn().mockResolvedValue(undefined),
      scheduleIdleTimeout: vi.fn(),
    } as unknown as ContainerLifecyclePolicy,
    stateStore,
    statusCoordinator: new SessionStatusCoordinator({
      db: db as unknown as DatabaseRepository,
      logger,
      stateStore,
    }),
    eventBus,
    workspaceDiffService: new WorkspaceDiffService({ containerManager }),
    buildSandboxSecrets: async () => ({}),
    resolveTurnSecrets: async () => ({
      PILOT_TURN_OWNERSHIP_TOKEN: 'turn-token-1',
    }),
    executeInterruptContinuation: async (input) => {
      if (!agentTurnServiceHolder.current) {
        throw new Error('agent turn service unavailable');
      }
      await agentTurnServiceHolder.current.executeTurn(input);
    },
    logger,
    config: {
      idleTimeoutMs: 60_000,
      maxQueuedMessages: 10,
    },
  });
  vi.spyOn(manager, 'ensureSession').mockResolvedValue(activeSession);
  const sessionTurnService = {
    executeSessionTurn: vi.fn().mockImplementation(executeSessionTurn),
  };
  agentTurnServiceHolder.current = new AgentTurnService({
    db: db as unknown as DatabaseRepository,
    sessionManager: manager,
    eventBus,
    sessionTurnService: sessionTurnService as unknown as SessionTurnExecutor,
  });
  return { manager, sessionTurnService };
}

function createWorker(
  db: ReturnType<typeof createDurableStore>['db'],
  manager: SandboxSessionManager,
  ownerId: string,
) {
  return new InterruptResumeAttemptWorker({
    db: db as unknown as DatabaseRepository,
    sessionManager: manager,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  }, { ownerId });
}

describe('HITL continuation through real manager and turn service', () => {
  it('approves after restore, retains streamed output, and terminalizes the original turn', async () => {
    const store = createDurableStore();
    const runtime = createRuntime(
      store.db,
      async function* () {
        yield committed('continued answer');
        yield {
          type: 'RUN_FINISHED',
          timestamp: Date.now(),
          runId: 'turn-1',
        };
      },
    );
    const worker = createWorker(store.db, runtime.manager, 'worker-a');

    worker.enqueue(createAttempt());
    await worker.drain();

    expect(runtime.sessionTurnService.executeSessionTurn).toHaveBeenCalledWith(
      AGENT_DEF,
      'conversation-1',
      [
        expect.objectContaining({ role: 'assistant' }),
        expect.objectContaining({ role: 'tool', content: 'APPROVED' }),
      ],
      'turn-1',
      {
        signal: expect.any(AbortSignal),
        agentId: 'agent-1',
        existingSessionId: 'sandbox-active',
        turnSecrets: {
          PILOT_TURN_OWNERSHIP_TOKEN: 'turn-token-1',
        },
      },
    );
    expect(Array.from(store.messages.values())).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          turnId: 'turn-1',
          role: 'assistant',
          content: 'continued answer',
        }),
      ]),
    );
    expect(store.terminal).toBe(true);
    expect(store.attempt.status).toBe('completed');
  });

  it('repairs the attempt after reload without redelivering a terminal continuation', async () => {
    const store = createDurableStore({ failAttemptCompletionOnce: true });
    const firstRuntime = createRuntime(
      store.db,
      async function* () {
        yield committed('completed before crash');
        yield {
          type: 'RUN_FINISHED',
          timestamp: Date.now(),
          runId: 'turn-1',
        };
      },
    );
    const firstWorker = createWorker(store.db, firstRuntime.manager, 'worker-a');
    firstWorker.enqueue(createAttempt());
    await firstWorker.drain();

    expect(store.terminal).toBe(true);
    expect(store.attempt.status).toBe('in_progress');

    const reloadedRuntime = createRuntime(
      store.db,
      async function* () {
        yield committed('terminal continuation must not be redelivered');
      },
    );
    const reloadedWorker = createWorker(
      store.db,
      reloadedRuntime.manager,
      'worker-b',
    );
    reloadedWorker.enqueue(store.attempt);
    await reloadedWorker.drain();

    expect(reloadedRuntime.sessionTurnService.executeSessionTurn)
      .not.toHaveBeenCalled();
    expect(store.db.completeTerminalInterruptResumeAttempt)
      .toHaveBeenCalledWith('attempt-1');
    expect(store.attempt.status).toBe('completed');
  });

  it('lets B take over while stale A wakes later without persisting or finalizing A output', async () => {
    const store = createDurableStore();
    const wakeA = createDeferred();
    const runtimeA = createRuntime(
      store.db,
      async function* () {
        await wakeA.promise;
        yield committed('stale A output');
        yield {
          type: 'RUN_FINISHED',
          timestamp: Date.now(),
          runId: 'turn-1',
        };
      },
    );
    const runtimeB = createRuntime(
      store.db,
      async function* () {
        yield committed('authoritative B output');
        yield {
          type: 'RUN_FINISHED',
          timestamp: Date.now(),
          runId: 'turn-1',
        };
      },
    );
    const workerA = createWorker(store.db, runtimeA.manager, 'worker-a');
    const workerB = createWorker(store.db, runtimeB.manager, 'worker-b');

    workerA.enqueue(createAttempt());
    await vi.waitFor(() => {
      expect(runtimeA.sessionTurnService.executeSessionTurn).toHaveBeenCalled();
    });

    workerB.enqueue(createAttempt({ status: 'in_progress', attempts: 1 }));
    await workerB.drain();
    wakeA.resolve();
    await workerA.drain();

    const output = Array.from(store.messages.values())
      .map((message) => message.content);
    expect(output).toContain('authoritative B output');
    expect(output).not.toContain('stale A output');
    expect(store.db.finalizeTurnIfOpen).toHaveBeenCalledTimes(1);
    expect(store.db.completeInterruptResumeDelivery).toHaveBeenCalledTimes(2);
    expect(store.attempt.status).toBe('completed');
  });
});
