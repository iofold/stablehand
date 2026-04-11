import { create } from '@bufbuild/protobuf';
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
    mocks.harnessOpenSession.mockResolvedValue({
      deliverTurn: async function* () {},
      exportState: async () => ({ stateVersion: '2', payload: {} }),
      close: mocks.harnessClose,
    });
  });

  afterEach(async () => {
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

  it('deliverTurn exits cleanly when killSession fires mid-stream', async () => {
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

    await expect(eventsPromise).resolves.toEqual(['agUiEvent', 'agUiEvent', 'turnCompleted']);
    expect(mocks.harnessClose).toHaveBeenCalledTimes(1);
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
      for await (const _event of deliverTurn(createDeliverTurnRequest(session.sessionId, 'turn-a'))) {
      }
    })();

    const secondTurn = deliverTurn(createDeliverTurnRequest(session.sessionId, 'turn-b'));
    await expect(secondTurn.next()).rejects.toThrow('turn already in progress');

    await killSession();
    stream.finish();
    await firstTurnPromise;
  });
});
