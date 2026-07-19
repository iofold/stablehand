import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConversationSnapshotResponseSchema,
  type ConversationSnapshot,
} from '@ctxmill/contracts';

import { SessionPage } from '../SessionPage';
import { useAgentsStore } from '@/stores/agents';
import { useConversationStore } from '@/stores/conversation';
import {
  fetchAgentTurns,
  fetchConversationSnapshot,
  fetchInterrupts,
} from '@/lib/api';

const { sessionInputMock, useSSEMock } = vi.hoisted(() => ({
  sessionInputMock: vi.fn(),
  useSSEMock: vi.fn(),
}));

vi.mock('@/lib/useSSE', () => ({
  useSSE: (
    agentId: string | undefined,
    options: { enabled?: boolean; eventCursor?: string },
  ) => {
    useSSEMock(agentId, options);
    return { status: 'disconnected' };
  },
  useSSEStatus: () => 'disconnected',
}));

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return {
    ...actual,
    fetchAgentTurns: vi.fn(),
    fetchConversationSnapshot: vi.fn(),
    fetchInterrupts: vi.fn(),
  };
});

vi.mock('@/components/session/SessionThread', () => ({
  SessionThread: () => null,
}));

vi.mock('@/components/session/SessionInput', () => ({
  SessionInput: (props: { disabled: boolean }) => {
    sessionInputMock(props);
    return null;
  },
}));

vi.mock('@/components/ui/ConnectionBanner', () => ({
  ConnectionBanner: () => null,
}));

const fetchAgentTurnsMock = vi.mocked(fetchAgentTurns);
const fetchConversationSnapshotMock = vi.mocked(fetchConversationSnapshot);
const fetchInterruptsMock = vi.mocked(fetchInterrupts);

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('SessionPage conversation snapshot boundary', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    useConversationStore.getState().reset();
    useAgentsStore.setState({
      agents: [{
        id: 'agent-1',
        name: 'Agent 1',
        status: 'active',
        tools: [],
        harness: 'test',
        harnessConfig: {},
      }],
      loading: false,
      error: null,
    });
    fetchAgentTurnsMock.mockResolvedValue([]);
    fetchInterruptsMock.mockResolvedValue([]);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    useConversationStore.getState().reset();
    vi.clearAllMocks();
  });

  it('installs the REST snapshot before opening SSE at the returned cursor', async () => {
    let resolveSnapshot: ((snapshot: ConversationSnapshot) => void) | undefined;
    fetchConversationSnapshotMock.mockReturnValue(new Promise((resolve) => {
      resolveSnapshot = resolve;
    }));

    act(() => {
      root.render(
        <MemoryRouter
          initialEntries={['/agents/agent-1/conversations/conversation-1']}
        >
          <Routes>
            <Route
              path="/agents/:id/conversations/:conversationId"
              element={<SessionPage />}
            />
          </Routes>
        </MemoryRouter>,
      );
    });
    await flushEffects();

    expect(fetchConversationSnapshotMock).toHaveBeenCalledWith(
      'agent-1',
      'conversation-1',
    );
    expect(useSSEMock).not.toHaveBeenCalledWith(
      'agent-1',
      expect.objectContaining({ enabled: true }),
    );
    expect(sessionInputMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ disabled: true }),
    );

    resolveSnapshot?.(ConversationSnapshotResponseSchema.parse({
      conversationId: 'conversation-1',
      eventCursor: '000000000042',
      messages: [{
        id: 'message-1',
        turnId: 'turn-1',
        messageSeq: 1,
        messageRevision: 0,
        role: 'assistant',
        content: 'authoritative history',
        createdAt: '2026-07-19T00:00:00.000Z',
      }],
    }));
    await flushEffects();

    expect(useConversationStore.getState().messages).toEqual([
      expect.objectContaining({
        id: 'message-1',
        content: 'authoritative history',
      }),
    ]);
    expect(useSSEMock).toHaveBeenLastCalledWith('agent-1', {
      enabled: true,
      eventCursor: '000000000042',
    });
    expect(sessionInputMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ disabled: false }),
    );
  });
});
