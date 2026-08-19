import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentTurnService } from '../../packages/ctxmill/src/orchestrator/agent-turn-service.js';
import { TypedEventBus } from '../../packages/ctxmill/src/events/bus.js';
import { SpineConsumerRunner } from '../../packages/ctxmill/src/events/spine-consumer-runner.js';
import { CallbackDispatcher } from '../../packages/ctxmill/src/orchestrator/callback-dispatcher.js';
import { CanonicalLog } from '../../packages/ctxmill/src/orchestrator/canonical/canonical-log.js';
import { reconcilePendingMessagePublishesOnStartup } from '../../packages/ctxmill/src/orchestrator/message-publisher.js';
import { reconcileStrandedTurnsOnStartup } from '../../packages/ctxmill/src/orchestrator/turn-reconciler.js';
import { TurnFinalizer } from '../../packages/ctxmill/src/orchestrator/turn-finalizer.js';
import { TurnStartupService } from '../../packages/ctxmill/src/orchestrator/turn-startup-service.js';
import { TurnSecretEnvelopeCodec } from '../../packages/ctxmill/src/orchestrator/turn-secret-envelope.js';

const TEST_TURN_SECRET_CODEC = new TurnSecretEnvelopeCodec(Buffer.alloc(32, 7));
import { MessageListResponseSchema } from '../../packages/contracts/src/index.js';
import { toApiMessage } from '../../packages/ctxmill/src/orchestrator/routes/agent-helpers.js';
import { createWebhookRelaySpineConsumer } from '../../packages/ctxmill/src/orchestrator/webhook-relay.js';
import type { AgentDefinition, Message } from '@ctxmill/sandbox-daemon';
import type { AgentSessionEvent, MessageCommittedEvent } from '../../packages/shared/src/events.js';
import { createTestDb, type TestDb } from '../utils/test-db.js';
import {
  TestTurnRegistry,
  createTestSandboxSessionManager,
} from '../utils/test-turn-registry.js';
import {
  createCanonicalWireHarness,
  flushWire,
} from '../utils/event-bus-test-helpers.js';

type StreamEvent = AgentSessionEvent | MessageCommittedEvent;

async function* eventStream(events: readonly StreamEvent[]) {
  for (const event of events) {
    yield event;
  }
}

function makeAgentDef(): AgentDefinition {
  return {
    name: 'test-agent',
    harness: 'langgraph',
    harnessConfig: { provider: 'openai', model: 'gpt-5.4-mini' },
    systemPrompt: 'You are a test agent.',
    tools: ['search', 'weather'],
  };
}

function makeMessages(agentId: string): Message[] {
  return [
    {
      id: 'user-msg-1',
      agentId,
      role: 'user',
      content: 'Hello',
      createdAt: new Date('2026-03-21T00:00:00.000Z'),
    },
  ];
}

function makeCommittedEvent(
  overrides: Partial<MessageCommittedEvent> = {},
): MessageCommittedEvent {
  return {
    type: 'MESSAGE_COMMITTED',
    timestamp: 1,
    runId: 'run-1',
    role: 'assistant',
    content: 'Final response',
    turnId: 'run-1',
    messageSeq: 1,
    ...overrides,
  };
}

describe('Agent turn message persistence integration', () => {
  let testDb: TestDb;

  beforeEach(async () => {
    testDb = await createTestDb();
  }, 30_000);

  afterEach(async () => {
    await testDb?.close();
  }, 30_000);

  async function executeAndReadMessages(events: StreamEvent[]) {
    const agent = await testDb.repo.createAgent({
      name: 'message-persistence-agent',
      harness: 'langgraph',
      harnessConfig: JSON.stringify({ provider: 'openai', model: 'gpt-5.4-mini' }),
      systemPrompt: 'You are a test agent.',
      tools: ['search', 'weather'],
    });
    const conversation = await testDb.repo.createConversation(agent.id);
    const turn = await testDb.repo.createTurn({
      agentId: agent.id,
      conversationId: conversation.id,
      mode: 'interactive',
      taskDescription: 'message persistence test',
    });
    const sandboxSession = await testDb.repo.createSandboxSession({
      conversationId: conversation.id,
      agentId: agent.id,
      harnessName: agent.harness,
    });
    const turnRegistry = new TestTurnRegistry();
    const harness = createCanonicalWireHarness({
      db: testDb.repo,
      messageEventsOnly: true,
    });

    const service = new AgentTurnService({
      sessionTurnService: {
        executeSessionTurn: vi.fn().mockReturnValue(eventStream(events)),
      } as never,
      db: testDb.repo,
      sessionManager: createTestSandboxSessionManager(turnRegistry, {
        sandboxSessionId: sandboxSession.id,
      }) as never,
      eventBus: harness.bus,
    });

    await service.executeTurn({
      agentDef: makeAgentDef(),
      messages: makeMessages(agent.id),
      agentId: agent.id,
      conversationId: conversation.id,
      turnId: turn.id,
      mode: 'interactive',
      taskDescription: 'message persistence test',
    });

    return testDb.repo.getMessages(conversation.id);
  }

  it('persists messages in OpenAI standard format with interleaved tool calls', async () => {
    const messages = await executeAndReadMessages([
      { type: 'TEXT_MESSAGE_CONTENT', timestamp: 1, runId: 'run-1', messageId: 'm1', delta: 'Let me check.' },
      { type: 'TOOL_CALL_START', timestamp: 2, runId: 'run-1', toolCallId: 'tc1', toolCallName: 'search' },
      { type: 'TOOL_CALL_ARGS', timestamp: 3, runId: 'run-1', toolCallId: 'tc1', args: '{"q":"test"}' },
      { type: 'TOOL_CALL_END', timestamp: 4, runId: 'run-1', toolCallId: 'tc1' },
      { type: 'TOOL_CALL_RESULT', timestamp: 5, runId: 'run-1', toolCallId: 'tc1', result: 'Found 3 results', toolCallName: 'search' },
      { type: 'TEXT_MESSAGE_CONTENT', timestamp: 6, runId: 'run-1', messageId: 'm1', delta: 'Based on the results:' },
      makeCommittedEvent({ timestamp: 7, content: 'Based on the results:' }),
      { type: 'RUN_FINISHED', timestamp: 8, runId: 'run-1' },
    ]);

    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({
      role: 'assistant',
      content: 'Let me check.',
      toolCalls: [
        {
          id: 'tc1',
          name: 'search',
          args: '{"q":"test"}',
          status: 'complete',
        },
      ],
    });
    expect(messages[1]).toMatchObject({
      role: 'tool',
      toolCallId: 'tc1',
      content: 'Found 3 results',
    });
    expect(messages[2]).toMatchObject({
      role: 'assistant',
      content: 'Based on the results:',
    });
  });

  it('persists parallel tool calls correctly', async () => {
    const messages = await executeAndReadMessages([
      { type: 'TEXT_MESSAGE_CONTENT', timestamp: 1, runId: 'run-1', messageId: 'm1', delta: 'Checking both.' },
      { type: 'TOOL_CALL_START', timestamp: 2, runId: 'run-1', toolCallId: 'tc1', toolCallName: 'search' },
      { type: 'TOOL_CALL_ARGS', timestamp: 3, runId: 'run-1', toolCallId: 'tc1', args: '{"q":"alpha"}' },
      { type: 'TOOL_CALL_START', timestamp: 4, runId: 'run-1', toolCallId: 'tc2', toolCallName: 'weather' },
      { type: 'TOOL_CALL_ARGS', timestamp: 5, runId: 'run-1', toolCallId: 'tc2', args: '{"city":"SF"}' },
      { type: 'TOOL_CALL_END', timestamp: 6, runId: 'run-1', toolCallId: 'tc1' },
      { type: 'TOOL_CALL_END', timestamp: 7, runId: 'run-1', toolCallId: 'tc2' },
      { type: 'TOOL_CALL_RESULT', timestamp: 8, runId: 'run-1', toolCallId: 'tc1', result: 'Alpha result', toolCallName: 'search' },
      { type: 'TOOL_CALL_RESULT', timestamp: 9, runId: 'run-1', toolCallId: 'tc2', result: 'Sunny, 72°F', toolCallName: 'weather' },
      makeCommittedEvent({ timestamp: 10, content: '' }),
      { type: 'RUN_FINISHED', timestamp: 11, runId: 'run-1' },
    ]);

    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({
      role: 'assistant',
      content: 'Checking both.',
    });
    expect(messages[0].toolCalls).toEqual([
      {
        id: 'tc1',
        name: 'search',
        args: '{"q":"alpha"}',
        status: 'complete',
      },
      {
        id: 'tc2',
        name: 'weather',
        args: '{"city":"SF"}',
        status: 'complete',
      },
    ]);
    expect(messages[1]).toMatchObject({ role: 'tool', toolCallId: 'tc1', content: 'Alpha result' });
    expect(messages[2]).toMatchObject({ role: 'tool', toolCallId: 'tc2', content: 'Sunny, 72°F' });
  });

  it('persists each tool_call part on exactly one assistant message (ctx-hb4b)', async () => {
    const messages = await executeAndReadMessages([
      { type: 'TEXT_MESSAGE_CONTENT', timestamp: 1, runId: 'run-1', messageId: 'm1', delta: 'Let me compute.' },
      { type: 'TOOL_CALL_START', timestamp: 2, runId: 'run-1', toolCallId: 'tc1', toolCallName: 'search' },
      { type: 'TOOL_CALL_ARGS', timestamp: 3, runId: 'run-1', toolCallId: 'tc1', args: '{"q":"2+2"}' },
      { type: 'TOOL_CALL_END', timestamp: 4, runId: 'run-1', toolCallId: 'tc1' },
      { type: 'TOOL_CALL_RESULT', timestamp: 5, runId: 'run-1', toolCallId: 'tc1', result: '4', toolCallName: 'search' },
      { type: 'TEXT_MESSAGE_CONTENT', timestamp: 6, runId: 'run-1', messageId: 'm1', delta: 'The answer is 4.' },
      makeCommittedEvent({ timestamp: 7, content: 'The answer is 4.' }),
      { type: 'RUN_FINISHED', timestamp: 8, runId: 'run-1' },
    ]);

    expect(messages).toHaveLength(3);

    type PersistedPart = { type: string; id?: string; content?: string };
    const toolCallPartIds = messages.flatMap((message) =>
      ((message.parts ?? []) as PersistedPart[])
        .filter((part) => part.type === 'tool_call')
        .map((part) => part.id));
    expect(toolCallPartIds).toEqual(['tc1']);

    const finalMessage = messages[2];
    expect(finalMessage).toMatchObject({ role: 'assistant', content: 'The answer is 4.' });
    expect(((finalMessage.parts ?? []) as PersistedPart[]).map((part) => part.type)).toEqual(['text']);
  });

  it('keeps text between tool calls on the flushed message only (ctx-hb4b)', async () => {
    const messages = await executeAndReadMessages([
      { type: 'TEXT_MESSAGE_CONTENT', timestamp: 1, runId: 'run-1', messageId: 'm1', delta: 'First lookup.' },
      { type: 'TOOL_CALL_START', timestamp: 2, runId: 'run-1', toolCallId: 'tc1', toolCallName: 'search' },
      { type: 'TOOL_CALL_END', timestamp: 3, runId: 'run-1', toolCallId: 'tc1' },
      { type: 'TOOL_CALL_RESULT', timestamp: 4, runId: 'run-1', toolCallId: 'tc1', result: 'A', toolCallName: 'search' },
      { type: 'TEXT_MESSAGE_CONTENT', timestamp: 5, runId: 'run-1', messageId: 'm1', delta: 'Now the weather.' },
      { type: 'TOOL_CALL_START', timestamp: 6, runId: 'run-1', toolCallId: 'tc2', toolCallName: 'weather' },
      { type: 'TOOL_CALL_END', timestamp: 7, runId: 'run-1', toolCallId: 'tc2' },
      { type: 'TOOL_CALL_RESULT', timestamp: 8, runId: 'run-1', toolCallId: 'tc2', result: 'Sunny', toolCallName: 'weather' },
      { type: 'TEXT_MESSAGE_CONTENT', timestamp: 9, runId: 'run-1', messageId: 'm1', delta: 'All done.' },
      makeCommittedEvent({ timestamp: 10, content: 'All done.' }),
      { type: 'RUN_FINISHED', timestamp: 11, runId: 'run-1' },
    ]);

    type PersistedPart = { type: string; id?: string; content?: string };
    const assistantMessages = messages.filter((message) => message.role === 'assistant');
    expect(assistantMessages).toHaveLength(2);

    const [flushed, final] = assistantMessages;
    const flushedToolCallIds = ((flushed.parts ?? []) as PersistedPart[])
      .filter((part) => part.type === 'tool_call')
      .map((part) => part.id);
    expect(flushedToolCallIds).toEqual(['tc1', 'tc2']);
    expect(((flushed.parts ?? []) as PersistedPart[])
      .filter((part) => part.type === 'text')
      .map((part) => part.content)).toEqual(['First lookup.', 'Now the weather.']);

    expect(final.content).toBe('All done.');
    expect(((final.parts ?? []) as PersistedPart[]).filter((part) => part.type === 'tool_call')).toEqual([]);
    expect(final.content).not.toContain('Now the weather.');
  });

  it('converges canonical message revisions with the REST transcript projection', async () => {
    const agent = await testDb.repo.createAgent({
      name: 'message-parity-agent',
      harness: 'langgraph',
      harnessConfig: JSON.stringify({ provider: 'openai', model: 'gpt-5.4-mini' }),
      systemPrompt: 'You are a test agent.',
      tools: ['search', 'weather'],
    });
    const conversation = await testDb.repo.createConversation(agent.id);
    const turn = await testDb.repo.createTurn({
      agentId: agent.id,
      conversationId: conversation.id,
      mode: 'interactive',
      taskDescription: 'canonical message parity test',
    });
    const sandboxSession = await testDb.repo.createSandboxSession({
      conversationId: conversation.id,
      agentId: agent.id,
      harnessName: agent.harness,
    });
    const harness = createCanonicalWireHarness({
      db: testDb.repo,
      messageEventsOnly: true,
    });
    const turnRegistry = new TestTurnRegistry(harness.bus);
    const events: StreamEvent[] = [
      { type: 'TEXT_MESSAGE_CONTENT', timestamp: 1, runId: turn.id, messageId: 'm1', delta: 'First lookup.' },
      { type: 'TOOL_CALL_START', timestamp: 2, runId: turn.id, toolCallId: 'tc1', toolCallName: 'search' },
      { type: 'TOOL_CALL_END', timestamp: 3, runId: turn.id, toolCallId: 'tc1' },
      { type: 'TOOL_CALL_RESULT', timestamp: 4, runId: turn.id, toolCallId: 'tc1', result: 'A', toolCallName: 'search' },
      { type: 'TEXT_MESSAGE_CONTENT', timestamp: 5, runId: turn.id, messageId: 'm2', delta: 'Now the weather.' },
      { type: 'TOOL_CALL_START', timestamp: 6, runId: turn.id, toolCallId: 'tc2', toolCallName: 'weather' },
      { type: 'TOOL_CALL_END', timestamp: 7, runId: turn.id, toolCallId: 'tc2' },
      { type: 'TOOL_CALL_RESULT', timestamp: 8, runId: turn.id, toolCallId: 'tc2', result: 'Sunny', toolCallName: 'weather' },
      { type: 'TEXT_MESSAGE_CONTENT', timestamp: 9, runId: turn.id, messageId: 'm3', delta: 'One final lookup.' },
      { type: 'TOOL_CALL_START', timestamp: 10, runId: turn.id, toolCallId: 'tc3', toolCallName: 'search' },
      { type: 'TOOL_CALL_END', timestamp: 11, runId: turn.id, toolCallId: 'tc3' },
      { type: 'TOOL_CALL_RESULT', timestamp: 12, runId: turn.id, toolCallId: 'tc3', result: 'C', toolCallName: 'search' },
      { type: 'TEXT_MESSAGE_CONTENT', timestamp: 13, runId: turn.id, messageId: 'm4', delta: 'Done.' },
      makeCommittedEvent({
        timestamp: 14,
        runId: turn.id,
        turnId: turn.id,
        content: 'Done.',
        messageSeq: 1,
      }),
      { type: 'RUN_FINISHED', timestamp: 15, runId: turn.id },
    ];
    const service = new AgentTurnService({
      sessionTurnService: {
        executeSessionTurn: vi.fn().mockReturnValue(eventStream(events)),
      } as never,
      db: testDb.repo,
      sessionManager: createTestSandboxSessionManager(turnRegistry, {
        sandboxSessionId: sandboxSession.id,
      }) as never,
      eventBus: harness.bus,
    });

    await service.executeTurn({
      agentDef: makeAgentDef(),
      messages: makeMessages(agent.id),
      agentId: agent.id,
      conversationId: conversation.id,
      turnId: turn.id,
      mode: 'interactive',
      taskDescription: 'canonical message parity test',
    });
    await flushWire();

    const wireMessages = new Map<string, Record<string, unknown>>();
    const wireRevisions = new Map<string, number>();
    for (const { event } of harness.wire) {
      if (event.type !== 'CUSTOM' || typeof event.messageId !== 'string') continue;
      if (event.name === 'ctxmill.message.committed') {
        if (!wireMessages.has(event.messageId)) {
          wireMessages.set(event.messageId, event);
          wireRevisions.set(event.messageId, 0);
        }
      } else if (
        event.name === 'ctxmill.message.updated'
        && typeof event.messageRevision === 'number'
        && event.messageRevision > (wireRevisions.get(event.messageId) ?? -1)
      ) {
        wireMessages.set(event.messageId, event);
        wireRevisions.set(event.messageId, event.messageRevision);
      }
    }

    expect(Array.from(wireRevisions.values())).toEqual([2, 0, 0, 0, 0]);

    const restMessages = MessageListResponseSchema.parse(
      (await testDb.repo.getMessages(conversation.id)).map(toApiMessage),
    );
    const normalizedRest = restMessages
      .filter((message) => message.role === 'assistant' || message.role === 'tool')
      .map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        parts: message.parts,
        toolCalls: message.toolCalls,
      }));
    const normalizedWire = Array.from(wireMessages.values())
      .sort((left, right) => Number(left.messageSeq) - Number(right.messageSeq))
      .map((message) => ({
        id: message.messageId,
        role: message.role,
        content: message.content,
        parts: message.parts,
        toolCalls: message.toolCalls,
      }));

    expect(normalizedWire).toEqual(normalizedRest);
    expect(normalizedWire.map((message) => message.role)).toEqual([
      'assistant',
      'tool',
      'tool',
      'tool',
      'assistant',
    ]);
  });

  it('simple text response without tools persists as a single assistant message', async () => {
    const messages = await executeAndReadMessages([
      { type: 'TEXT_MESSAGE_CONTENT', timestamp: 1, runId: 'run-1', messageId: 'm1', delta: 'Hello world' },
      makeCommittedEvent({ timestamp: 2, content: 'Hello world' }),
      { type: 'RUN_FINISHED', timestamp: 3, runId: 'run-1' },
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: 'assistant',
      content: 'Hello world',
      toolCallId: null,
      toolCalls: null,
    });
  });

  it('rebuilds an unpublished baseline and latest revision after restart, including webhook outbox', async () => {
    const agent = await testDb.repo.createAgent({
      name: 'restart-message-agent',
      harness: 'langgraph',
      harnessConfig: '{}',
      systemPrompt: 'test',
      tools: [],
    });
    const conversation = await testDb.repo.createConversation(agent.id);
    const turn = await testDb.repo.createTurn({
      agentId: agent.id,
      conversationId: conversation.id,
      mode: 'interactive',
    });
    await testDb.repo.createWebhook({
      agentId: agent.id,
      url: 'https://example.test/message-events',
      events: ['message.committed', 'message.updated'],
      secret: 'test-secret',
    });

    const baseline = await testDb.repo.addCanonicalMessage({
      agentId: agent.id,
      conversationId: conversation.id,
      turnId: turn.id,
      role: 'assistant',
      content: 'Checking.',
      parts: [{ type: 'text', content: 'Checking.' }],
      toolCalls: [],
    });
    const staged = await testDb.repo.stageAssistantMessageUpdate(
      baseline.id,
      [{ id: 'tool-1', name: 'search', args: '{}', status: 'complete' }],
      [
        { type: 'text', content: 'Checking.' },
        { type: 'tool_call', id: 'tool-1', name: 'search', args: '{}', result: 'found', status: 'complete' },
      ],
    );
    expect(staged).toMatchObject({
      messageRevision: 1,
      publishedRevision: -1,
    });

    const canonicalLog = new CanonicalLog({ db: testDb.repo, logger: console });
    const eventBus = new TypedEventBus({
      persistEvent: async (type, _agentId, _payload, parsedPayload) => {
        await canonicalLog.ingest(type, parsedPayload ?? {});
      },
    });
    const callbackDispatcher = new CallbackDispatcher(testDb.repo);
    const runner = new SpineConsumerRunner({
      canonicalLog,
      db: testDb.repo,
      consumers: [
        createWebhookRelaySpineConsumer({ db: testDb.repo, callbackDispatcher }),
      ],
      logger: console,
    });
    await runner.start();

    const rebuilt = await reconcilePendingMessagePublishesOnStartup({
      db: testDb.repo,
      eventBus,
      logger: console,
    });
    await canonicalLog.drain();
    await runner.catchUpAll();

    expect(rebuilt).toBe(2);
    const replay = await canonicalLog.replayTurnTail(turn.id);
    expect(replay.map((frame) => frame.body.name)).toEqual([
      'ctxmill.message.committed',
      'ctxmill.message.updated',
    ]);
    expect(replay[1]?.body).toMatchObject({
      messageId: baseline.id,
      messageSeq: 0,
      messageRevision: 1,
      toolCalls: [{ id: 'tool-1', name: 'search', args: '{}', status: 'complete' }],
    });
    expect((await testDb.repo.getMessages(conversation.id))[0]).toMatchObject({
      messageRevision: 1,
      publishedRevision: 1,
    });
    expect((await testDb.repo.getCallbacksForAgent(agent.id))
      .map((callback) => callback.eventType)
      .sort()).toEqual(['message.committed', 'message.updated']);

    expect(await reconcilePendingMessagePublishesOnStartup({
      db: testDb.repo,
      eventBus,
      logger: console,
    })).toBe(0);
    expect(await canonicalLog.replayTurnTail(turn.id)).toHaveLength(2);
    runner.stop();
  });

  it('leaves queued turns for the dispatcher instead of executing them at boot (ctx-z5k0)', async () => {
    const agent = await testDb.repo.createAgent({
      name: 'queued-recovery-agent',
      harness: 'langgraph',
      harnessConfig: '{}',
      systemPrompt: 'test',
      tools: [],
    });
    const conversation = await testDb.repo.createConversation(agent.id);
    const userMessage = await testDb.repo.addMessage({
      agentId: agent.id,
      conversationId: conversation.id,
      role: 'user',
      content: 'survive the startup crash window',
      createdAt: 10,
    });
    const turn = await testDb.repo.createTurn({
      agentId: agent.id,
      conversationId: conversation.id,
      userMessageId: userMessage.id,
      mode: 'interactive',
      status: 'queued',
      queuedAt: 20,
      startedAt: 20,
    });
    // Stranded-shaped queued row (no user message) still fails honestly.
    const orphan = await testDb.repo.createTurn({
      agentId: agent.id,
      conversationId: conversation.id,
      mode: 'interactive',
      status: 'queued',
      startedAt: 21,
    });

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const canonicalLog = new CanonicalLog({ db: testDb.repo, logger });
    const eventBus = new TypedEventBus({
      persistEvent: async (type, _agentId, _payload, parsedPayload, context) => {
        await canonicalLog.ingest(type, parsedPayload ?? {}, context);
      },
    });
    const finalizer = new TurnFinalizer({ db: testDb.repo, eventBus, logger });

    const result = await reconcileStrandedTurnsOnStartup({
      db: testDb.repo,
      eventBus,
      finalizer,
      logger,
    }, 30);

    expect(result).toEqual(expect.objectContaining({
      failed: 1,
      redispatched: 0,
      skippedHitlParked: 0,
    }));
    // The dispatchable queued turn is untouched boot debt no longer.
    expect((await testDb.repo.getTurn(turn.id))?.status).toBe('queued');
    expect(await testDb.repo.getTurnFrames(turn.id)).toEqual([]);
    expect((await testDb.repo.getTurn(orphan.id))?.status).toBe('error');
  });

  it('dispatchQueuedTurn recovers a pre-boot queued turn under a fenced lease with prompt republication', async () => {
    const agent = await testDb.repo.createAgent({
      name: 'dispatch-recovery-agent',
      harness: 'langgraph',
      harnessConfig: '{}',
      systemPrompt: 'test',
      tools: [],
    });
    const conversation = await testDb.repo.createConversation(agent.id);
    const userMessage = await testDb.repo.addMessage({
      agentId: agent.id,
      conversationId: conversation.id,
      role: 'user',
      content: 'recover me with my prompt frames',
      createdAt: 10,
    });
    const turnId = 'dispatch-recovery-turn-1';
    await testDb.repo.createTurnWithSecretEnvelope({
      id: turnId,
      agentId: agent.id,
      conversationId: conversation.id,
      userMessageId: userMessage.id,
      mode: 'interactive',
      status: 'queued',
      queuedAt: 20,
      startedAt: 20,
    }, TEST_TURN_SECRET_CODEC.seal(turnId, {}));

    let captured: Record<string, unknown> | undefined;
    let releaseExecution: (() => void) | undefined;
    const executeTurn = vi.fn(async (params: Record<string, unknown>) => {
      captured = params;
      await new Promise<void>((resolve) => { releaseExecution = resolve; });
    });
    const service = new TurnStartupService({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      turnSecretEnvelopeCodec: TEST_TURN_SECRET_CODEC,
    });
    service.configureExecution({
      db: testDb.repo,
      agentTurnService: { executeTurn } as never,
    });

    expect(await service.dispatchQueuedTurn({
      turnId,
      agentId: agent.id,
      conversationId: conversation.id,
    })).toBe('dispatched');

    await vi.waitFor(() => expect(captured).toBeDefined());
    expect(captured).toMatchObject({
      turnId,
      suppressTurnStartedEvent: true,
      deliveryContext: {
        fence: { fenceToken: 1 },
        userMessage: {
          messageId: userMessage.id,
          content: 'recover me with my prompt frames',
        },
      },
    });

    // While the recovery lease is held, a second dispatch is a silent skip.
    expect(await service.dispatchQueuedTurn({
      turnId,
      agentId: agent.id,
      conversationId: conversation.id,
    })).toBe('skipped');

    releaseExecution?.();
    // The lease is released once the launch settles: the next claim succeeds
    // with a bumped fence, proving release + monotonic takeover.
    await vi.waitFor(async () => {
      const lease = await testDb.repo.claimTurnDeliveryLease({
        turnId,
        ownerId: 'verifier',
        leaseDurationMs: 5_000,
      });
      expect(lease?.fenceToken).toBe(2);
    });
  });

  it('dispatchQueuedTurn launches fresh post-boot turns without a recovery lease', async () => {
    const agent = await testDb.repo.createAgent({
      name: 'dispatch-fresh-agent',
      harness: 'langgraph',
      harnessConfig: '{}',
      systemPrompt: 'test',
      tools: [],
    });
    const conversation = await testDb.repo.createConversation(agent.id);
    const userMessage = await testDb.repo.addMessage({
      agentId: agent.id,
      conversationId: conversation.id,
      role: 'user',
      content: 'fresh enqueue',
      createdAt: Date.now(),
    });
    const turnId = 'dispatch-fresh-turn-1';
    await testDb.repo.createTurnWithSecretEnvelope({
      id: turnId,
      agentId: agent.id,
      conversationId: conversation.id,
      userMessageId: userMessage.id,
      mode: 'interactive',
      status: 'queued',
      queuedAt: Date.now() + 60_000,
      startedAt: Date.now() + 60_000,
    }, TEST_TURN_SECRET_CODEC.seal(turnId, {}));

    let captured: Record<string, unknown> | undefined;
    const executeTurn = vi.fn(async (params: Record<string, unknown>) => {
      captured = params;
    });
    const service = new TurnStartupService({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      turnSecretEnvelopeCodec: TEST_TURN_SECRET_CODEC,
    });
    service.configureExecution({
      db: testDb.repo,
      agentTurnService: { executeTurn } as never,
    });

    expect(await service.dispatchQueuedTurn({
      turnId,
      agentId: agent.id,
      conversationId: conversation.id,
    })).toBe('dispatched');
    await vi.waitFor(() => expect(captured).toBeDefined());
    expect(captured?.deliveryContext).toBeUndefined();
    expect(captured?.suppressTurnStartedEvent).toBeUndefined();
  });
});
