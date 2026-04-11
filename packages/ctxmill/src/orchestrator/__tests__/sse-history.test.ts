import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SSEManager } from '../sse.js';

function createMockReply(): { reply: any; written: string[] } {
  const written: string[] = [];
  const reply = {
    raw: {
      write: vi.fn((data: string) => {
        written.push(data);
        return true;
      }),
      on: vi.fn(),
      end: vi.fn(),
    },
  };
  return { reply, written };
}

function getHistory(manager: SSEManager, agentId: string): Array<{ id: string; event: Record<string, unknown> }> {
  const eventHistory = (manager as any).eventHistory as Map<
    string,
    Map<string, Array<{ id: string; event: Record<string, unknown> }>>
  >;
  const conversationHistory = eventHistory.get(agentId);
  if (!conversationHistory) {
    return [];
  }
  const history = Array.from(conversationHistory.values()).flat();
  history.sort((a, b) => {
    const sequenceA = Number(a.id.slice(a.id.lastIndexOf('-') + 1));
    const sequenceB = Number(b.id.slice(b.id.lastIndexOf('-') + 1));
    return sequenceA - sequenceB;
  });
  return history;
}

function broadcastContentEvents(manager: SSEManager, agentId: string, count: number): void {
  for (let index = 1; index <= count; index++) {
    manager.broadcast(agentId, {
      type: 'TEXT_MESSAGE_CONTENT',
      content: `chunk-${index}`,
    });
  }
}

describe('SSEManager history retention', () => {
  let manager: SSEManager;

  beforeEach(() => {
    manager = new SSEManager();
  });

  afterEach(() => {
    manager.shutdown();
  });

  it('retains last N events after RUN_FINISHED', () => {
    broadcastContentEvents(manager, 'agent-1', 10);
    manager.broadcast('agent-1', { type: 'RUN_FINISHED' });

    const history = getHistory(manager, 'agent-1');

    expect(history).toHaveLength(11);
    expect(history.map((entry) => entry.event)).toEqual([
      { type: 'TEXT_MESSAGE_CONTENT', content: 'chunk-1' },
      { type: 'TEXT_MESSAGE_CONTENT', content: 'chunk-2' },
      { type: 'TEXT_MESSAGE_CONTENT', content: 'chunk-3' },
      { type: 'TEXT_MESSAGE_CONTENT', content: 'chunk-4' },
      { type: 'TEXT_MESSAGE_CONTENT', content: 'chunk-5' },
      { type: 'TEXT_MESSAGE_CONTENT', content: 'chunk-6' },
      { type: 'TEXT_MESSAGE_CONTENT', content: 'chunk-7' },
      { type: 'TEXT_MESSAGE_CONTENT', content: 'chunk-8' },
      { type: 'TEXT_MESSAGE_CONTENT', content: 'chunk-9' },
      { type: 'TEXT_MESSAGE_CONTENT', content: 'chunk-10' },
      { type: 'RUN_FINISHED' },
    ]);
  });

  it('retains last N events after RUN_ERROR', () => {
    broadcastContentEvents(manager, 'agent-1', 10);
    manager.broadcast('agent-1', { type: 'RUN_ERROR', error: 'boom' });

    const history = getHistory(manager, 'agent-1');

    expect(history).toHaveLength(11);
    expect(history.map((entry) => entry.event)).toEqual([
      { type: 'TEXT_MESSAGE_CONTENT', content: 'chunk-1' },
      { type: 'TEXT_MESSAGE_CONTENT', content: 'chunk-2' },
      { type: 'TEXT_MESSAGE_CONTENT', content: 'chunk-3' },
      { type: 'TEXT_MESSAGE_CONTENT', content: 'chunk-4' },
      { type: 'TEXT_MESSAGE_CONTENT', content: 'chunk-5' },
      { type: 'TEXT_MESSAGE_CONTENT', content: 'chunk-6' },
      { type: 'TEXT_MESSAGE_CONTENT', content: 'chunk-7' },
      { type: 'TEXT_MESSAGE_CONTENT', content: 'chunk-8' },
      { type: 'TEXT_MESSAGE_CONTENT', content: 'chunk-9' },
      { type: 'TEXT_MESSAGE_CONTENT', content: 'chunk-10' },
      { type: 'RUN_ERROR', error: 'boom' },
    ]);
  });

  it('reconnecting client receives retained events', () => {
    broadcastContentEvents(manager, 'agent-1', 8);
    manager.broadcast('agent-1', { type: 'RUN_FINISHED' });

    const { reply, written } = createMockReply();
    manager.subscribe('agent-1', reply, 'agent-1-4');

    expect(written).toEqual([
      'id: agent-1-5\ndata: {"type":"TEXT_MESSAGE_CONTENT","content":"chunk-5"}\n\n',
      'id: agent-1-6\ndata: {"type":"TEXT_MESSAGE_CONTENT","content":"chunk-6"}\n\n',
      'id: agent-1-7\ndata: {"type":"TEXT_MESSAGE_CONTENT","content":"chunk-7"}\n\n',
      'id: agent-1-8\ndata: {"type":"TEXT_MESSAGE_CONTENT","content":"chunk-8"}\n\n',
      'id: agent-1-9\ndata: {"type":"RUN_FINISHED"}\n\n',
    ]);
  });

  it('normal operation caps at MAX_EVENTS_PER_CONVERSATION', () => {
    broadcastContentEvents(manager, 'agent-1', 560);

    const history = getHistory(manager, 'agent-1');

    expect(history).toHaveLength(500);
    expect(history[0]?.event).toEqual({ type: 'TEXT_MESSAGE_CONTENT', content: 'chunk-61' });
    expect(history.at(-1)?.event).toEqual({ type: 'TEXT_MESSAGE_CONTENT', content: 'chunk-560' });
  });

  it('empty history after completion for new agent', () => {
    manager.broadcast('agent-2', { type: 'RUN_FINISHED' });

    const history = getHistory(manager, 'agent-2');

    expect(history).toHaveLength(1);
    expect(history[0]?.event).toEqual({ type: 'RUN_FINISHED' });
  });
});
