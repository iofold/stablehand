import { describe, expect, it, vi } from 'vitest';

import type { AgentDefinition } from '@stablehand/sandbox-daemon';
import type {
  DatabaseRepository,
  InterruptRow,
  SandboxSessionRow,
} from '../../database/repository.js';
import type { TypedEventBus } from '../../events/bus.js';
import type { TurnDeliveryFence } from '../turn-delivery-fence.js';
import { InterruptResumeService } from '../session-manager/interrupt-resume-service.js';

const AGENT_DEFINITION: AgentDefinition = {
  name: 'agent',
  harness: 'langgraph',
  harnessConfig: {},
  tools: [],
  systemPrompt: 'help',
};

const DELIVERY_FENCE: TurnDeliveryFence = {
  ownerId: 'worker-a',
  fenceToken: 9,
};

function createSession(): SandboxSessionRow {
  return {
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
  };
}

function createInterrupt(): InterruptRow {
  return {
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
  };
}

function createDeps(options: {
  terminal?: boolean;
  loseMessageFence?: boolean;
} = {}) {
  let messageSeq = 0;
  const db = {
    getTurn: vi.fn().mockResolvedValue({
      id: 'turn-1',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      status: options.terminal ? 'completed' : 'running',
      completedAt: options.terminal ? 3_000 : null,
      mode: 'interactive',
      taskDescription: 'original task',
    }),
    getSandboxSession: vi.fn().mockResolvedValue(createSession()),
    getInterruptById: vi.fn().mockResolvedValue(createInterrupt()),
    getCheckpointV2: vi.fn().mockResolvedValue({
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
    }),
    addCanonicalMessage: vi.fn().mockImplementation(
      async (input: Record<string, unknown>) => options.loseMessageFence
        ? undefined
        : {
            ...input,
            createdAt: 2_000,
            messageSeq: messageSeq++,
            messageRevision: 0,
            publishedRevision: -1,
          },
    ),
    isTurnDeliveryFenceCurrent: vi.fn().mockResolvedValue(true),
  };
  const eventBus = {
    emitAsync: vi.fn().mockResolvedValue(undefined),
  };
  const executeContinuation = vi.fn().mockResolvedValue(undefined);
  const ensureSession = vi.fn().mockResolvedValue({
    sessionId: 'sandbox-restored',
  });
  const service = new InterruptResumeService({
    db: db as unknown as DatabaseRepository,
    eventBus: eventBus as unknown as TypedEventBus,
    stateStore: {
      getAgentDef: () => AGENT_DEFINITION,
      setAgentDef: vi.fn(),
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    ensureSession,
    executeContinuation,
    resolveTurnSecrets: vi.fn().mockResolvedValue({}),
    resolveAgentDefinition: vi.fn().mockResolvedValue(null),
  } as never);
  return {
    db,
    ensureSession,
    eventBus,
    executeContinuation,
    service,
  };
}

type ContinuationService = {
  prepareInterruptContinuation(
    sandboxSessionId: string,
    turnId: string,
    agentId: string,
    interruptId: string,
  ): Promise<Record<string, unknown>>;
  executeInterruptContinuation(
    prepared: Record<string, unknown>,
    attemptId: string,
    fence: TurnDeliveryFence,
    signal?: AbortSignal,
  ): Promise<void>;
};

describe('InterruptResumeService durable continuation contract', () => {
  it('restores a checkpointed session before returning a ready continuation', async () => {
    const { ensureSession, service } = createDeps();

    const prepared = await (service as unknown as ContinuationService)
      .prepareInterruptContinuation(
        'sandbox-old',
        'turn-1',
        'agent-1',
        'interrupt-1',
      );

    expect(ensureSession).toHaveBeenCalledWith(
      'conversation-1',
      AGENT_DEFINITION,
      'agent-1',
      undefined,
    );
    expect(prepared).toMatchObject({
      kind: 'ready',
      sandboxSessionId: 'sandbox-restored',
      turnId: 'turn-1',
      agentId: 'agent-1',
      interruptId: 'interrupt-1',
      conversationId: 'conversation-1',
      mode: 'interactive',
      taskDescription: 'original task',
    });
  });

  it('persists and publishes approval messages under the fence before executing the original turn', async () => {
    const {
      db,
      eventBus,
      executeContinuation,
      service,
    } = createDeps();
    const continuationService = service as unknown as ContinuationService;
    const prepared = await continuationService.prepareInterruptContinuation(
      'sandbox-old',
      'turn-1',
      'agent-1',
      'interrupt-1',
    );

    await continuationService.executeInterruptContinuation(
      prepared,
      'attempt-1',
      DELIVERY_FENCE,
    );

    expect(db.addCanonicalMessage).toHaveBeenCalledTimes(2);
    expect(db.addCanonicalMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        turnId: 'turn-1',
        role: 'assistant',
      }),
      DELIVERY_FENCE,
    );
    expect(db.addCanonicalMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        turnId: 'turn-1',
        role: 'tool',
        content: 'APPROVED',
      }),
      DELIVERY_FENCE,
    );
    expect(eventBus.emitAsync).toHaveBeenNthCalledWith(
      1,
      'message.committed',
      expect.objectContaining({
        turnId: 'turn-1',
        role: 'assistant',
      }),
      { deliveryFence: DELIVERY_FENCE },
    );
    expect(executeContinuation).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxSessionId: 'sandbox-restored',
        turnId: 'turn-1',
        continuationAttemptId: 'attempt-1',
        deliveryContext: {
          fence: DELIVERY_FENCE,
        },
      }),
    );
  });

  it('rejects a stale owner before publishing or executing when fenced message persistence loses', async () => {
    const {
      eventBus,
      executeContinuation,
      service,
    } = createDeps({ loseMessageFence: true });
    const continuationService = service as unknown as ContinuationService;
    const prepared = await continuationService.prepareInterruptContinuation(
      'sandbox-old',
      'turn-1',
      'agent-1',
      'interrupt-1',
    );

    await expect(
      continuationService.executeInterruptContinuation(
        prepared,
        'attempt-1',
        DELIVERY_FENCE,
      ),
    ).rejects.toThrow(/lost delivery ownership/);

    expect(eventBus.emitAsync).not.toHaveBeenCalled();
    expect(executeContinuation).not.toHaveBeenCalled();
  });

  it('does not restore when the original turn is already terminal', async () => {
    const { ensureSession, service } = createDeps({ terminal: true });

    const prepared = await (service as unknown as ContinuationService)
      .prepareInterruptContinuation(
        'sandbox-old',
        'turn-1',
        'agent-1',
        'interrupt-1',
      );

    expect(prepared).toEqual({
      kind: 'terminal',
      turnId: 'turn-1',
    });
    expect(ensureSession).not.toHaveBeenCalled();
  });
});
