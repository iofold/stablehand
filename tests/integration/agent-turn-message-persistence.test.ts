import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentTurnService } from '../../packages/ctxmill/src/orchestrator/agent-turn-service.js';
import { TypedEventBus } from '../../packages/ctxmill/src/events/bus.js';
import { SpineConsumerRunner } from '../../packages/ctxmill/src/events/spine-consumer-runner.js';
import { CallbackDispatcher } from '../../packages/ctxmill/src/orchestrator/callback-dispatcher.js';
import { CanonicalLog } from '../../packages/ctxmill/src/orchestrator/canonical/canonical-log.js';
import { reconcilePendingMessagePublishesOnStartup } from '../../packages/ctxmill/src/orchestrator/message-publisher.js';
import { reconcileStrandedTurnsOnStartup } from '../../packages/ctxmill/src/orchestrator/turn-reconciler.js';
import { TurnFinalizer } from '../../packages/ctxmill/src/orchestrator/turn-finalizer.js';
import type { RedispatchQueuedTurnParams } from '../../packages/ctxmill/src/orchestrator/turn-startup-service.js';
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

  it('durably republishes a pre-frame interactive prompt before startup redispatch', async () => {
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
      startedAt: 20,
    });
    expect(await testDb.repo.getTurnFrames(turn.id)).toEqual([]);

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const canonicalLog = new CanonicalLog({ db: testDb.repo, logger });
    const eventBus = new TypedEventBus({
      persistEvent: async (type, _agentId, _payload, parsedPayload, context) => {
        await canonicalLog.ingest(type, parsedPayload ?? {}, context);
      },
    });
    const redispatchQueuedTurn = vi.fn(async (params: RedispatchQueuedTurnParams) => {
      await eventBus.emitAsync(
        'user.message',
        params.deliveryContext.userMessage!,
        { deliveryFence: params.deliveryContext.fence },
      );
      const framesAtRedispatch = await testDb.repo.getTurnFrames(turn.id);
      expect(framesAtRedispatch.map(({ type }) => type)).toEqual([
        'TEXT_MESSAGE_START',
        'TEXT_MESSAGE_CONTENT',
        'TEXT_MESSAGE_END',
      ]);
      expect(framesAtRedispatch[0]).toMatchObject({
        sourceType: 'user.message',
        turnId: turn.id,
        conversationId: conversation.id,
      });
    });
    const finalizer = new TurnFinalizer({ db: testDb.repo, eventBus, logger });

    const first = await reconcileStrandedTurnsOnStartup({
      db: testDb.repo,
      eventBus,
      finalizer,
      logger,
      redispatchQueuedTurn,
    }, 30);

    expect(first).toEqual(expect.objectContaining({ failed: 0, redispatched: 1 }));
    expect(redispatchQueuedTurn).toHaveBeenCalledTimes(1);

    expect((await testDb.repo.getTurnFrames(turn.id)).map(({ type }) => type)).toEqual([
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
    ]);
  });

  it('lets only one replica republish and redispatch the same queued turn', async () => {
    const agent = await testDb.repo.createAgent({
      name: 'active-active-recovery-agent',
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
      content: 'dispatch exactly once',
      createdAt: 10,
    });
    const turn = await testDb.repo.createTurn({
      agentId: agent.id,
      conversationId: conversation.id,
      userMessageId: userMessage.id,
      mode: 'interactive',
      status: 'queued',
      startedAt: 20,
    });

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const canonicalLog = new CanonicalLog({ db: testDb.repo, logger });
    const eventBus = new TypedEventBus({
      persistEvent: async (type, _agentId, _payload, parsedPayload, context) => {
        await canonicalLog.ingest(type, parsedPayload ?? {}, context);
      },
    });
    const finalizer = new TurnFinalizer({ db: testDb.repo, eventBus, logger });
    let releaseDispatch!: () => void;
    let markDispatchStarted!: () => void;
    const dispatchRelease = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    const dispatchStarted = new Promise<void>((resolve) => {
      markDispatchStarted = resolve;
    });
    let settledClaimAttempts = 0;
    let markBothClaimAttemptsSettled!: () => void;
    const bothClaimAttemptsSettled = new Promise<void>((resolve) => {
      markBothClaimAttemptsSettled = resolve;
    });
    const claimTurnDeliveryLease =
      testDb.repo.claimTurnDeliveryLease.bind(testDb.repo);
    vi.spyOn(testDb.repo, 'claimTurnDeliveryLease').mockImplementation(
      async (input) => {
        try {
          return await claimTurnDeliveryLease(input);
        } finally {
          settledClaimAttempts += 1;
          if (settledClaimAttempts === 2) {
            markBothClaimAttemptsSettled();
          }
        }
      },
    );
    const redispatchQueuedTurn = vi.fn(async (params: RedispatchQueuedTurnParams) => {
      markDispatchStarted();
      await eventBus.emitAsync(
        'user.message',
        params.deliveryContext.userMessage!,
        { deliveryFence: params.deliveryContext.fence },
      );
      await dispatchRelease;
    });
    const sharedDeps = {
      db: testDb.repo,
      eventBus,
      finalizer,
      logger,
      redispatchQueuedTurn,
    };

    const reconciliations = [
      reconcileStrandedTurnsOnStartup(sharedDeps, 30, {
        ownerId: 'replica-a',
        leaseMs: 60_000,
        heartbeatMs: 20_000,
      }),
      reconcileStrandedTurnsOnStartup(sharedDeps, 30, {
        ownerId: 'replica-b',
        leaseMs: 60_000,
        heartbeatMs: 20_000,
      }),
    ];
    await Promise.all([dispatchStarted, bothClaimAttemptsSettled]);
    releaseDispatch();
    const results = await Promise.all(reconciliations);

    expect(redispatchQueuedTurn).toHaveBeenCalledTimes(1);
    expect(results.reduce((total, result) => total + result.redispatched, 0)).toBe(1);
    const frames = await testDb.repo.getTurnFrames(turn.id);
    expect(frames.map(({ type }) => type)).toEqual([
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
    ]);
    expect(frames.filter(({ sourceType }) => sourceType === 'user.message')).toHaveLength(1);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('fences A-expire/B-take/A-wake queued-turn recovery across real repositories', async () => {
    const agent = await testDb.repo.createAgent({
      name: 'authorization-crash-recovery-agent',
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
      content: 'remain queued until delivery',
      createdAt: 10,
    });
    const turn = await testDb.repo.createTurn({
      agentId: agent.id,
      conversationId: conversation.id,
      userMessageId: userMessage.id,
      mode: 'interactive',
      status: 'queued',
      startedAt: 20,
    });

    const ownerA = await testDb.repo.claimTurnDeliveryLease({
      turnId: turn.id,
      ownerId: 'replica-a',
      leaseDurationMs: 60_000,
    });
    expect(ownerA).toBeDefined();
    expect((await testDb.repo.getTurn(turn.id))?.status).toBe('queued');
    expect(await testDb.repo.getTurnFrames(turn.id)).toEqual([]);
    expect(await testDb.repo.claimTurnDeliveryLease({
      turnId: turn.id,
      ownerId: 'replica-b',
      leaseDurationMs: 60_000,
    })).toBeUndefined();
    await testDb.conn.pgClient`
      UPDATE turn_delivery_leases
      SET
        lease_expires_at = floor(extract(epoch from clock_timestamp()) * 1000)::bigint - 1,
        updated_at = floor(extract(epoch from clock_timestamp()) * 1000)::bigint
      WHERE turn_id = ${turn.id}
    `;

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const canonicalLog = new CanonicalLog({ db: testDb.repo, logger });
    const eventBus = new TypedEventBus({
      persistEvent: async (type, _agentId, _payload, parsedPayload, context) => {
        await canonicalLog.ingest(type, parsedPayload ?? {}, context);
      },
    });
    const finalizer = new TurnFinalizer({ db: testDb.repo, eventBus, logger });
    const sandboxSession = await testDb.repo.createSandboxSession({
      conversationId: conversation.id,
      agentId: agent.id,
      harnessName: 'langgraph',
    });
    let ownerBFence: { ownerId: string; fenceToken: number } | undefined;
    const redispatchQueuedTurn = vi.fn(async (params: {
      turnId: string;
      agentId: string;
      conversationId: string;
      mode: 'interactive' | 'background';
      taskDescription: string;
      userMessageId: string;
      messages: Message[];
      deliveryContext: {
        fence: { ownerId: string; fenceToken: number };
        userMessage?: {
          turnId: string;
          agentId: string;
          conversationId: string;
          messageId: string;
          content: string;
          timestamp: number;
        };
      };
    }) => {
      ownerBFence = params.deliveryContext.fence;
      expect(await testDb.repo.activateTurnDelivery({
        turnId: params.turnId,
        sandboxSessionId: sandboxSession.id,
        ownerId: ownerBFence.ownerId,
        fenceToken: ownerBFence.fenceToken,
        expectedActiveGeneration: {
          restoreFenceToken: sandboxSession.restoreFenceToken,
          containerId: sandboxSession.containerId,
        },
      })).toBe(true);
      const persistenceContext = { deliveryFence: ownerBFence };
      await eventBus.emitAsync(
        'user.message',
        params.deliveryContext.userMessage!,
        persistenceContext,
      );
      await eventBus.emitAsync('turn.started', {
        turnId: params.turnId,
        sandboxSessionId: sandboxSession.id,
        agentId: params.agentId,
        conversationId: params.conversationId,
        mode: params.mode,
        taskDescription: params.taskDescription,
        timestamp: Date.now(),
      }, persistenceContext);
      await finalizer.finalize({
        turnId: params.turnId,
        sandboxSessionId: sandboxSession.id,
        agentId: params.agentId,
        conversationId: params.conversationId,
        status: 'completed',
        durationMs: 1,
        expectedDeliveryFence: ownerBFence,
      });
    });

    const recovered = await reconcileStrandedTurnsOnStartup({
      db: testDb.repo,
      eventBus,
      finalizer,
      logger,
      redispatchQueuedTurn,
    }, 30, {
      ownerId: 'replica-b',
      leaseMs: 60_000,
      heartbeatMs: 20_000,
    });
    await recovered.redispatchComplete;

    expect(redispatchQueuedTurn).toHaveBeenCalledTimes(1);
    expect(recovered.redispatched).toBe(1);
    expect((await testDb.repo.getTurn(turn.id))?.status).toBe('completed');
    const frames = await testDb.repo.getTurnFrames(turn.id);
    expect(frames.map(({ type }) => type)).toEqual([
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
      'RUN_STARTED',
      'RUN_FINISHED',
    ]);
    expect(frames.filter(({ sourceType }) => sourceType === 'user.message')).toHaveLength(1);
    expect(await testDb.repo.addCanonicalMessage({
      id: `stale-a-${turn.id}`,
      agentId: agent.id,
      conversationId: conversation.id,
      turnId: turn.id,
      role: 'assistant',
      content: 'stale A woke up',
    }, {
      ownerId: ownerA!.ownerId,
      fenceToken: ownerA!.fenceToken,
    })).toBeUndefined();
    expect(await testDb.repo.finalizeTurnIfOpen(turn.id, {
      completedAt: Date.now(),
      error: 'stale A terminal',
      status: 'error',
    }, {
      ownerId: ownerA!.ownerId,
      fenceToken: ownerA!.fenceToken,
    })).toBe(false);
    expect(ownerBFence).toMatchObject({ ownerId: 'replica-b', fenceToken: 2 });
  });
});
