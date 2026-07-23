import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationSummary } from '@ctxmill/contracts';

import { useAgentDetail } from './useAgentDetail';
import type { TabId } from '@/components/agent/types';
import { makeAgentFixture } from '@/test/agent-fixture';

const mocks = vi.hoisted(() => ({
  fetchAgent: vi.fn(),
  fetchAgents: vi.fn(),
  fetchTurns: vi.fn(),
  fetchConversationSummaries: vi.fn(),
}));

const storeState = {
  agents: [makeAgentFixture()],
  loading: false,
  fetchAgent: mocks.fetchAgent,
  fetchAgents: mocks.fetchAgents,
  fetchTurns: mocks.fetchTurns,
};

vi.mock('@/stores/agents', () => ({
  useAgentsStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}));

vi.mock('@/lib/api', () => ({
  fetchConversationSummaries: mocks.fetchConversationSummaries,
}));

interface DetailProbeState {
  loading: boolean;
  error: string | null;
  recentConversations: ConversationSummary[];
  conversationsLoading: boolean;
  conversationsError: string | null;
}

function Probe({
  tab,
  onState,
}: {
  tab: TabId;
  onState: (state: DetailProbeState) => void;
}) {
  const state = useAgentDetail('agent-1', tab);
  onState(state as unknown as DetailProbeState);
  return null;
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useAgentDetail history loading', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.fetchTurns.mockResolvedValue([]);
    mocks.fetchAgent.mockResolvedValue(makeAgentFixture());
    mocks.fetchConversationSummaries.mockResolvedValue({ conversations: [] });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    storeState.agents = [makeAgentFixture()];
    vi.clearAllMocks();
  });

  it('loads a missing agent directly and surfaces the exact failure', async () => {
    storeState.agents = [];
    mocks.fetchAgent.mockRejectedValueOnce(new Error('Agent detail unavailable'));
    let captured: DetailProbeState | undefined;
    act(() => root.render(
      <Probe tab="overview" onState={(state) => { captured = state; }} />,
    ));
    await flushEffects();

    expect(mocks.fetchAgent).toHaveBeenCalledWith('agent-1');
    expect(mocks.fetchAgents).not.toHaveBeenCalled();
    expect(captured?.loading).toBe(false);
    expect(captured?.error).toBe('Agent detail unavailable');
  });

  it('loads conversation summaries for the overview without loading every turn', async () => {
    let captured: DetailProbeState | undefined;
    act(() => root.render(
      <Probe tab="overview" onState={(state) => { captured = state; }} />,
    ));
    await flushEffects();

    expect(mocks.fetchConversationSummaries).toHaveBeenCalledWith('agent-1');
    expect(mocks.fetchTurns).not.toHaveBeenCalled();
    expect(captured?.recentConversations).toEqual([]);
    expect(captured?.conversationsLoading).toBe(false);
  });

  it('keeps the first twelve conversations in canonical server order', async () => {
    const summaries = Array.from({ length: 13 }, (_, index) => ({
      id: `conversation-${index}`,
      agentId: 'agent-1',
      status: 'COMPLETED',
      mode: 'interactive',
      turnCount: 1,
      messageCount: 2,
      taskDescription: `Task ${index}`,
      startedAt: 1_700_000_000_000 - index,
      completedAt: 1_700_000_000_500 - index,
      updatedAt: 1_700_000_000_500 - index,
      latestTurnId: `turn-${index}`,
      sandboxSessionId: null,
      totalTokens: null,
    })) as ConversationSummary[];
    mocks.fetchConversationSummaries.mockResolvedValueOnce({ conversations: summaries });

    let captured: DetailProbeState | undefined;
    act(() => root.render(
      <Probe tab="overview" onState={(state) => { captured = state; }} />,
    ));
    await flushEffects();

    expect(captured?.recentConversations.map(({ id }) => id)).toEqual(
      summaries.slice(0, 12).map(({ id }) => id),
    );
  });

  it('loads turns only when the conversations history tab is opened', async () => {
    let captured: DetailProbeState | undefined;
    act(() => root.render(
      <Probe tab="turns" onState={(state) => { captured = state; }} />,
    ));
    await flushEffects();

    expect(mocks.fetchTurns).toHaveBeenCalledWith('agent-1');
    expect(mocks.fetchConversationSummaries).not.toHaveBeenCalled();
    expect(captured?.conversationsLoading).toBe(false);
  });

  it('keeps a summary failure visible instead of presenting an empty history', async () => {
    mocks.fetchConversationSummaries.mockRejectedValueOnce(new Error('Summary contract rejected'));
    let captured: DetailProbeState | undefined;
    act(() => root.render(
      <Probe tab="overview" onState={(state) => { captured = state; }} />,
    ));
    await flushEffects();

    expect(captured?.conversationsError).toBe('Summary contract rejected');
  });

});
