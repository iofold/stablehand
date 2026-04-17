import { describe, expect, it } from 'vitest';

import type { AgentDefinition } from '../../../types.js';
import { AsyncChannel, type SessionRecord, type TurnQueueEntry } from '../types.js';
import { SessionStateStore } from '../session-state-store.js';

function createSessionRecord(overrides?: Partial<SessionRecord>): SessionRecord {
  return {
    sessionId: overrides?.sessionId ?? 'sess-1',
    conversationId: overrides?.conversationId ?? 'conv-1',
    agentId: overrides?.agentId ?? 'agent-1',
    containerName: overrides?.containerName ?? 'container-1',
    containerId: overrides?.containerId ?? 'c-1',
    status: overrides?.status ?? 'ACTIVE',
    harnessName: overrides?.harnessName ?? 'langgraph',
    sessionWorkspaceDir: overrides?.sessionWorkspaceDir,
    currentTurnAbortController: overrides?.currentTurnAbortController,
    currentTurnId: overrides?.currentTurnId,
    grpcClient: overrides?.grpcClient,
  };
}

function createAgentDef(overrides?: Partial<AgentDefinition>): AgentDefinition {
  return {
    name: overrides?.name ?? 'agent-1',
    harness: overrides?.harness ?? 'langgraph',
    harnessConfig: overrides?.harnessConfig ?? {},
    tools: overrides?.tools ?? [],
    systemPrompt: overrides?.systemPrompt ?? 'prompt',
    description: overrides?.description,
    metadata: overrides?.metadata,
    workspaceDir: overrides?.workspaceDir,
    projectDir: overrides?.projectDir,
    mode: overrides?.mode,
    resourceLimits: overrides?.resourceLimits,
    nativeTools: overrides?.nativeTools,
    workspaceContent: overrides?.workspaceContent,
  };
}

function createQueueEntry(turnId = 'turn-1'): TurnQueueEntry {
  return {
    messages: [{
      id: `msg-${turnId}`,
      role: 'user',
      content: turnId,
      agentId: 'agent-1',
      createdAt: new Date(),
    }],
    turnId,
    channel: new AsyncChannel(),
  };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('SessionStateStore', () => {
  it('supports session CRUD and lookup by conversation or session id', () => {
    const store = new SessionStateStore();
    const record = createSessionRecord();

    store.setSession(record.conversationId, record);

    expect(store.getSessionByConversation('conv-1')).toBe(record);
    expect(store.getSessionById('sess-1')).toBe(record);

    store.deleteSession('conv-1');

    expect(store.getSessionByConversation('conv-1')).toBeUndefined();
    expect(store.getSessionById('sess-1')).toBeUndefined();
  });

  it('updates the sessionId index when a conversation is rebound to a new session', () => {
    const store = new SessionStateStore();
    const first = createSessionRecord({ conversationId: 'conv-1', sessionId: 'sess-1' });
    const second = createSessionRecord({ conversationId: 'conv-1', sessionId: 'sess-2' });

    store.setSession(first.conversationId, first);
    store.setSession(second.conversationId, second);

    expect(store.getSessionByConversation('conv-1')).toBe(second);
    expect(store.getSessionById('sess-1')).toBeUndefined();
    expect(store.getSessionById('sess-2')).toBe(second);
  });

  it('supports agent definition CRUD', () => {
    const store = new SessionStateStore();
    const agentDef = createAgentDef();

    store.setAgentDef('conv-1', agentDef);
    expect(store.getAgentDef('conv-1')).toBe(agentDef);

    store.deleteAgentDef('conv-1');
    expect(store.getAgentDef('conv-1')).toBeUndefined();
  });

  it('tracks active turns', () => {
    const store = new SessionStateStore();

    expect(store.isActiveTurn('sess-1')).toBe(false);

    store.markTurnActive('sess-1');
    expect(store.isActiveTurn('sess-1')).toBe(true);

    store.markTurnInactive('sess-1');
    expect(store.isActiveTurn('sess-1')).toBe(false);
  });

  it('creates, reuses, and deletes turn queues', () => {
    const store = new SessionStateStore();
    const queue = store.getOrCreateQueue('sess-1');
    const entry = createQueueEntry();

    queue.push(entry);

    expect(store.getQueue('sess-1')).toBe(queue);
    expect(store.getOrCreateQueue('sess-1')).toBe(queue);
    expect(store.getQueue('sess-1')).toEqual([entry]);

    store.deleteQueue('sess-1');
    expect(store.getQueue('sess-1')).toBeUndefined();
  });

  it('serializes locks for the same conversation', async () => {
    const store = new SessionStateStore();
    const gate = deferred();
    const events: string[] = [];

    const first = store.withConversationLock('conv-1', async () => {
      events.push('first-start');
      await gate.promise;
      events.push('first-end');
      return 'first';
    });

    const second = store.withConversationLock('conv-1', async () => {
      events.push('second-start');
      return 'second';
    });

    await Promise.resolve();
    expect(events).toEqual(['first-start']);

    gate.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second']);
    expect(events).toEqual(['first-start', 'first-end', 'second-start']);
  });

  it('allows different conversation locks to run in parallel', async () => {
    const store = new SessionStateStore();
    const gate = deferred();
    const started: string[] = [];

    const first = store.withConversationLock('conv-1', async () => {
      started.push('conv-1');
      await gate.promise;
    });
    const second = store.withConversationLock('conv-2', async () => {
      started.push('conv-2');
      await gate.promise;
    });

    await Promise.resolve();
    expect(started.sort()).toEqual(['conv-1', 'conv-2']);

    gate.resolve();
    await Promise.all([first, second]);
  });

  it('cleans up all state for a session', () => {
    const store = new SessionStateStore();
    const record = createSessionRecord();

    store.setSession(record.conversationId, record);
    store.setAgentDef(record.conversationId, createAgentDef());
    store.getOrCreateQueue(record.sessionId).push(createQueueEntry());
    store.markTurnActive(record.sessionId);

    store.cleanupSession(record.sessionId, record.conversationId);

    expect(store.getSessionByConversation(record.conversationId)).toBeUndefined();
    expect(store.getAgentDef(record.conversationId)).toBeUndefined();
    expect(store.getQueue(record.sessionId)).toBeUndefined();
    expect(store.isActiveTurn(record.sessionId)).toBe(false);
  });

  it('returns all sessions and filters by agent', () => {
    const store = new SessionStateStore();
    const first = createSessionRecord({ conversationId: 'conv-1', sessionId: 'sess-1', agentId: 'agent-1' });
    const second = createSessionRecord({ conversationId: 'conv-2', sessionId: 'sess-2', agentId: 'agent-1' });
    const third = createSessionRecord({ conversationId: 'conv-3', sessionId: 'sess-3', agentId: 'agent-2' });

    store.setSession(first.conversationId, first);
    store.setSession(second.conversationId, second);
    store.setSession(third.conversationId, third);

    expect(store.getAllSessions()).toEqual([first, second, third]);
    expect(store.getSessionsByAgent('agent-1')).toEqual([first, second]);
    expect(store.getSessionsByAgent('agent-2')).toEqual([third]);
  });
});
