import { create } from '@bufbuild/protobuf';
import { Code, ConnectError, type HandlerContext } from '@connectrpc/connect';
import {
  DeliverTurnRequestSchema,
  FreshBootstrapSchema,
  NativeToolPolicy,
  NativeToolPolicyConfigSchema,
  OpenSessionRequestSchema,
  RenewTurnDeliveryCapabilityRequestSchema,
  RequestToolResponseSchema,
  RestoreBootstrapSchema,
  SessionCheckpointSchema,
  TurnDeliveryCapabilitySchema,
  ToolLocation,
  ToolMetadataSchema,
} from '@stablehand/proto/sandbox/v1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AgentEvent,
  HarnessSessionConfig,
  HarnessTurnContext,
  HarnessTurnInput,
} from '../../harness/types.js';
import { getSessionTools } from '../daemon.js';
import type { OrchestratorServiceClient } from '../tool-proxy.js';

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
	        nativeToolPolicy: create(NativeToolPolicyConfigSchema, {
	          policy: NativeToolPolicy.ALLOW,
	          names: ['Read'],
	        }),
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
    deliveryCapability: create(TurnDeliveryCapabilitySchema, {
      ownerId: 'delivery-owner-1',
      fenceToken: 1n,
      leaseExpiresAtMs: BigInt(Date.now() + 60_000),
      restoreFenceToken: 0n,
      containerId: 'container-generation-1',
      agentId: 'agent-1',
      signature: 'stablehand-open-turn-delivery-capability-v1',
    }),
  });
}

function createDeliveryRenewal(
  request: ReturnType<typeof createDeliverTurnRequest>,
  leaseExpiresAtMs: number,
) {
  return create(RenewTurnDeliveryCapabilityRequestSchema, {
    sessionId: request.sessionId,
    turnId: request.turnId,
    deliveryCapability: create(TurnDeliveryCapabilitySchema, {
      ...request.deliveryCapability!,
      leaseExpiresAtMs: BigInt(leaseExpiresAtMs),
    }),
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
    expect(mocks.harnessOpenSession).toHaveBeenCalledWith(expect.objectContaining({
      nativeToolPolicy: {
        policy: 'allow',
        names: ['Read'],
      },
    }));
  });

  it('surfaces PTC generation failures in the harness prompt instead of silently looking healthy', async () => {
    const { openSession } = await importRunner();
    mocks.generatePtcScripts.mockRejectedValueOnce(new Error('bun is unavailable'));

    await openSession(createOpenSessionRequest('/tmp/ptc-degraded'), {});

    expect(mocks.harnessOpenSession).toHaveBeenCalledWith(expect.objectContaining({
      systemPrompt: expect.stringContaining('[Stablehand degraded mode] Programmatic tool-calling (PTC) setup failed'),
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
          nativeToolPolicy: create(NativeToolPolicyConfigSchema, {
            policy: NativeToolPolicy.DENY,
            names: ['WebFetch'],
          }),
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
    expect(mocks.harnessOpenSession).toHaveBeenCalledWith(
      expect.objectContaining({
        nativeToolPolicy: {
          policy: 'deny',
          names: ['WebFetch'],
        },
      }),
      expect.any(Object),
    );
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

  it('does not retain the OpenSession request signal after bootstrap completes', async () => {
    const { deliverTurn, openSession } = await importRunner();
    const bootstrapController = new AbortController();

    mocks.harnessOpenSession.mockImplementation(async (config: HarnessSessionConfig) => ({
      deliverTurn: async function* () {
        if (config.signal?.aborted) {
          return;
        }
        yield { type: 'done', result: 'completed after bootstrap' } satisfies AgentEvent;
      },
      exportState: async () => ({ stateVersion: '2', payload: {} }),
      close: mocks.harnessClose,
    }));

    const session = await openSession(
      createOpenSessionRequest('/tmp/completed-open-session-request'),
      {},
      { signal: bootstrapController.signal },
    );

    bootstrapController.abort(new Error('OpenSession request completed'));

    const payloadCases: string[] = [];
    for await (const event of deliverTurn(
      createDeliverTurnRequest(session.sessionId, 'turn-after-open-session'),
    )) {
      payloadCases.push(event.payload.case ?? 'missing');
    }

    expect(payloadCases).toEqual(['agentEvent', 'turnCompleted']);
  });

  it('provides immutable turn secrets without mutating the stable sandbox environment', async () => {
    const { deliverTurn, openSession } = await importRunner();
    const tokenKey = 'PILOT_TURN_OWNERSHIP_TOKEN';
    const turnOnlyKey = 'PILOT_LOGICAL_AGENT_ID';
    const previousToken = process.env[tokenKey];
    const previousTurnOnly = process.env[turnOnlyKey];
    const observed: Array<Record<string, string | undefined>> = [];

    process.env[tokenKey] = 'stable-token';
    delete process.env[turnOnlyKey];

    try {
      mocks.harnessOpenSession.mockImplementation(async (config: HarnessSessionConfig) => ({
        deliverTurn: async function* (
          input: HarnessTurnInput,
          context: HarnessTurnContext,
        ) {
          observed.push({
            turnId: input.turnId,
            envToken: process.env[tokenKey],
            envTurnOnly: process.env[turnOnlyKey],
            configToken: config.secrets[tokenKey],
            configTurnOnly: config.secrets[turnOnlyKey],
            turnToken: context.turnSecrets?.[tokenKey],
            turnOnly: context.turnSecrets?.[turnOnlyKey],
          });
          if (input.turnId === 'turn-secret-error') {
            throw new Error('intentional turn failure');
          }
          yield { type: 'done', result: 'ok' } satisfies AgentEvent;
        },
        exportState: async () => ({ stateVersion: '2', payload: {} }),
        close: mocks.harnessClose,
      }));

      const session = await openSession(
        createOpenSessionRequest('/tmp/turn-secret-context'),
        {
          [tokenKey]: 'stable-token',
          STABLE_PROVIDER_KEY: 'stable-provider-key',
        },
      );

      const first = createDeliverTurnRequest(session.sessionId, 'turn-secret-a');
      Object.assign(first, {
        turnSecrets: {
          [tokenKey]: 'turn-token-a',
          [turnOnlyKey]: 'logical-agent-a',
        },
      });
      for await (const _event of deliverTurn(first)) {
        void _event;
      }
      expect(process.env[tokenKey]).toBe('stable-token');
      expect(process.env[turnOnlyKey]).toBeUndefined();

      const second = createDeliverTurnRequest(session.sessionId, 'turn-secret-b');
      Object.assign(second, {
        turnSecrets: {
          [tokenKey]: 'turn-token-b',
          [turnOnlyKey]: 'logical-agent-b',
        },
      });
      for await (const _event of deliverTurn(second)) {
        void _event;
      }
      expect(process.env[tokenKey]).toBe('stable-token');
      expect(process.env[turnOnlyKey]).toBeUndefined();

      const third = createDeliverTurnRequest(session.sessionId, 'turn-secret-empty');
      for await (const _event of deliverTurn(third)) {
        void _event;
      }

      const failing = createDeliverTurnRequest(session.sessionId, 'turn-secret-error');
      Object.assign(failing, {
        turnSecrets: {
          [tokenKey]: 'turn-token-error',
          [turnOnlyKey]: 'logical-agent-error',
        },
      });
      const failingCases: Array<string | undefined> = [];
      for await (const event of deliverTurn(failing)) {
        failingCases.push(event.payload.case);
      }
      expect(failingCases).toEqual(['turnFailed']);
      expect(process.env[tokenKey]).toBe('stable-token');
      expect(process.env[turnOnlyKey]).toBeUndefined();

      expect(observed).toEqual([
        {
          turnId: 'turn-secret-a',
          envToken: 'stable-token',
          envTurnOnly: undefined,
          configToken: 'stable-token',
          configTurnOnly: undefined,
          turnToken: 'turn-token-a',
          turnOnly: 'logical-agent-a',
        },
        {
          turnId: 'turn-secret-b',
          envToken: 'stable-token',
          envTurnOnly: undefined,
          configToken: 'stable-token',
          configTurnOnly: undefined,
          turnToken: 'turn-token-b',
          turnOnly: 'logical-agent-b',
        },
        {
          turnId: 'turn-secret-empty',
          envToken: 'stable-token',
          envTurnOnly: undefined,
          configToken: 'stable-token',
          configTurnOnly: undefined,
          turnToken: undefined,
          turnOnly: undefined,
        },
        {
          turnId: 'turn-secret-error',
          envToken: 'stable-token',
          envTurnOnly: undefined,
          configToken: 'stable-token',
          configTurnOnly: undefined,
          turnToken: 'turn-token-error',
          turnOnly: 'logical-agent-error',
        },
      ]);
    } finally {
      if (previousToken === undefined) {
        delete process.env[tokenKey];
      } else {
        process.env[tokenKey] = previousToken;
      }
      if (previousTurnOnly === undefined) {
        delete process.env[turnOnlyKey];
      } else {
        process.env[turnOnlyKey] = previousTurnOnly;
      }
    }
  });

  it('keeps turn secrets out of process.env while killSession closes the harness', async () => {
    const { deliverTurn, killSession, openSession } = await importRunner();
    const tokenKey = 'PILOT_TURN_OWNERSHIP_TOKEN';
    const previousToken = process.env[tokenKey];
    const harnessStarted = createDeferred<void>();
    const startedWithToken: Array<string | undefined> = [];
    const closedWithToken: Array<string | undefined> = [];

    process.env[tokenKey] = 'stable-token';

    try {
      mocks.harnessOpenSession.mockResolvedValue({
        deliverTurn: async function* (
          _input: HarnessTurnInput,
          context: HarnessTurnContext,
        ) {
          startedWithToken.push(context.turnSecrets?.[tokenKey]);
          harnessStarted.resolve();
          await new Promise<void>((resolve) => {
            if (context.signal?.aborted) {
              resolve();
              return;
            }
            context.signal?.addEventListener('abort', () => resolve(), { once: true });
          });
          yield* [];
        },
        exportState: async () => ({ stateVersion: '2', payload: {} }),
        close: vi.fn(async () => {
          closedWithToken.push(process.env[tokenKey]);
        }),
      });

      const session = await openSession(
        createOpenSessionRequest('/tmp/turn-secret-kill-cleanup'),
        { [tokenKey]: 'stable-token' },
      );
      const request = createDeliverTurnRequest(session.sessionId, 'turn-secret-kill');
      Object.assign(request, {
        turnSecrets: {
          [tokenKey]: 'turn-token-kill',
        },
      });
      const delivery = (async () => {
        for await (const _event of deliverTurn(request)) {
          void _event;
        }
      })();
      await harnessStarted.promise;
      expect(startedWithToken).toEqual(['turn-token-kill']);
      expect(process.env[tokenKey]).toBe('stable-token');

      await killSession(session.sessionId);

      expect(closedWithToken).toEqual(['stable-token']);
      expect(process.env[tokenKey]).toBe('stable-token');
      await delivery;
    } finally {
      if (previousToken === undefined) {
        delete process.env[tokenKey];
      } else {
        process.env[tokenKey] = previousToken;
      }
    }
  });

  it('rejects turn secrets that target sandbox runtime control variables', async () => {
    const { deliverTurn, openSession } = await importRunner();
    const harnessDeliverTurn = vi.fn(async function* () {
      yield { type: 'done', result: 'must not run' } satisfies AgentEvent;
    });
    mocks.harnessOpenSession.mockResolvedValue({
      deliverTurn: harnessDeliverTurn,
      exportState: async () => ({ stateVersion: '2', payload: {} }),
      close: mocks.harnessClose,
    });

    const session = await openSession(
      createOpenSessionRequest('/tmp/turn-secret-runtime-control'),
      {},
    );
    const request = createDeliverTurnRequest(session.sessionId, 'turn-secret-reserved');
    Object.assign(request, {
      turnSecrets: {
        STABLEHAND_CALLBACK_TOKEN: 'forged-callback-token',
      },
    });

    const events = [];
    for await (const event of deliverTurn(request)) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({
      case: 'turnFailed',
      value: expect.objectContaining({
        errorMessage: expect.stringContaining('reserved by the sandbox runtime'),
      }),
    });
    expect(harnessDeliverTurn).not.toHaveBeenCalled();
  });

  it('does not fence an active turn when a higher-fence request has invalid secrets', async () => {
    const { deliverTurn, openSession } = await importRunner();
    const predecessorStarted = createDeferred<AbortSignal>();
    const releasePredecessor = createDeferred<void>();
    const harnessDeliverTurn = vi.fn(async function* (
      _input: HarnessTurnInput,
      context: HarnessTurnContext,
    ) {
      if (!context.signal) throw new Error('missing turn signal');
      predecessorStarted.resolve(context.signal);
      await releasePredecessor.promise;
      yield { type: 'done', result: 'predecessor completed' } satisfies AgentEvent;
    });
    mocks.harnessOpenSession.mockResolvedValue({
      deliverTurn: harnessDeliverTurn,
      exportState: async () => ({ stateVersion: '2', payload: {} }),
      close: mocks.harnessClose,
    });

    const session = await openSession(
      createOpenSessionRequest('/tmp/invalid-successor-secrets'),
      {},
    );
    const predecessor = createDeliverTurnRequest(session.sessionId, 'turn-invalid-successor');
    const predecessorEvents = (async () => {
      const cases = [];
      for await (const event of deliverTurn(predecessor)) cases.push(event.payload.case);
      return cases;
    })();
    const predecessorSignal = await predecessorStarted.promise;

    const invalidSuccessor = createDeliverTurnRequest(
      session.sessionId,
      'turn-invalid-successor',
    );
    invalidSuccessor.deliveryCapability!.ownerId = 'delivery-owner-2';
    invalidSuccessor.deliveryCapability!.fenceToken = 2n;
    invalidSuccessor.turnSecrets = {
      STABLEHAND_CALLBACK_TOKEN: 'forged-callback-token',
    };
    const invalidEvents = [];
    for await (const event of deliverTurn(invalidSuccessor)) {
      invalidEvents.push(event);
    }

    expect(invalidEvents).toHaveLength(1);
    expect(invalidEvents[0].payload.case).toBe('turnFailed');
    expect(predecessorSignal.aborted).toBe(false);
    expect(harnessDeliverTurn).toHaveBeenCalledTimes(1);

    releasePredecessor.resolve();
    await expect(predecessorEvents).resolves.toEqual(['agentEvent', 'turnCompleted']);
  });

  it('keeps killSession pending until the active turn fully unwinds', async () => {
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

    let killSettled = false;
    const killPromise = killSession().then(() => {
      killSettled = true;
    });
    await Promise.resolve();

    expect(killSettled).toBe(false);
    expect(mocks.harnessClose).not.toHaveBeenCalled();

    stream.finish();
    await killPromise;

    await expect(eventsPromise).resolves.toEqual(['agentEvent', 'agentEvent', 'turnFailed']);
    expect(mocks.harnessClose).toHaveBeenCalledTimes(1);
  });

  it('rejects new turn admission while an idle session is closing', async () => {
    const { deliverTurn, killSession, openSession } = await importRunner();
    const closeStarted = createDeferred<void>();
    const allowClose = createDeferred<void>();
    const harnessDeliverTurn = vi.fn(async function* () {
      yield { type: 'done', result: 'must not run' } satisfies AgentEvent;
    });
    mocks.harnessOpenSession.mockResolvedValue({
      deliverTurn: harnessDeliverTurn,
      exportState: async () => ({ stateVersion: '2', payload: {} }),
      close: async () => {
        closeStarted.resolve();
        await allowClose.promise;
      },
    });

    const session = await openSession(
      createOpenSessionRequest('/tmp/closing-admission-gate'),
      {},
    );
    const firstKill = killSession(session.sessionId);
    await closeStarted.promise;

    await expect(
      deliverTurn(
        createDeliverTurnRequest(session.sessionId, 'turn-during-close'),
      ).next(),
    ).rejects.toMatchObject({ code: Code.FailedPrecondition });
    expect(harnessDeliverTurn).not.toHaveBeenCalled();

    const repeatedKill = killSession(session.sessionId);
    allowClose.resolve();
    await expect(Promise.all([firstKill, repeatedKill])).resolves.toHaveLength(2);
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
    expect(events.map((event) => event.payload.case)).toEqual(['agentEvent', 'turnFailed']);
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

  it('rejects an expired delivery capability before invoking the harness', async () => {
    const { deliverTurn, openSession } = await importRunner();
    const harnessDeliverTurn = vi.fn(async function* () {
      yield { type: 'done', result: 'must not run' } satisfies AgentEvent;
    });

    mocks.harnessOpenSession.mockResolvedValue({
      deliverTurn: harnessDeliverTurn,
      exportState: async () => ({ stateVersion: '2', payload: {} }),
      close: mocks.harnessClose,
    });

    const session = await openSession(
      createOpenSessionRequest('/tmp/expired-delivery-capability'),
      {},
    );
    const request = createDeliverTurnRequest(
      session.sessionId,
      'turn-expired-capability',
    );
    request.deliveryCapability!.leaseExpiresAtMs = BigInt(Date.now() - 1);

    await expect(deliverTurn(request).next()).rejects.toMatchObject({
      code: Code.FailedPrecondition,
    });
    expect(harnessDeliverTurn).not.toHaveBeenCalled();
  });

  it('rejects delayed lower and equal-token different-owner deliveries after a successor fence', async () => {
    const { deliverTurn, openSession } = await importRunner();
    const harnessDeliverTurn = vi.fn(async function* () {
      yield { type: 'done', result: 'accepted once' } satisfies AgentEvent;
    });

    mocks.harnessOpenSession.mockResolvedValue({
      deliverTurn: harnessDeliverTurn,
      exportState: async () => ({ stateVersion: '2', payload: {} }),
      close: mocks.harnessClose,
    });

    const session = await openSession(
      createOpenSessionRequest('/tmp/monotonic-delivery-capability'),
      {},
    );
    const successor = createDeliverTurnRequest(
      session.sessionId,
      'turn-monotonic-capability',
    );
    successor.deliveryCapability!.ownerId = 'delivery-owner-2';
    successor.deliveryCapability!.fenceToken = 2n;
    for await (const _event of deliverTurn(successor)) {
      void _event;
      // Drain the accepted successor delivery.
    }

    const delayedPredecessor = createDeliverTurnRequest(
      session.sessionId,
      'turn-monotonic-capability',
    );
    await expect(deliverTurn(delayedPredecessor).next()).rejects.toMatchObject({
      code: Code.FailedPrecondition,
    });

    const conflictingOwner = createDeliverTurnRequest(
      session.sessionId,
      'turn-monotonic-capability',
    );
    conflictingOwner.deliveryCapability!.ownerId = 'different-owner-same-token';
    conflictingOwner.deliveryCapability!.fenceToken = 2n;
    await expect(deliverTurn(conflictingOwner).next()).rejects.toMatchObject({
      code: Code.FailedPrecondition,
    });

    expect(harnessDeliverTurn).toHaveBeenCalledTimes(1);
  });

  it('renews only the exact active delivery and propagates the renewed capability to callbacks', async () => {
    const { deliverTurn, openSession, renewTurnDeliveryCapability } = await importRunner();
    const harnessStarted = createDeferred<void>();
    const releaseHarness = createDeferred<void>();
    const requestTool = vi.fn<OrchestratorServiceClient['requestTool']>()
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
        harnessStarted.resolve();
        await releaseHarness.promise;
        await config.tools[0].handler({ query: 'renewed' }, {
          agentId: config.agentId,
          conversationId: config.conversationId,
          workspaceDir: config.workspaceDir,
        });
        yield { type: 'done', result: 'ok' } satisfies AgentEvent;
      },
      exportState: async () => ({ stateVersion: '2', payload: {} }),
      close: mocks.harnessClose,
    }));

    const session = await openSession(
      createOpenSessionRequest('/tmp/renew-delivery-capability'),
      {},
      { orchestratorClient },
    );
    const request = createDeliverTurnRequest(session.sessionId, 'turn-renew');
    const eventsPromise = (async () => {
      const cases: Array<string | undefined> = [];
      for await (const event of deliverTurn(request)) {
        cases.push(event.payload.case);
      }
      return cases;
    })();
    await harnessStarted.promise;

    const mismatched = createDeliveryRenewal(request, Date.now() + 120_000);
    mismatched.deliveryCapability!.ownerId = 'wrong-owner';
    await expect(renewTurnDeliveryCapability(mismatched)).rejects.toMatchObject({
      code: Code.FailedPrecondition,
    });

    const renewedExpiry = Date.now() + 120_000;
    await expect(
      renewTurnDeliveryCapability(createDeliveryRenewal(request, renewedExpiry)),
    ).resolves.toMatchObject({ renewed: true });

    releaseHarness.resolve();
    await expect(eventsPromise).resolves.toEqual(['agentEvent', 'turnCompleted']);
    expect(requestTool).toHaveBeenCalledTimes(1);
    expect(requestTool.mock.calls[0][0]).toMatchObject({
      turnId: 'turn-renew',
      deliveryCapability: expect.objectContaining({
        ownerId: 'delivery-owner-1',
        leaseExpiresAtMs: BigInt(renewedExpiry),
      }),
    });
  });

  it('aborts an in-flight harness when its unrenewed delivery capability expires', async () => {
    const { deliverTurn, openSession } = await importRunner();
    const harnessSawSignal = createDeferred<AbortSignal>();
    mocks.harnessOpenSession.mockResolvedValue({
      deliverTurn: async function* (
        _input: unknown,
        context: { signal?: AbortSignal },
      ) {
        if (!context.signal) throw new Error('missing turn signal');
        harnessSawSignal.resolve(context.signal);
        await new Promise<void>((resolve) => {
          if (context.signal?.aborted) {
            resolve();
            return;
          }
          context.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        yield { type: 'done', result: 'must be fenced' } satisfies AgentEvent;
      },
      exportState: async () => ({ stateVersion: '2', payload: {} }),
      close: mocks.harnessClose,
    });

    const session = await openSession(
      createOpenSessionRequest('/tmp/expiring-delivery-capability'),
      {},
    );
    const request = createDeliverTurnRequest(session.sessionId, 'turn-expire-mid-flight');
    request.deliveryCapability!.leaseExpiresAtMs = BigInt(Date.now() + 30);

    const eventsPromise = (async () => {
      const events = [];
      for await (const event of deliverTurn(request)) events.push(event);
      return events;
    })();
    const signal = await harnessSawSignal.promise;
    const events = await eventsPromise;

    expect(signal.aborted).toBe(true);
    expect(events.at(-1)?.payload).toMatchObject({
      case: 'turnFailed',
      value: {
        errorMessage: expect.stringContaining('expired'),
      },
    });
  });

  it('aborts and fully unwinds a predecessor before invoking a higher-fence successor', async () => {
    const { deliverTurn, openSession } = await importRunner();
    const predecessorStarted = createDeferred<void>();
    let harnessCalls = 0;
    let activeHarnessCalls = 0;
    let maximumConcurrentHarnessCalls = 0;
    mocks.harnessOpenSession.mockResolvedValue({
      deliverTurn: async function* (
        _input: unknown,
        context: { signal?: AbortSignal },
      ) {
        harnessCalls++;
        activeHarnessCalls++;
        maximumConcurrentHarnessCalls = Math.max(
          maximumConcurrentHarnessCalls,
          activeHarnessCalls,
        );
        try {
          if (harnessCalls === 1) {
            predecessorStarted.resolve();
            await new Promise<void>((resolve) => {
              if (context.signal?.aborted) {
                resolve();
                return;
              }
              context.signal?.addEventListener('abort', () => resolve(), { once: true });
            });
            return;
          }
          yield { type: 'done', result: 'successor' } satisfies AgentEvent;
        } finally {
          activeHarnessCalls--;
        }
      },
      exportState: async () => ({ stateVersion: '2', payload: {} }),
      close: mocks.harnessClose,
    });

    const session = await openSession(
      createOpenSessionRequest('/tmp/safe-delivery-handoff'),
      {},
    );
    const predecessor = createDeliverTurnRequest(session.sessionId, 'turn-handoff');
    const predecessorEvents = (async () => {
      const cases = [];
      for await (const event of deliverTurn(predecessor)) cases.push(event.payload.case);
      return cases;
    })();
    await predecessorStarted.promise;

    const successor = createDeliverTurnRequest(session.sessionId, 'turn-handoff');
    successor.deliveryCapability!.ownerId = 'delivery-owner-2';
    successor.deliveryCapability!.fenceToken = 2n;
    const successorCases = [];
    for await (const event of deliverTurn(successor)) {
      successorCases.push(event.payload.case);
    }

    await expect(predecessorEvents).resolves.toEqual(['turnFailed']);
    expect(successorCases).toEqual(['agentEvent', 'turnCompleted']);
    expect(harnessCalls).toBe(2);
    expect(maximumConcurrentHarnessCalls).toBe(1);
  });

  it('does not admit a successor when kill begins during iterator cleanup', async () => {
    const { deliverTurn, killSession, openSession } = await importRunner();
    const predecessorStarted = createDeferred<void>();
    const firstCloseIncomplete = createDeferred<void>();
    const cleanupNextStarted = createDeferred<void>();
    const allowCleanupNext = createDeferred<void>();
    let harnessCalls = 0;
    let nextCalls = 0;
    let returnCalls = 0;

    mocks.harnessOpenSession.mockResolvedValue({
      deliverTurn: vi.fn((
        _input: HarnessTurnInput,
        context: HarnessTurnContext,
      ) => {
        harnessCalls++;
        if (harnessCalls > 1) {
          return (async function* () {
            yield { type: 'done', result: 'successor' } satisfies AgentEvent;
          })();
        }

        predecessorStarted.resolve();
        const iterator: AsyncGenerator<AgentEvent> = {
          [Symbol.asyncIterator]() {
            return this;
          },
          async next() {
            nextCalls++;
            if (nextCalls > 1) {
              cleanupNextStarted.resolve();
              await allowCleanupNext.promise;
              return { done: true, value: undefined };
            }
            await new Promise<void>((resolve) => {
              if (context.signal?.aborted) {
                resolve();
                return;
              }
              context.signal?.addEventListener('abort', () => resolve(), { once: true });
            });
            return {
              done: false,
              value: { type: 'text_delta', content: 'aborted predecessor' },
            };
          },
          async return() {
            returnCalls++;
            if (returnCalls === 1) {
              firstCloseIncomplete.resolve();
              return {
                done: false,
                value: { type: 'text_delta', content: 'iterator still open' },
              };
            }
            throw new Error('iterator.return() must not be repeated after done:false');
          },
          async throw(error?: unknown) {
            throw error;
          },
        };
        return iterator;
      }),
      exportState: async () => ({ stateVersion: '2', payload: {} }),
      close: mocks.harnessClose,
    });

    const session = await openSession(
      createOpenSessionRequest('/tmp/iterator-close-handoff'),
      {},
    );
    const predecessor = createDeliverTurnRequest(session.sessionId, 'turn-close-handoff');
    const predecessorEvents = (async () => {
      const cases = [];
      for await (const event of deliverTurn(predecessor)) cases.push(event.payload.case);
      return cases;
    })();
    await predecessorStarted.promise;

    const successor = createDeliverTurnRequest(session.sessionId, 'turn-close-handoff');
    successor.deliveryCapability!.ownerId = 'delivery-owner-2';
    successor.deliveryCapability!.fenceToken = 2n;
    const successorEvents = (async () => {
      const cases = [];
      for await (const event of deliverTurn(successor)) cases.push(event.payload.case);
      return cases;
    })();

    await firstCloseIncomplete.promise;
    await cleanupNextStarted.promise;
    expect(harnessCalls).toBe(1);
    expect(returnCalls).toBe(1);

    const killPromise = killSession(session.sessionId);
    allowCleanupNext.resolve();

    await expect(predecessorEvents).resolves.toEqual(['turnFailed']);
    await expect(successorEvents).rejects.toMatchObject({
      code: Code.FailedPrecondition,
    });
    await expect(killPromise).resolves.toMatchObject({ finalStatus: 'killed' });
    expect(harnessCalls).toBe(1);
  });

  it('drains cleanup yielded by a real async generator before releasing the turn', async () => {
    const { deliverTurn, openSession } = await importRunner();
    const harnessStarted = createDeferred<void>();
    const cleanupYielded = createDeferred<void>();
    const cleanupCompleted = vi.fn();
    const requestController = new AbortController();

    mocks.harnessOpenSession.mockResolvedValue({
      deliverTurn: async function* (
        _input: HarnessTurnInput,
        context: HarnessTurnContext,
      ) {
        try {
          harnessStarted.resolve();
          await new Promise<void>((resolve) => {
            if (context.signal?.aborted) {
              resolve();
              return;
            }
            context.signal?.addEventListener('abort', () => resolve(), { once: true });
          });
          yield { type: 'text_delta', content: 'aborted turn' } satisfies AgentEvent;
        } finally {
          cleanupYielded.resolve();
          yield { type: 'text_delta', content: 'cleanup step' } satisfies AgentEvent;
          cleanupCompleted();
        }
      },
      exportState: async () => ({ stateVersion: '2', payload: {} }),
      close: mocks.harnessClose,
    });

    const session = await openSession(
      createOpenSessionRequest('/tmp/real-generator-cleanup'),
      {},
    );
    const request = createDeliverTurnRequest(session.sessionId, 'turn-real-cleanup');
    const delivery = (async () => {
      const cases = [];
      for await (const event of deliverTurn(request, {
        signal: requestController.signal,
      })) {
        cases.push(event.payload.case);
      }
      return cases;
    })();

    await harnessStarted.promise;
    requestController.abort(new Error('cancel test turn'));

    await cleanupYielded.promise;
    await expect(delivery).resolves.toEqual(['turnFailed']);
    expect(cleanupCompleted).toHaveBeenCalledOnce();
  });

  it('times out never-settling iterator cleanup and poisons the session', async () => {
    vi.useFakeTimers();
    try {
      const { deliverTurn, killSession, openSession } = await importRunner();
      const harnessStarted = createDeferred<void>();
      const cleanupStarted = createDeferred<void>();

      mocks.harnessOpenSession.mockResolvedValue({
        deliverTurn: vi.fn((
          _input: HarnessTurnInput,
          context: HarnessTurnContext,
        ) => {
          let nextCalls = 0;
          const iterator: AsyncGenerator<AgentEvent> = {
            [Symbol.asyncIterator]() {
              return this;
            },
            async next() {
              nextCalls++;
              if (nextCalls === 1) {
                harnessStarted.resolve();
                await new Promise<void>((resolve) => {
                  if (context.signal?.aborted) {
                    resolve();
                    return;
                  }
                  context.signal?.addEventListener('abort', () => resolve(), { once: true });
                });
                return {
                  done: false,
                  value: { type: 'text_delta', content: 'aborted turn' },
                };
              }
              return { done: true, value: undefined };
            },
            async return() {
              cleanupStarted.resolve();
              return await new Promise<IteratorResult<AgentEvent>>(() => undefined);
            },
            async throw(error?: unknown) {
              throw error;
            },
          };
          return iterator;
        }),
        exportState: async () => ({ stateVersion: '2', payload: {} }),
        close: mocks.harnessClose,
      });

      const session = await openSession(
        createOpenSessionRequest('/tmp/never-settling-iterator-cleanup'),
        {},
      );
      let deliveryError: unknown;
      const delivery = (async () => {
        for await (const _event of deliverTurn(
          createDeliverTurnRequest(session.sessionId, 'turn-cleanup-timeout'),
        )) {
          void _event;
        }
      })();
      const observedDelivery = delivery.catch((error: unknown) => {
        deliveryError = error;
      });

      await harnessStarted.promise;

      let successorError: unknown;
      const successorRequest = createDeliverTurnRequest(
        session.sessionId,
        'turn-cleanup-timeout',
      );
      successorRequest.deliveryCapability!.ownerId = 'delivery-owner-2';
      successorRequest.deliveryCapability!.fenceToken = 2n;
      const successor = (async () => {
        for await (const _event of deliverTurn(successorRequest)) {
          void _event;
        }
      })();
      const observedSuccessor = successor.catch((error: unknown) => {
        successorError = error;
      });

      await cleanupStarted.promise;

      let killError: unknown;
      const kill = killSession(session.sessionId);
      const observedKill = kill.catch((error: unknown) => {
        killError = error;
      });

      await vi.advanceTimersByTimeAsync(10_001);

      expect(deliveryError).toMatchObject({
        code: Code.Internal,
        message: expect.stringContaining('session poisoned'),
      });
      expect(successorError).toMatchObject({
        code: Code.FailedPrecondition,
      });
      expect(killError).toMatchObject({
        code: Code.DeadlineExceeded,
        message: expect.stringContaining('container termination required'),
      });
      await observedDelivery;
      await observedSuccessor;
      await observedKill;
    } finally {
      vi.useRealTimers();
      vi.resetModules();
    }
  });

  it('rejects a delayed predecessor callback without exposing successor secrets', async () => {
    const { deliverTurn, openSession } = await importRunner();
    const releaseDelayedCallback = createDeferred<void>();
    let delayedCallback: Promise<void> | undefined;
    let delayedToken: string | undefined;
    const tokenKey = 'PILOT_TURN_OWNERSHIP_TOKEN';
    const requests: Parameters<OrchestratorServiceClient['requestTool']>[0][] = [];
    const requestTool = vi.fn<OrchestratorServiceClient['requestTool']>()
      .mockImplementation(async (request) => {
        requests.push(request);
        throw new ConnectError('stale predecessor callback', Code.PermissionDenied);
      });
    const orchestratorClient: OrchestratorServiceClient = {
      requestTool,
      registerArtifact: vi.fn(),
      resolveArtifact: vi.fn(),
    };

    mocks.harnessOpenSession.mockImplementation(async (config: HarnessSessionConfig) => ({
      deliverTurn: async function* (
        _input: HarnessTurnInput,
        context: HarnessTurnContext,
      ) {
        delayedCallback = (async () => {
          await releaseDelayedCallback.promise;
          delayedToken = context.turnSecrets?.[tokenKey];
          await config.tools[0].handler({ query: 'late-a' }, {
            agentId: config.agentId,
            conversationId: config.conversationId,
            workspaceDir: config.workspaceDir,
          }).catch(() => undefined);
        })();
        yield { type: 'done', result: 'predecessor-complete' } satisfies AgentEvent;
      },
      exportState: async () => ({ stateVersion: '2', payload: {} }),
      close: mocks.harnessClose,
    }));

    const session = await openSession(
      createOpenSessionRequest('/tmp/delayed-predecessor-callback'),
      {},
      { orchestratorClient },
    );
    const predecessor = createDeliverTurnRequest(session.sessionId, 'turn-delayed-callback');
    predecessor.turnSecrets = { [tokenKey]: 'turn-token-a' };
    for await (const _event of deliverTurn(predecessor)) {
      void _event;
      // Drain predecessor.
    }

    const successor = createDeliverTurnRequest(session.sessionId, 'turn-delayed-callback');
    successor.deliveryCapability!.ownerId = 'delivery-owner-2';
    successor.deliveryCapability!.fenceToken = 2n;
    successor.turnSecrets = { [tokenKey]: 'turn-token-b' };
    for await (const _event of deliverTurn(successor)) {
      void _event;
      // A completed-turn acknowledgement still admits the successor fence.
    }

    releaseDelayedCallback.resolve();
    await delayedCallback;

    expect(delayedToken).toBe('turn-token-a');
    expect(requests).toHaveLength(0);
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

  it('suspendSession waits for the committed-message safe phase before exporting state (ctx-6nu)', async () => {
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
    const reachedCommit = createDeferred<void>();
    const turnPromise = (async () => {
      let count = 0;
      const payloadCases: string[] = [];
      for await (const _event of deliverTurn(createDeliverTurnRequest(session.sessionId, 'turn-wait-safe'))) {
        payloadCases.push(_event.payload.case ?? 'missing');
        count++;
        if (count === 1) reachedToolStart.resolve();
        if (count === 2) reachedToolEnd.resolve();
        if (count === 3) reachedCommit.resolve();
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

    // A tool result alone is not enough: the assistant message must be
    // committed before the runner exports checkpoint state.
    stream.emitEvent({ type: 'tool_call_end', id: 'call-1', result: 'ok', durationMs: 1 });
    await reachedToolEnd.promise;
    await new Promise((resolve) => setImmediate(resolve));
    expect(exportState).not.toHaveBeenCalled();

    stream.emitEvent({
      type: 'message_committed',
      role: 'assistant',
      content: 'Done',
      turnId: 'turn-wait-safe',
      messageSeq: 0,
    });
    await reachedCommit.promise;

    // Now suspend should be allowed to proceed.
    const response = await suspendPromise;
    expect(exportState).toHaveBeenCalledTimes(1);
    expect(response.sessionCheckpoint).toBeDefined();
    await expect(turnPromise).resolves.toEqual(['agentEvent', 'agentEvent', 'messageCommitted']);

    stream.finish();
    await killSession().catch(() => undefined);
  });

  it('does not suspend between a final tool result and the assistant commit (ctx-2c7d)', async () => {
    const { deliverTurn, killSession, openSession, suspendSession } = await importRunner();
    const stream = createControllableGenerator();
    const assistantMessage = {
      id: 'assistant-final',
      role: 'assistant',
      content: 'Final answer after tool.',
    };
    let committed = false;
    const exportState = vi.fn(async () => ({
      stateVersion: '2',
      payload: {
        transcript: committed ? [assistantMessage] : [],
      },
    }));

    mocks.harnessOpenSession.mockResolvedValue({
      deliverTurn: stream.generator,
      exportState,
      close: mocks.harnessClose,
    });

    const session = await openSession(createOpenSessionRequest('/tmp/suspend-after-tool-before-commit'), {});

    const reachedToolStart = createDeferred<void>();
    const reachedToolEnd = createDeferred<void>();
    const reachedCommit = createDeferred<void>();
    const turnPromise = (async () => {
      const payloadCases: string[] = [];
      for await (const event of deliverTurn(createDeliverTurnRequest(session.sessionId, 'turn-suspend-commit'))) {
        payloadCases.push(event.payload.case ?? 'missing');
        if (payloadCases.length === 1) reachedToolStart.resolve();
        if (payloadCases.length === 2) reachedToolEnd.resolve();
        if (payloadCases.length === 3) reachedCommit.resolve();
      }
      return payloadCases;
    })();

    stream.emitEvent({ type: 'tool_call_start', id: 'call-1', name: 'op', args: {} });
    await reachedToolStart.promise;

    const suspendPromise = suspendSession('wait-for-commit', session.sessionId, 30_000);
    await new Promise((resolve) => setImmediate(resolve));
    expect(exportState).not.toHaveBeenCalled();

    stream.emitEvent({ type: 'tool_call_end', id: 'call-1', result: 'ok', durationMs: 1 });
    await reachedToolEnd.promise;
    await new Promise((resolve) => setImmediate(resolve));
    expect(exportState).not.toHaveBeenCalled();

    committed = true;
    stream.emitEvent({
      type: 'message_committed',
      role: 'assistant',
      content: assistantMessage.content,
      turnId: 'turn-suspend-commit',
      messageSeq: 0,
    });
    await reachedCommit.promise;

    const response = await suspendPromise;
    expect(exportState).toHaveBeenCalledTimes(1);
    expect(response.sessionCheckpoint?.harnessState).toEqual({
      stateVersion: '2',
      payload: {
        transcript: [assistantMessage],
      },
    });
    await expect(turnPromise).resolves.toEqual(['agentEvent', 'agentEvent', 'messageCommitted']);

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

    stream.finish();
    await firstTurnPromise;
    await killSession();
  });

  it('propagates Connect request cancellation through the runner to the harness', async () => {
    const { handleDeliverTurn } = await import('../daemon.js');
    const { openSession } = await importRunner();
    const harnessSawSignal = createDeferred<AbortSignal>();

    mocks.harnessOpenSession.mockResolvedValue({
      deliverTurn: async function* (
        _input: unknown,
        context: { signal?: AbortSignal },
      ) {
        if (!context.signal) {
          throw new Error('runner omitted the request abort signal');
        }
        harnessSawSignal.resolve(context.signal);
        await new Promise<void>((resolve) => {
          if (context.signal?.aborted) {
            resolve();
            return;
          }
          context.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        yield { type: 'done', result: 'should be fenced before delivery' } satisfies AgentEvent;
      },
      exportState: async () => ({ stateVersion: '2', payload: {} }),
      close: mocks.harnessClose,
    });

    const session = await openSession(createOpenSessionRequest('/tmp/connect-abort'), {});
    const controller = new AbortController();
    const context = {
      signal: controller.signal,
    } as unknown as HandlerContext;
    const stream = handleDeliverTurn(
      createDeliverTurnRequest(session.sessionId, 'turn-connect-abort'),
      context,
    );
    const nextEvent = stream.next();

    const harnessSignal = await harnessSawSignal.promise;
    expect(harnessSignal.aborted).toBe(false);
    controller.abort(new Error('lease ownership lost'));

    expect(harnessSignal.aborted).toBe(true);
    await expect(nextEvent).resolves.toMatchObject({
      value: {
        payload: {
          case: 'turnFailed',
        },
      },
    });
  });

  it('does not redeliver a completed turn to the harness on the same daemon', async () => {
    const { deliverTurn, openSession } = await importRunner();
    const harnessDeliverTurn = vi.fn(async function* () {
      yield { type: 'done', result: 'ok' } satisfies AgentEvent;
    });
    mocks.harnessOpenSession.mockResolvedValue({
      deliverTurn: harnessDeliverTurn,
      exportState: async () => ({ stateVersion: '2', payload: {} }),
      close: mocks.harnessClose,
    });

    const session = await openSession(createOpenSessionRequest('/tmp/completed-turn-dedupe'), {});
    const request = createDeliverTurnRequest(session.sessionId, 'turn-stable');
    const firstCases = [];
    for await (const event of deliverTurn(request)) {
      firstCases.push(event.payload.case);
    }
    const retryCases = [];
    for await (const event of deliverTurn(request)) {
      retryCases.push(event.payload.case);
    }

    expect(firstCases).toEqual(['agentEvent', 'turnCompleted']);
    expect(retryCases).toEqual(['turnCompleted']);
    expect(harnessDeliverTurn).toHaveBeenCalledTimes(1);
  });

  it('does not redeliver the last completed turn restored from a checkpoint', async () => {
    const { deliverTurn, openSession } = await importRunner();
    const harnessDeliverTurn = vi.fn(async function* () {
      yield { type: 'done', result: 'duplicate' } satisfies AgentEvent;
    });
    mocks.harnessOpenSession.mockResolvedValue({
      deliverTurn: harnessDeliverTurn,
      exportState: async () => ({ stateVersion: '2', payload: {} }),
      close: mocks.harnessClose,
    });
    const req = create(OpenSessionRequestSchema, {
      bootstrap: {
        case: 'restore',
        value: create(RestoreBootstrapSchema, {
          sessionCheckpoint: create(SessionCheckpointSchema, {
            checkpointVersion: 2,
            sessionId: 'session-restored-dedupe',
            conversationId: 'conv-restored-dedupe',
            harnessName: 'langgraph',
            cursor: {
              nextMessageSeq: 0n,
              lastCompletedTurnId: 'turn-restored',
            },
            workspaceRef: {
              strategy: 'dir',
              reference: '/tmp/restored-dedupe',
            },
            harnessState: {
              stateVersion: '2',
              payload: {},
            },
          }),
          agentId: 'agent-1',
          harnessConfigJson: '{}',
          systemPrompt: 'Prompt',
        }),
      },
    });

    const session = await openSession(req, {});
    const cases = [];
    for await (const event of deliverTurn(
      createDeliverTurnRequest(session.sessionId, 'turn-restored'),
    )) {
      cases.push(event.payload.case);
    }

    expect(cases).toEqual(['turnCompleted']);
    expect(harnessDeliverTurn).not.toHaveBeenCalled();
  });
});
