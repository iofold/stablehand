import { create } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import {
  DeliverTurnRequestSchema,
  FreshBootstrapSchema,
  MessageSchema,
  OpenSessionRequestSchema,
  RestoreBootstrapSchema,
  ToolCallSchema,
  ToolLocation,
  ToolMetadataSchema,
  TurnDeliveryCapabilitySchema,
  WorkspaceRefSchema,
  type SessionCheckpoint as ProtoSessionCheckpoint,
  type SessionEvent,
} from '@stablehand/proto/sandbox/v1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AgentEvent,
  HarnessSessionConfig,
  HarnessTurnContext,
  HarnessTurnInput,
} from '../../harness/types.js';
import type { OrchestratorServiceClient } from '../tool-proxy.js';

/**
 * ctx-2jp0: a turn parked on an approval must survive orchestrator restarts.
 *
 * The run calls request-approval, an orchestrator tool whose RequestTool
 * call stays open until a person decides. When the orchestrator is replaced
 * after the run has waited longer than the orphan grace window, the sandbox
 * must not hand the harness a made-up tool failure: the model would answer
 * it and the sandbox would record the turn as completed, so the late
 * approval (delivered as a continuation of the same turn) would be
 * acknowledged as a duplicate without running anything.
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

const SESSION_ID = 'session-parked';
const TURN_ID = 'turn-parked';
const GRACE_MS = 150;

const approvalTool = create(ToolMetadataSchema, {
  name: 'request-approval',
  description: 'Ask a person to approve',
  inputSchemaJson: '{"type":"object"}',
  location: ToolLocation.ORCHESTRATOR,
});

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
        workspaceDir: '/tmp/parked-approval',
        sessionId: SESSION_ID,
        tools: [approvalTool],
      }),
    },
  });
}

function restoreRequest(checkpoint: ProtoSessionCheckpoint) {
  return create(OpenSessionRequestSchema, {
    bootstrap: {
      case: 'restore',
      value: create(RestoreBootstrapSchema, {
        // The orchestrator points the restored session at the conversation
        // workspace it captured with the checkpoint.
        sessionCheckpoint: {
          ...checkpoint,
          workspaceRef: create(WorkspaceRefSchema, {
            strategy: 'dir',
            reference: '/tmp/parked-approval',
          }),
        },
        agentId: 'agent-1',
        harnessConfigJson: '{}',
        systemPrompt: 'Prompt',
        tools: [approvalTool],
      }),
    },
  });
}

function capability(ownerId: string, fenceToken: number) {
  return create(TurnDeliveryCapabilitySchema, {
    ownerId,
    fenceToken: BigInt(fenceToken),
    leaseExpiresAtMs: BigInt(Date.now() + 60_000),
    restoreFenceToken: 0n,
    containerId: 'container-1',
    agentId: 'agent-1',
    signature: 'stablehand-open-turn-delivery-capability-v1',
  });
}

function originalDelivery() {
  return create(DeliverTurnRequestSchema, {
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    messages: [create(MessageSchema, { id: 'm-user', role: 'user', content: 'ask, then write the file' })],
    deliveryCapability: capability('orchestrator-1', 1),
  });
}

/** What the durable resume path delivers once the card is approved. */
function approvalContinuation(ownerId: string, fenceToken: number) {
  return create(DeliverTurnRequestSchema, {
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    messages: [
      create(MessageSchema, {
        id: 'm-approval-call',
        role: 'assistant',
        content: '',
        toolCalls: [create(ToolCallSchema, {
          id: 'call-approval',
          name: 'request-approval',
          argumentsJson: '{"reason":"write the file"}',
        })],
      }),
      create(MessageSchema, {
        id: 'm-approval-result',
        role: 'tool',
        content: 'APPROVED',
        toolCallId: 'call-approval',
      }),
    ],
    deliveryCapability: capability(ownerId, fenceToken),
  });
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

interface ParkedRun {
  /** Each harness invocation's input messages, in order. */
  harnessInputs: string[][];
  /** Resolves when the first harness invocation has returned. */
  firstRunSettled: Promise<{ toolOutcome: string; aborted: boolean }>;
  /** The orchestrator holding the approval dies (restart #1). */
  killOrchestrator: () => void;
  orchestratorClient: OrchestratorServiceClient;
}

/**
 * A harness that calls request-approval and, like a real model behind a
 * tool error boundary, answers whatever the tool returns and ends the turn.
 */
function parkedRun(): ParkedRun {
  const harnessInputs: string[][] = [];
  const toolCallStarted = deferred();
  const killed = deferred<never>();
  void killed.promise.catch(() => undefined);
  const firstRun = deferred<{ toolOutcome: string; aborted: boolean }>();

  let calls = 0;
  const requestTool = vi.fn<OrchestratorServiceClient['requestTool']>(async () => {
    calls += 1;
    if (calls === 1) {
      // The approval is pending: the orchestrator keeps the call open.
      toolCallStarted.resolve();
      return await killed.promise;
    }
    // The successor orchestrators (restart #1 and #2) do not own the
    // delivery: the dedup row is still claimed by the dead process, and the
    // replacement is briefly unreachable while it boots.
    throw calls % 2 === 0
      ? new ConnectError('connect ECONNREFUSED 172.18.0.5:3001', Code.Unavailable)
      : new ConnectError('Tool request-approval already executing for request rpc-1', Code.Unavailable);
  });

  mocks.harnessOpenSession.mockImplementation(async (config: HarnessSessionConfig) => ({
    deliverTurn: async function* (input: HarnessTurnInput, context: HarnessTurnContext) {
      harnessInputs.push(input.messages.map((message) => `${message.role}:${message.content}`));
      if (harnessInputs.length > 1) {
        yield { type: 'text_delta', content: 'approved; writing the file' } satisfies AgentEvent;
        yield { type: 'done', result: 'wrote the file' } satisfies AgentEvent;
        return;
      }
      yield {
        type: 'tool_call_start',
        id: 'call-approval',
        name: 'request-approval',
        args: { reason: 'write the file' },
      } satisfies AgentEvent;
      let toolOutcome: string;
      try {
        toolOutcome = await config.tools[0]!.handler({ reason: 'write the file' }, {
          agentId: config.agentId,
          conversationId: config.conversationId,
          workspaceDir: config.workspaceDir,
        });
      } catch (error) {
        toolOutcome = `tool error: ${error instanceof Error ? error.message : String(error)}`;
      }
      firstRun.resolve({ toolOutcome, aborted: context.signal?.aborted ?? false });
      yield {
        type: 'tool_call_end',
        id: 'call-approval',
        result: toolOutcome,
        durationMs: 1,
      } satisfies AgentEvent;
      yield { type: 'text_delta', content: `not approved (${toolOutcome}); skipping` } satisfies AgentEvent;
      yield { type: 'done', result: 'skipped' } satisfies AgentEvent;
    },
    exportState: async () => ({ stateVersion: '2', payload: { transcript: [] } }),
    close: mocks.harnessClose,
  }));

  return {
    harnessInputs,
    firstRunSettled: firstRun.promise,
    killOrchestrator: () => killed.reject(new ConnectError('[aborted] socket hang up', Code.Aborted)),
    orchestratorClient: {
      requestTool,
      registerArtifact: vi.fn(),
      resolveArtifact: vi.fn(),
    },
  };
}

/**
 * Park the turn, wait past the grace window, then replace the orchestrator
 * twice without anyone re-attaching. Returns the original stream's events.
 */
async function parkAndRestartTwice(run: ParkedRun): Promise<{
  toolOutcome: string;
  aborted: boolean;
}> {
  const { deliverTurn } = await importRunner();
  const orchestrator1 = new AbortController();
  const originalStream = collect(
    deliverTurn(originalDelivery(), { signal: orchestrator1.signal }),
    [],
  );
  await vi.waitFor(() => expect(run.orchestratorClient.requestTool).toHaveBeenCalledTimes(1));

  // The run waits for its approval longer than the orphan grace window.
  await sleep(GRACE_MS * 3);

  // Restart #1: the orchestrator holding the delivery and the open
  // RequestTool call dies. Restart #2 follows while nobody re-attaches.
  orchestrator1.abort(new Error('orchestrator killed'));
  run.killOrchestrator();
  await originalStream;
  return await run.firstRunSettled;
}

describe('approval parked across orchestrator restarts (ctx-2jp0)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('STABLEHAND_TURN_ORPHAN_GRACE_MS', String(GRACE_MS));
    process.env.ORCHESTRATOR_URL = 'http://127.0.0.1:3002';
  });

  afterEach(async () => {
    delete process.env.ORCHESTRATOR_URL;
    const { killSession, resetOrchestratorClient } = await importRunner();
    await killSession();
    resetOrchestratorClient();
    vi.unstubAllEnvs();
  });

  it('stops the parked run instead of answering it, so a late approval runs the harness on the same sandbox', async () => {
    const { deliverTurn, openSession } = await importRunner();
    const run = parkedRun();
    await openSession(openRequest(), {}, { orchestratorClient: run.orchestratorClient });

    const firstRun = await parkAndRestartTwice(run);
    // The harness never sees a decision nobody made.
    expect(firstRun.aborted).toBe(true);

    // The approval arrives minutes later, long after the journal expired.
    await sleep(GRACE_MS * 2);
    const resumed: SessionEvent[] = [];
    await collect(deliverTurn(approvalContinuation('orchestrator-3', 3)), resumed);

    expect(run.harnessInputs).toHaveLength(2);
    expect(run.harnessInputs[1]).toEqual(['assistant:', 'tool:APPROVED']);
    expect(resumed.map(describeEvent)).toEqual([
      'text:approved; writing the file',
      'agent:done',
      'turnCompleted',
    ]);
  });

  it('keeps the parked run resumable through an idle checkpoint and a restore onto a new container', async () => {
    const { deliverTurn, killSession, openSession, suspendSession } = await importRunner();
    const run = parkedRun();
    await openSession(openRequest(), {}, { orchestratorClient: run.orchestratorClient });

    const firstRun = await parkAndRestartTwice(run);
    expect(firstRun.aborted).toBe(true);

    // Idle checkpoint after about five minutes, then the container goes away
    // (for example, replaced by an upgraded harness image).
    await sleep(GRACE_MS * 2);
    const checkpoint = (await suspendSession('idle-checkpoint', SESSION_ID)).sessionCheckpoint;
    expect(checkpoint).toBeDefined();
    expect(checkpoint?.cursor?.lastCompletedTurnId ?? '').not.toBe(TURN_ID);
    await killSession(SESSION_ID);

    await openSession(restoreRequest(checkpoint!), {}, { orchestratorClient: run.orchestratorClient });
    const resumed: SessionEvent[] = [];
    await collect(deliverTurn(approvalContinuation('orchestrator-3', 3)), resumed);

    expect(run.harnessInputs).toHaveLength(2);
    expect(resumed.map(describeEvent)).toEqual([
      'text:approved; writing the file',
      'agent:done',
      'turnCompleted',
    ]);
  });
});
