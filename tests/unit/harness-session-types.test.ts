import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type {
  AgentEvent,
  AgentHarness,
  ApprovalRequest,
  HarnessExportedState,
  HarnessRestorePoint,
  HarnessSession,
  HarnessSessionConfig,
  HarnessTurnContext,
  HarnessTurnInput,
} from '../../packages/ctxmill/src/harness/index.js';
import type { ToolDefinition } from '@ctxmill/sandbox-daemon';
import type { Message, NativeToolConfig } from '@ctxmill/sandbox-daemon';

function makeMessage(role: Message['role'], content: string): Message {
  return {
    id: `${role}-${content}`,
    agentId: 'agent-1',
    role,
    content,
    createdAt: new Date('2026-03-21T00:00:00.000Z'),
  };
}

async function collectEvents(stream: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

class MockHarnessSession implements HarnessSession {
  private readonly history: Message[];

  private closed = false;

  constructor(private readonly restore?: HarnessRestorePoint) {
    this.history = [...(restore?.messages ?? [])];
  }

  async *deliverTurn(input: HarnessTurnInput, context: HarnessTurnContext): AsyncGenerator<AgentEvent> {
    if (context.onApprovalNeeded) {
      await context.onApprovalNeeded({
        id: `${input.turnId}-approval`,
        runId: input.turnId,
        toolName: 'test-tool',
        args: { turnId: input.turnId },
      });
    }

    this.history.push(...input.messages);

    yield { type: 'text_delta', content: `turn:${input.turnId}` };
    yield {
      type: 'message_committed',
      role: 'assistant',
      content: `response:${input.turnId}`,
      toolCalls: [],
      turnId: input.turnId,
      messageSeq: this.history.length,
    };
    yield { type: 'done', result: `done:${input.turnId}` };
  }

  async exportState(): Promise<HarnessExportedState> {
    return {
      stateVersion: 'mock-v1',
      payload: {
        restored: Boolean(this.restore),
        messageCount: this.history.length,
      },
    };
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  isClosed(): boolean {
    return this.closed;
  }
}

describe('harness session types', () => {
  it('supports the new session lifecycle with a mock harness', async () => {
    const approvalSpy = vi.fn(async (_request: ApprovalRequest) => ({ action: 'approve' as const }));
    const nativeToolConfig: NativeToolConfig = { allowlist: ['bash'] };
    const tools: ToolDefinition[] = [
      {
        name: 'test-tool',
        description: 'Test tool',
        input: z.object({ value: z.string() }),
        handler: async (input) => String(z.object({ value: z.unknown() }).parse(input).value),
      },
    ];
    const sessionConfig: HarnessSessionConfig = {
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      systemPrompt: 'Be helpful.',
      tools,
      nativeTools: [nativeToolConfig],
      secrets: { OPENAI_API_KEY: 'secret' },
      workspaceDir: '/tmp/workspace',
      harnessConfigJson: JSON.stringify({ provider: 'openai', model: 'gpt-5.4-mini', temperature: 0.2 }),
      onApprovalNeeded: approvalSpy,
    };

    let openedRestore: HarnessRestorePoint | undefined;
    let openedSession: MockHarnessSession | undefined;

    const harness: AgentHarness = {
      name: 'mock-harness',
      configSchema: z.object({
        provider: z.string(),
        model: z.string(),
        temperature: z.number().optional(),
      }),
      async openSession(config, restore) {
        expect(config).toEqual(sessionConfig);
        openedRestore = restore;
        openedSession = new MockHarnessSession(restore);
        return openedSession;
      },
    };

    const session = await harness.openSession(sessionConfig);
    const turnOneEvents = await collectEvents(session.deliverTurn(
      { messages: [makeMessage('user', 'Hello')], turnId: 'turn-1' },
      { onApprovalNeeded: approvalSpy },
    ));
    const turnTwoEvents = await collectEvents(session.deliverTurn(
      { messages: [makeMessage('tool', 'Tool output')], turnId: 'turn-2' },
      { signal: undefined },
    ));
    const state = await session.exportState();
    await session.close();

    expect(openedRestore).toBeUndefined();
    expect(approvalSpy).toHaveBeenCalledTimes(1);
    expect(turnOneEvents.map((event) => event.type)).toEqual(['text_delta', 'message_committed', 'done']);
    expect(turnTwoEvents.map((event) => event.type)).toEqual(['text_delta', 'message_committed', 'done']);
    expect(state).toEqual({
      stateVersion: 'mock-v1',
      payload: {
        restored: false,
        messageCount: 2,
      },
    });
    expect(openedSession?.isClosed()).toBe(true);
  });

  it('supports restoring a session with a harness restore point', async () => {
    const restorePoint: HarnessRestorePoint = {
      stateVersion: 'mock-v1',
      payload: { cursor: 3 },
      messages: [makeMessage('user', 'Earlier turn')],
    };
    const sessionConfig: HarnessSessionConfig = {
      agentId: 'agent-2',
      conversationId: 'conversation-2',
      systemPrompt: 'Restore state.',
      tools: [],
      secrets: {},
      workspaceDir: '/tmp/workspace-restore',
      harnessConfigJson: JSON.stringify({ model: 'claude-sonnet-4-6' }),
    };

    const harness: AgentHarness = {
      name: 'mock-harness',
      configSchema: z.object({ model: z.string() }),
      async openSession(_config, restore) {
        return new MockHarnessSession(restore);
      },
    };

    const session = await harness.openSession(sessionConfig, restorePoint);
    const events = await collectEvents(session.deliverTurn(
      { messages: [makeMessage('user', 'Next turn')], turnId: 'turn-restore' },
      {},
    ));
    const state = await session.exportState();
    await session.close();

    expect(events[1]).toMatchObject({
      type: 'message_committed',
      turnId: 'turn-restore',
      messageSeq: 2,
    });
    expect(state.payload).toEqual({
      restored: true,
      messageCount: 2,
    });
  });

});
