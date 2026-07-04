import { create } from '@bufbuild/protobuf';
import { Code } from '@connectrpc/connect';
import {
  DeliverTurnRequestSchema,
  FreshBootstrapSchema,
  OpenSessionRequestSchema,
  RestoreBootstrapSchema,
  SessionCheckpointSchema,
  ToolLocation,
  ToolMetadataSchema,
} from '@ctxmill/proto/sandbox/v1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentEvent } from '../../harness/types.js';
import { getSessionTools } from '../daemon.js';

const mocks = vi.hoisted(() => ({
  generatePtcScripts: vi.fn(async () => [] as string[]),
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
  generatePtcScripts: mocks.generatePtcScripts,
}));

async function importRunner() {
  return await import('../runner.js');
}

function createOpenSessionRequest(workspaceDir = '/tmp/custom-workspace') {
  return create(OpenSessionRequestSchema, {
    bootstrap: {
      case: 'fresh',
      value: create(FreshBootstrapSchema, {
        agentId: 'agent-1',
        conversationId: 'conv-1',
        harnessName: 'langgraph',
	        harnessConfigJson: '{}',
	        systemPrompt: 'Prompt',
	        workspaceDir,
	        sessionId: 'session-fresh',
	        tools: [
          create(ToolMetadataSchema, {
            name: 'search',
            description: 'Search docs',
            inputSchemaJson: '{"type":"object"}',
            location: ToolLocation.ORCHESTRATOR,
            programmatic: true,
          }),
        ],
      }),
    },
  });
}

function createDeliverTurnRequest(sessionId: string, turnId: string) {
  return create(DeliverTurnRequestSchema, {
    sessionId,
    turnId,
    messages: [],
  });
}

function createDeferred<T>() {
  let resolve: ((value: T | PromiseLike<T>) => void) | undefined;
  let reject: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return {
    promise,
    resolve(value: T) {
      if (!resolve) {
        throw new Error('deferred resolve called before initialization');
      }
      resolve(value);
    },
    reject(reason?: unknown) {
      if (!reject) {
        throw new Error('deferred reject called before initialization');
      }
      reject(reason);
    },
  };
}

function createControllableGenerator() {
  type ControlSignal =
    | { kind: 'event'; event: AgentEvent }
    | { kind: 'done' };

  const pendingSignals: ControlSignal[] = [];
  const waiters: Array<(value: ControlSignal) => void> = [];

  const pushSignal = (signal: ControlSignal) => {
    const waiter = waiters.shift();
    if (waiter) {
      waiter(signal);
      return;
    }
    pendingSignals.push(signal);
  };

  const nextSignal = async (): Promise<ControlSignal> => {
    const pending = pendingSignals.shift();
    if (pending) {
      return pending;
    }

    return await new Promise<ControlSignal>((resolve) => {
      waiters.push(resolve);
    });
  };

  const generator = async function* () {
    while (true) {
      const signal = await nextSignal();
      if (signal.kind === 'done') {
        return;
      }
      yield signal.event;
    }
  };

  return {
    generator,
    emitEvent(event: AgentEvent) {
      pushSignal({ kind: 'event', event });
    },
    finish() {
      pushSignal({ kind: 'done' });
    },
  };
}

describe('runner openSession PTC bootstrap', () => {
	  beforeEach(() => {
	    vi.clearAllMocks();
	    mocks.generatePtcScripts.mockResolvedValue([]);
	    process.env.ORCHESTRATOR_URL = 'http://127.0.0.1:3002';
    mocks.harnessOpenSession.mockResolvedValue({
      deliverTurn: async function* () {},
      exportState: async () => ({ stateVersion: '2', payload: {} }),
      close: mocks.harnessClose,
    });
  });

  afterEach(async () => {
    delete process.env.ORCHESTRATOR_URL;
    const { killSession, resetOrchestratorClient } = await importRunner();
    await killSession();
    resetOrchestratorClient();
  });

  it('uses the fresh workspaceDir when generating PTC scripts', async () => {
    const { openSession } = await importRunner();
    const req = createOpenSessionRequest();

    await openSession(req, {});

    expect(mocks.generatePtcScripts).toHaveBeenCalledWith(expect.objectContaining({
      scriptDir: '/tmp/custom-workspace/.tools',
      tools: [expect.objectContaining({ name: 'search', programmatic: true })],
    }));
  });

  it('surfaces PTC generation failures in the harness prompt instead of silently looking healthy', async () => {
    const { openSession } = await importRunner();
    mocks.generatePtcScripts.mockRejectedValueOnce(new Error('bun is unavailable'));

    await openSession(createOpenSessionRequest('/tmp/ptc-degraded'), {});

    expect(mocks.harnessOpenSession).toHaveBeenCalledWith(expect.objectContaining({
      systemPrompt: expect.stringContaining('[CTXMill degraded mode] Programmatic tool-calling (PTC) setup failed'),
    }));
    expect(mocks.harnessOpenSession).toHaveBeenCalledWith(expect.objectContaining({
      systemPrompt: expect.stringContaining('bun is unavailable'),
    }));
  });

  it('reconstructs restore tools, repopulates daemon state, and regenerates PTC scripts', async () => {
    const { openSession } = await importRunner();
    const req = create(OpenSessionRequestSchema, {
      bootstrap: {
        case: 'restore',
        value: create(RestoreBootstrapSchema, {
          sessionCheckpoint: create(SessionCheckpointSchema, {
            checkpointVersion: 2,
            sessionId: 'session-restore',
            conversationId: 'conv-restore',
            harnessName: 'langgraph',
            workspaceRef: {
              strategy: 'dir',
              reference: '/tmp/restore-workspace',
            },
            harnessState: { restored: true },
          }),
          agentId: 'agent-restore',
          harnessConfigJson: '{"model":"claude-sonnet-4-6"}',
          systemPrompt: 'Restore system prompt',
          tools: [
            create(ToolMetadataSchema, {
              name: 'search',
              description: 'Search docs',
              inputSchemaJson: '{"type":"object"}',
              location: ToolLocation.ORCHESTRATOR,
              programmatic: true,
            }),
          ],
        }),
      },
    });

    await openSession(req, {});

    expect(mocks.generatePtcScripts).toHaveBeenCalledWith(expect.objectContaining({
      scriptDir: '/tmp/restore-workspace/.tools',
      tools: [expect.objectContaining({ name: 'search', programmatic: true })],
    }));
    expect(getSessionTools()).toEqual([
      expect.objectContaining({ name: 'search', programmatic: true }),
    ]);
    expect(mocks.harnessOpenSession).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-restore',
        systemPrompt: 'Restore system prompt',
        harnessConfigJson: '{"model":"claude-sonnet-4-6"}',
        workspaceDir: '/tmp/restore-workspace',
        tools: [expect.objectContaining({ name: 'search', programmatic: true })],
      }),
      expect.objectContaining({
        stateVersion: '2',
        payload: { restored: true },
      }),
    );
  });

  it('fails deliverTurn when killSession fires mid-stream', async () => {
    const { deliverTurn, killSession, openSession } = await importRunner();
    const stream = createControllableGenerator();
    const reachedSecondEvent = createDeferred<void>();

    mocks.harnessOpenSession.mockResolvedValue({
      deliverTurn: stream.generator,
      exportState: async () => ({ stateVersion: '2', payload: {} }),
      close: mocks.harnessClose,
    });

    const session = await openSession(createOpenSessionRequest('/tmp/race-mid-stream'), {});
    const eventsPromise = (async () => {
      const payloadCases: string[] = [];
      for await (const event of deliverTurn(createDeliverTurnRequest(session.sessionId, 'turn-race-mid-stream'))) {
        payloadCases.push(event.payload.case ?? 'missing');
        if (payloadCases.length === 2) {
          reachedSecondEvent.resolve();
        }
      }
      return payloadCases;
    })();

    stream.emitEvent({ type: 'text_delta', content: 'alpha' });
    stream.emitEvent({ type: 'text_delta', content: 'beta' });
    await reachedSecondEvent.promise;

    await killSession();
    stream.emitEvent({ type: 'done', result: 'ignored-after-kill' });

    await expect(eventsPromise).resolves.toEqual(['agUiEvent', 'agUiEvent', 'turnFailed']);
    expect(mocks.harnessClose).toHaveBeenCalledTimes(1);
  });

  it('fails a turn when the harness stream ends with a pending tool call and no done event', async () => {
    const { deliverTurn, openSession } = await importRunner();
    const stream = createControllableGenerator();

    mocks.harnessOpenSession.mockResolvedValue({
      deliverTurn: stream.generator,
      exportState: async () => ({ stateVersion: '2', payload: {} }),
      close: mocks.harnessClose,
    });

    const session = await openSession(createOpenSessionRequest('/tmp/pending-tool-no-done'), {});
    const eventsPromise = (async () => {
      const events = [];
      for await (const event of deliverTurn(createDeliverTurnRequest(session.sessionId, 'turn-pending-tool'))) {
        events.push(event);
      }
      return events;
    })();

    stream.emitEvent({
      type: 'tool_call_start',
      id: 'call-pending',
      name: 'long-op',
      args: {},
    });
    stream.finish();

    const events = await eventsPromise;
    expect(events.map((event) => event.payload.case)).toEqual(['agUiEvent', 'turnFailed']);
    expect(events[1].payload.value).toMatchObject({
      turnId: 'turn-pending-tool',
      errorMessage: expect.stringContaining('call-pending'),
    });
  });

  it('rejects deliverTurn when request session id does not match active session', async () => {
    const { deliverTurn, openSession } = await importRunner();
    const harnessDeliverTurn = vi.fn(async function* () {});

    mocks.harnessOpenSession.mockResolvedValue({
      deliverTurn: harnessDeliverTurn,
      exportState: async () => ({ stateVersion: '2', payload: {} }),
      close: mocks.harnessClose,
    });

    const session = await openSession(createOpenSessionRequest('/tmp/session-id-deliver-mismatch'), {});
    const stream = deliverTurn(createDeliverTurnRequest(`${session.sessionId}-wrong`, 'turn-wrong-session'));

    await expect(stream.next()).rejects.toMatchObject({
      code: Code.FailedPrecondition,
    });
    expect(harnessDeliverTurn).not.toHaveBeenCalled();
  });

  it('suspendSession throws when killSession fires during exportState', async () => {
    const { killSession, openSession, suspendSession } = await importRunner();
    const exportStateDeferred = createDeferred<{ stateVersion: string; payload: Record<string, unknown> }>();

    mocks.harnessOpenSession.mockResolvedValue({
      deliverTurn: async function* () {},
      exportState: async () => await exportStateDeferred.promise,
      close: mocks.harnessClose,
    });

    await openSession(createOpenSessionRequest('/tmp/race-export-state'), {});

    const suspendPromise = suspendSession('race-test');
    await killSession();
    exportStateDeferred.resolve({ stateVersion: '2', payload: {} });

    await expect(suspendPromise).rejects.toThrow('session killed during state export');
    expect(mocks.harnessClose).toHaveBeenCalledTimes(1);
  });

  it('suspendSession rejects with FailedPrecondition when phase is unsafe and timeout is 0 (ctx-6nu)', async () => {
    const { deliverTurn, killSession, openSession, suspendSession } = await importRunner();
    const stream = createControllableGenerator();

    mocks.harnessOpenSession.mockResolvedValue({
      deliverTurn: stream.generator,
      exportState: async () => ({ stateVersion: '2', payload: {} }),
      close: mocks.harnessClose,
    });

    const session = await openSession(createOpenSessionRequest('/tmp/suspend-unsafe'), {});

    // Drive the harness into the unsafe `tool_execution` phase by emitting a
    // tool_call_start event and consuming it on the deliverTurn stream.
    const reachedToolStart = createDeferred<void>();
    const turnPromise = (async () => {
      for await (const event of deliverTurn(createDeliverTurnRequest(session.sessionId, 'turn-unsafe-suspend'))) {
        void event;
        reachedToolStart.resolve();
      }
    })();

    stream.emitEvent({
      type: 'tool_call_start',
      id: 'call-1',
      name: 'long-op',
      args: {},
    });
    await reachedToolStart.promise;

    // Now phase is `tool_execution` (unsafe). With safePointTimeoutMs=0 the
    // request must fail immediately rather than capturing a partial checkpoint.
    await expect(suspendSession('reason', session.sessionId, 0)).rejects.toMatchObject({
      code: Code.FailedPrecondition,
    });

    // Tear down: end the harness stream and kill the session so the
    // deliverTurn loop can complete.
    stream.finish();
    await killSession().catch(() => undefined);
    await turnPromise;
  });

  it('suspendSession waits for the next safe phase before exporting state (ctx-6nu)', async () => {
    const { deliverTurn, killSession, openSession, suspendSession } = await importRunner();
    const stream = createControllableGenerator();
    const exportState = vi.fn(async () => ({ stateVersion: '2', payload: {} }));

    mocks.harnessOpenSession.mockResolvedValue({
      deliverTurn: stream.generator,
      exportState,
      close: mocks.harnessClose,
    });

    const session = await openSession(createOpenSessionRequest('/tmp/suspend-wait-safe'), {});

    const reachedToolStart = createDeferred<void>();
    const reachedToolEnd = createDeferred<void>();
    const turnPromise = (async () => {
      let count = 0;
      const payloadCases: string[] = [];
      for await (const _event of deliverTurn(createDeliverTurnRequest(session.sessionId, 'turn-wait-safe'))) {
        payloadCases.push(_event.payload.case ?? 'missing');
        count++;
        if (count === 1) reachedToolStart.resolve();
        if (count === 2) reachedToolEnd.resolve();
      }
      return payloadCases;
    })();

    stream.emitEvent({ type: 'tool_call_start', id: 'call-1', name: 'op', args: {} });
    await reachedToolStart.promise;

    // Issue suspend while phase is unsafe; it should not export state yet.
    const suspendPromise = suspendSession('wait-safe', session.sessionId, 30_000);
    // Give the runner microtasks to process the suspend request.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(exportState).not.toHaveBeenCalled();

    // Push a safe-phase event (`tool_call_end` -> `after_tool`). The runner's
    // post-yield safe-point check resolves the queued suspend.
    stream.emitEvent({ type: 'tool_call_end', id: 'call-1', result: 'ok', durationMs: 1 });
    await reachedToolEnd.promise;

    // Now suspend should be allowed to proceed.
    const response = await suspendPromise;
    expect(exportState).toHaveBeenCalledTimes(1);
    expect(response.sessionCheckpoint).toBeDefined();
    await expect(turnPromise).resolves.toEqual(['agUiEvent', 'agUiEvent']);

    stream.finish();
    await killSession().catch(() => undefined);
  });

  it('rejects suspendSession when request session id does not match active session', async () => {
    const { openSession, suspendSession } = await importRunner();
    const exportState = vi.fn(async () => ({ stateVersion: '2', payload: {} }));

    mocks.harnessOpenSession.mockResolvedValue({
      deliverTurn: async function* () {},
      exportState,
      close: mocks.harnessClose,
    });

    const session = await openSession(createOpenSessionRequest('/tmp/session-id-suspend-mismatch'), {});

    await expect(suspendSession('mismatch-test', `${session.sessionId}-wrong`)).rejects.toMatchObject({
      code: Code.FailedPrecondition,
    });
    expect(exportState).not.toHaveBeenCalled();
  });

  it('rejects killSession when request session id does not match active session', async () => {
    const { killSession, openSession } = await importRunner();

    mocks.harnessOpenSession.mockResolvedValue({
      deliverTurn: async function* () {},
      exportState: async () => ({ stateVersion: '2', payload: {} }),
      close: mocks.harnessClose,
    });

    const session = await openSession(createOpenSessionRequest('/tmp/session-id-kill-mismatch'), {});

    await expect(killSession(`${session.sessionId}-wrong`)).rejects.toMatchObject({
      code: Code.FailedPrecondition,
    });
    expect(mocks.harnessClose).not.toHaveBeenCalled();

    await killSession(session.sessionId);
    expect(mocks.harnessClose).toHaveBeenCalledTimes(1);
  });

  it('suspendSession serializes bigint checkpoint payloads without global prototype patches', async () => {
    const { deliverTurn, openSession, suspendSession } = await importRunner();

    mocks.harnessOpenSession.mockResolvedValue({
      deliverTurn: async function* () {
        yield {
          type: 'approval_needed',
          id: 'approval-bigint',
          tool: 'delete-file',
          args: { sequence: 9007199254740993n },
        } satisfies AgentEvent;
      },
      exportState: async () => ({
        stateVersion: '2',
        payload: {
          checkpointSeq: 9007199254740995n,
        },
      }),
      close: mocks.harnessClose,
    });

    const session = await openSession(createOpenSessionRequest('/tmp/bigint-checkpoint'), {});

    for await (const event of deliverTurn(createDeliverTurnRequest(session.sessionId, 'turn-bigint'))) {
      void event;
    }

    const response = await suspendSession('serialize-bigint');

    expect(response.sessionCheckpoint?.runnerState?.pendingRequests).toEqual([
      expect.objectContaining({
        id: 'approval-bigint',
        payloadJson: '{"tool":"delete-file","args":{"sequence":"9007199254740993"}}',
      }),
    ]);
    expect(response.sessionCheckpoint?.harnessState).toEqual({
      stateVersion: '2',
      payload: {
        checkpointSeq: '9007199254740995',
      },
    });
  });

  it('rejects concurrent deliverTurn calls', async () => {
    const { deliverTurn, killSession, openSession } = await importRunner();
    const stream = createControllableGenerator();

    mocks.harnessOpenSession.mockResolvedValue({
      deliverTurn: stream.generator,
      exportState: async () => ({ stateVersion: '2', payload: {} }),
      close: mocks.harnessClose,
    });

    const session = await openSession(createOpenSessionRequest('/tmp/concurrent-turns'), {});
    const firstTurnPromise = (async () => {
      for await (const event of deliverTurn(createDeliverTurnRequest(session.sessionId, 'turn-a'))) {
        void event;
      }
    })();

    const secondTurn = deliverTurn(createDeliverTurnRequest(session.sessionId, 'turn-b'));
    await expect(secondTurn.next()).rejects.toThrow('turn already in progress');

    await killSession();
    stream.finish();
    await firstTurnPromise;
  });
});
