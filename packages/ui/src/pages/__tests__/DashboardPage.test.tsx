import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DashboardPage } from '../DashboardPage';
import { useAgentsStore } from '@/stores/agents';
import {
  fetchActiveConversations,
  fetchConversationSummaries,
} from '@/lib/api';

vi.mock('@/components/dashboard/Dashboard', () => ({
  Dashboard: () => null,
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return {
    ...actual,
    fetchActiveConversations: vi.fn(),
    fetchConversationSummaries: vi.fn(),
  };
});

const fetchActiveConversationsMock = vi.mocked(fetchActiveConversations);
const fetchConversationSummariesMock = vi.mocked(fetchConversationSummaries);

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('DashboardPage', () => {
  let container: HTMLDivElement;
  let root: Root;
  const cancelRunMock = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    useAgentsStore.setState((state) => ({
      ...state,
      agents: [{ id: 'agent-1', name: 'Agent 1', status: 'active', tools: [], harness: 'test', harnessConfig: {} }],
      loading: false,
      error: null,
      fetchAgents: vi.fn().mockResolvedValue(undefined),
      cancelRun: cancelRunMock,
    }));

    fetchActiveConversationsMock.mockResolvedValue([
      {
        id: 'conv-1',
        agentId: 'agent-1',
        status: 'running',
        mode: 'interactive',
        turnCount: 1,
        messageCount: 2,
        taskDescription: 'Investigate issue',
        startedAt: Date.now() - 5_000,
        updatedAt: Date.now(),
        latestTurnId: 'turn-1',
        sandboxSessionId: 'sandbox-1',
      },
    ]);
    fetchConversationSummariesMock.mockResolvedValue({ conversations: [] } as never);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  it('cancels recent conversations using latestTurnId instead of sandboxSessionId', async () => {
    act(() => {
      root.render(<DashboardPage />);
    });
    await flushEffects();

    const cancelButton = container.querySelector('button[data-testid="cancel-run-button"]');
    expect(cancelButton).not.toBeNull();

    await act(async () => {
      cancelButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(cancelRunMock).toHaveBeenCalledWith('agent-1', 'turn-1');
    expect(cancelRunMock).not.toHaveBeenCalledWith('agent-1', 'sandbox-1');
  });
});
