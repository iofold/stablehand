import { create } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import {
  AttachTurnRequestSchema,
  CancelTurnRequestSchema,
  DeliverTurnRequestSchema,
  FreshBootstrapSchema,
  OpenSessionRequestSchema,
  RenewTurnDeliveryCapabilityRequestSchema,
  RequestToolResponseSchema,
  ToolLocation,
  ToolMetadataSchema,
  TurnDeliveryCapabilitySchema,
  type SessionEvent,
} from '@stablehand/proto/sandbox/v1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AgentEvent,
  HarnessSessionConfig,
  HarnessTurnContext,
} from '../../harness/types.js';
import type { OrchestratorServiceClient } from '../tool-proxy.js';

/**
 * ADR 025: a turn delivery outlives its orchestrator. Dropping the stream
 * detaches; a successor re-attaches with a higher fence and receives every
 * journaled event exactly once, in order.
 */

const mocks = vi.hoisted(() => ({
  harnessOpenSession: vi.fn(),
  harnessClose: vi.fn(async () => undefined),
}));

vi.mock('../../harness/langgraph.js', () => ({
  LangGraphHarness: class {
    async openSession(...args: Parameters<typeof mocks.harnessOpenSession>) {
      return await mocks.harnessOpenSession(...args);
    }
  },
}));

vi.mock('../ptc-codegen.js', () => ({
  generatePtcScripts: vi.fn(async () => [] as string[]),
}));

async function importRunner() {
  return await import('../runner.js');
}

const SESSION_ID = 'session-takeover';

function openRequest() {
  return create(OpenSessionRequestSchema, {
    bootstrap: {
      case: 'fresh',
      value: create(FreshBootstrapSchema, {
        agentId: 'agent-1',
        conversationId: 'conv-1',
        harnessName: 'langgraph',
        harnessConfigJson: '{}',
        systemPrompt: 'Prompt',
        workspaceDir: '/tmp/turn-takeover',
        sessionId: SESSION_ID,
        tools: [
          create(ToolMetadataSchema, {
            name: 'search',
            description: 'Search docs',
            inputSchemaJson: '{"type":"object"}',
            location: ToolLocation.ORCHESTRATOR,
          }),
        ],
      }),
    },
  });
}

function capability(ownerId: string, fenceToken: number, leaseExpiresAtMs = Date.now() + 60_000) {
  return create(TurnDeliveryCapabilitySchema, {
    ownerId,
    fenceToken: BigInt(fenceToken),
    leaseExpiresAtMs: BigInt(leaseExpiresAtMs),
    restoreFenceToken: 0n,
    containerId: 'container-1',
    agentId: 'agent-1',
    signature: 'stablehand-open-turn-delivery-capability-v1',
  });
}

function deliverRequest(turnId: string, leaseExpiresAtMs?: number) {
  return create(DeliverTurnRequestSchema, {
    sessionId: SESSION_ID,
    turnId,
    messages: [],
    deliveryCapability: capability('owner-a', 1, leaseExpiresAtMs),
  });
}

function attachRequest(turnId: string, ownerId: string, fenceToken: number, afterSeq = 0) {
  return create(AttachTurnRequestSchema, {
    sessionId: SESSION_ID,
    turnId,
    deliveryCapability: capability(ownerId, fenceToken),
    afterDeliverySeq: BigInt(afterSeq),
  });
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (!signal || signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

function describeEvent(event: SessionEvent): string {
  if (event.payload.case === 'agentEvent') {
    const inner = event.payload.value.event;
    if (inner.case === 'textDelta') return `text:${inner.value.content}`;
    return `agent:${inner.case}`;
  }
  return event.payload.case ?? 'unknown';
}

async function collect(stream: AsyncIterable<SessionEvent>, into: SessionEvent[]): Promise<void> {
  for await (const event of stream) into.push(event);
}

describe('turn delivery takeover (ADR 025)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ORCHESTRATOR_URL = 'http://127.0.0.1:3002';
  });

  afterEach(async () => {
    delete process.env.ORCHESTRATOR_URL;
    const { killSession, resetOrchestratorClient } = await importRunner();
    await killSession();
    resetOrchestratorClient();
    vi.unstubAllEnvs();
  });

  it('keeps the harness running after the stream drops and replays every event to a re-attached successor', async () => {
    const { attachTurn, deliverTurn, openSession } = await importRunner();
    const firstDelivered = deferred();
    const continueHarness = deferred();
    let harnessSignal: AbortSignal | undefined;
    mocks.harnessOpenSession.mockResolvedValue({
      deliverTurn: async function* (_input: unknown, context: HarnessTurnContext) {
        harnessSignal = context.signal;
        yield { type: 'text_delta', content: 'one' } satisfies AgentEvent;
        firstDelivered.resolve();
        await continueHarness.promise;
        yield { type: 'text_delta', content: 'two' } satisfies AgentEvent;
        yield { type: 'done', result: 'ok' } satisfies AgentEvent;
      },
      exportState: async () => ({ stateVersion: '2', payload: {} }),
      close: mocks.harnessClose,
    });
    await openSession(openRequest(), {});

    const original = new AbortController();
    const originalEvents: SessionEvent[] = [];
    const originalStream = collect(
      deliverTurn(deliverRequest('turn-1'), { signal: original.signal }),
      originalEvents,
    );
    await firstDelivered.promise;
    await vi.waitFor(() => expect(originalEvents).toHaveLength(1));

    // The orchestrator dies: its stream drops. The turn must keep running.
    original.abort(new Error('orchestrator killed'));
    await originalStream;
    expect(harnessSignal?.aborted).toBe(false);
    continueHarness.resolve();

    const successorEvents: SessionEvent[] = [];
    await collect(attachTurn(attachRequest('turn-1', 'owner-b', 2)), successorEvents);

    expect(successorEvents.map(describeEvent)).toEqual([
      'text:one',
      'text:two',
      'agent:done',
      'turnCompleted',
    ]);
    expect(successorEvents.map((event) => Number(event.deliverySeq))).toEqual([1, 2, 3, 4]);
    const deliveryIds = new Set(successorEvents.map((event) => event.deliveryId));
    expect(deliveryIds.size).toBe(1);
    expect(originalEvents[0]?.deliveryId).toBe(successorEvents[0]?.deliveryId);
    expect(harnessSignal?.aborted).toBe(true);
  });

  it('replays only the tail after the presented cursor', async () => {
    const { attachTurn, deliverTurn, openSession } = await importRunner();
    mocks.harnessOpenSession.mockResolvedValue({
      deliverTurn: async function* () {
        yield { type: 'text_delta', content: 'a' } satisfies AgentEvent;
        yield { type: 'text_delta', content: 'b' } satisfies AgentEvent;
        yield { type: 'done', result: 'ok' } satisfies AgentEvent;
      },
      exportState: async () => ({ stateVersion: '2', payload: {} }),
      close: mocks.harnessClose,
    });
    await openSession(openRequest(), {});
    const all: SessionEvent[] = [];
    await collect(deliverTurn(deliverRequest('turn-tail')), all);
    expect(all.map(describeEvent)).toEqual(['text:a', 'text:b', 'agent:done', 'turnCompleted']);

    // The owner died after reading the terminal frame but before finalizing:
    // the finished journal is still re-attachable.
    const tail: SessionEvent[] = [];
    await collect(attachTurn(attachRequest('turn-tail', 'owner-b', 2, 2)), tail);
    expect(tail.map(describeEvent)).toEqual(['agent:done', 'turnCompleted']);
    expect(tail.map((event) => Number(event.deliverySeq))).toEqual([3, 4]);
  });

  it('abandons the turn with a clear error when nobody re-attaches within the grace window', async () => {
    vi.stubEnv('STABLEHAND_TURN_ORPHAN_GRACE_MS', '40');
    const { attachTurn, deliverTurn, openSession } = await importRunner();
    const started = deferred();
    const abandoned = deferred();
    mocks.harnessOpenSession.mockResolvedValue({
      deliverTurn: async function* (_input: unknown, context: HarnessTurnContext) {
        yield { type: 'text_delta', content: 'working' } satisfies AgentEvent;
        started.resolve();
        await waitForAbort(context.signal);
        abandoned.resolve();
        yield { type: 'done', result: 'fenced' } satisfies AgentEvent;
      },
      exportState: async () => ({ stateVersion: '2', payload: {} }),
      close: mocks.harnessClose,
    });
    await openSession(openRequest(), {});

    const original = new AbortController();
    const stream = collect(
      deliverTurn(deliverRequest('turn-orphan'), { signal: original.signal }),
      [],
    );
    await started.promise;
    original.abort(new Error('orchestrator killed'));
    await stream;

    // Nobody re-attaches: the orphan timer aborts the harness.
    await abandoned.promise;
    const late: SessionEvent[] = [];
    await collect(attachTurn(attachRequest('turn-orphan', 'owner-b', 2)), late);
    expect(late.map(describeEvent)).toEqual(['text:working', 'turnFailed']);
    const failure = late.at(-1)?.payload;
    expect(failure?.case === 'turnFailed' && failure.value.errorMessage)
      .toMatch(/did not reconnect within 0s/);
  });

  it('does not abort when the capability lapses in grace mode, and resumes callbacks with the successor capability', async () => {
    const { attachTurn, deliverTurn, openSession } = await importRunner();
    const toolStarted = deferred();
    const requestTool = vi.fn<OrchestratorServiceClient['requestTool']>()
      .mockImplementationOnce(async () => {
        toolStarted.resolve();
        throw new ConnectError('connect ECONNREFUSED 10.0.0.2:3001', Code.Unavailable);
      })
      .mockImplementation(async (request) => create(RequestToolResponseSchema, {
        requestId: request.requestId,
        result: '{"ok":true}',
      }));
    const orchestratorClient: OrchestratorServiceClient = {
      requestTool,
      registerArtifact: vi.fn(),
      resolveArtifact: vi.fn(),
    };
    mocks.harnessOpenSession.mockImplementation(async (config: HarnessSessionConfig) => ({
      deliverTurn: async function* () {
        const result = await config.tools[0]!.handler({ q: 'x' }, {
          agentId: config.agentId,
          conversationId: config.conversationId,
          workspaceDir: config.workspaceDir,
        });
        yield { type: 'text_delta', content: `tool:${result}` } satisfies AgentEvent;
        yield { type: 'done', result: 'ok' } satisfies AgentEvent;
      },
      exportState: async () => ({ stateVersion: '2', payload: {} }),
      close: mocks.harnessClose,
    }));
    await openSession(openRequest(), {}, { orchestratorClient });

    const original = new AbortController();
    const stream = collect(
      deliverTurn(deliverRequest('turn-lapse', Date.now() + 80), { signal: original.signal }),
      [],
    );
    await toolStarted.promise;
    original.abort(new Error('orchestrator killed'));
    await stream;
    // Let the original capability lapse; the turn must survive it.
    await new Promise((resolve) => setTimeout(resolve, 150));

    const successor: SessionEvent[] = [];
    await collect(attachTurn(attachRequest('turn-lapse', 'owner-b', 2)), successor);
    expect(successor.map(describeEvent)).toEqual([
      'text:tool:{"ok":true}',
      'agent:done',
      'turnCompleted',
    ]);
    const lastCall = requestTool.mock.calls.at(-1)?.[0];
    expect(lastCall?.deliveryCapability).toMatchObject({ ownerId: 'owner-b', fenceToken: 2n });
    const requestIds = new Set(requestTool.mock.calls.map(([request]) => request.requestId));
    expect(requestIds.size).toBe(1);
  });

  it('cancels only on an explicit CancelTurn from a current fence', async () => {
    const { attachTurn, cancelTurn, deliverTurn, openSession } = await importRunner();
    const started = deferred();
    mocks.harnessOpenSession.mockResolvedValue({
      deliverTurn: async function* (_input: unknown, context: HarnessTurnContext) {
        started.resolve();
        await waitForAbort(context.signal);
        yield { type: 'done', result: 'stopped' } satisfies AgentEvent;
      },
      exportState: async () => ({ stateVersion: '2', payload: {} }),
      close: mocks.harnessClose,
    });
    await openSession(openRequest(), {});
    const original = new AbortController();
    const stream = collect(
      deliverTurn(deliverRequest('turn-cancel'), { signal: original.signal }),
      [],
    );
    await started.promise;
    original.abort(new Error('orchestrator killed'));
    await stream;

    const successor: SessionEvent[] = [];
    const successorStream = collect(
      attachTurn(attachRequest('turn-cancel', 'owner-b', 2)),
      successor,
    );
    await vi.waitFor(async () => {
      // The superseded owner cannot cancel its successor's turn.
      await expect(cancelTurn(create(CancelTurnRequestSchema, {
        sessionId: SESSION_ID,
        turnId: 'turn-cancel',
        deliveryCapability: capability('owner-a', 1),
        reason: 'stale',
      }))).rejects.toMatchObject({ code: Code.FailedPrecondition });
    });
    await expect(cancelTurn(create(CancelTurnRequestSchema, {
      sessionId: SESSION_ID,
      turnId: 'turn-cancel',
      deliveryCapability: capability('owner-b', 2),
      reason: 'user pressed stop',
    }))).resolves.toMatchObject({ cancelled: true });
    await successorStream;
    const terminal = successor.at(-1)?.payload;
    expect(terminal?.case).toBe('turnFailed');
    expect(terminal?.case === 'turnFailed' && terminal.value.errorMessage)
      .toMatch(/user pressed stop/);
  });

  it('keeps renewing the current authority while a consumer drains a finished delivery', async () => {
    const { deliverTurn, openSession, renewTurnDeliveryCapability } = await importRunner();
    mocks.harnessOpenSession.mockResolvedValue({
      deliverTurn: async function* () {
        yield { type: 'done', result: 'ok' } satisfies AgentEvent;
      },
      exportState: async () => ({ stateVersion: '2', payload: {} }),
      close: mocks.harnessClose,
    });
    await openSession(openRequest(), {});
    await collect(deliverTurn(deliverRequest('turn-drain')), []);

    const renewal = (ownerId: string, fenceToken: number) => create(
      RenewTurnDeliveryCapabilityRequestSchema,
      {
        sessionId: SESSION_ID,
        turnId: 'turn-drain',
        deliveryCapability: capability(ownerId, fenceToken, Date.now() + 120_000),
      },
    );
    await expect(renewTurnDeliveryCapability(renewal('owner-a', 1)))
      .resolves.toMatchObject({ renewed: true });
    await expect(renewTurnDeliveryCapability(renewal('owner-z', 1)))
      .rejects.toMatchObject({ code: Code.FailedPrecondition });
  });

  it('refuses to attach to an unknown turn or with a stale fence', async () => {
    const { attachTurn, deliverTurn, openSession } = await importRunner();
    mocks.harnessOpenSession.mockResolvedValue({
      deliverTurn: async function* () {
        yield { type: 'done', result: 'ok' } satisfies AgentEvent;
      },
      exportState: async () => ({ stateVersion: '2', payload: {} }),
      close: mocks.harnessClose,
    });
    await openSession(openRequest(), {});
    await collect(attachTurn(attachRequest('turn-missing', 'owner-b', 2)), [])
      .then(() => { throw new Error('expected attach to fail'); })
      .catch((error: unknown) => {
        expect(error).toBeInstanceOf(ConnectError);
        expect((error as ConnectError).code).toBe(Code.NotFound);
      });

    await collect(deliverTurn(create(DeliverTurnRequestSchema, {
      sessionId: SESSION_ID,
      turnId: 'turn-fenced',
      messages: [],
      deliveryCapability: capability('owner-c', 3),
    })), []);
    await expect(collect(attachTurn(attachRequest('turn-fenced', 'owner-b', 2)), []))
      .rejects.toMatchObject({ code: Code.FailedPrecondition });
  });
});
