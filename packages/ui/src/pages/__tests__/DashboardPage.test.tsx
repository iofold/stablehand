import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DashboardPage } from '../DashboardPage';
import { useAgentsStore } from '@/stores/agents';
import { useApiAuthStore } from '@/lib/auth';
import {
  fetchActiveConversations,
  fetchConversationSummaries,
} from '@/lib/api';
import { makeAgentFixture } from '@/test/agent-fixture';
import { ConversationSummarySchema } from '@ctxmill/contracts';

vi.mock('@/components/dashboard/Dashboard', () => ({
  Dashboard: ({ error }: { error?: string | null }) => (
    <div data-testid="dashboard-error-prop">{error ?? ''}</div>
  ),
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

function makeConversationSummary(input: unknown) {
  return ConversationSummarySchema.parse(input);
}

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
      agents: [makeAgentFixture({ status: 'active', harness: 'test', harnessConfig: {} })],
      loading: false,
      error: null,
      fetchAgents: vi.fn().mockResolvedValue(undefined),
      cancelTurn: cancelRunMock,
    }));
    useApiAuthStore.setState({ token: '', authRequired: false });

    fetchActiveConversationsMock.mockResolvedValue([
      makeConversationSummary({
        id: 'conv-1',
        agentId: 'agent-1',
        status: 'ACTIVE',
        mode: 'interactive',
        turnCount: 1,
        messageCount: 2,
        taskDescription: 'Investigate issue',
        startedAt: Date.now() - 5_000,
        completedAt: null,
        updatedAt: Date.now(),
        latestTurnId: 'turn-1',
        sandboxSessionId: 'sandbox-1',
        totalTokens: null,
        knownCostUsd: null,
        incompleteCostTurnCount: 0,
      }),
    ]);
    fetchConversationSummariesMock.mockResolvedValue({ conversations: [] });
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

  it('keeps the conversation visible and reports the API detail when cancellation fails', async () => {
    cancelRunMock.mockRejectedValueOnce(new Error('Cancellation denied by runtime'));
    act(() => {
      root.render(<DashboardPage />);
    });
    await flushEffects();

    const cancelButton = container.querySelector('button[data-testid="cancel-run-button"]');
    await act(async () => {
      cancelButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Cancellation denied by runtime');
    expect(container.textContent).toContain('Investigate issue');
    expect(container.querySelector('button[data-testid="cancel-run-button"]')).not.toBeNull();
  });

  it('renders a fixed duration and no cancel action for completed conversations', async () => {
    const startedAt = Date.now() - 13 * 60_000;
    fetchActiveConversationsMock.mockResolvedValue([
      makeConversationSummary({
        id: 'conv-done',
        agentId: 'agent-1',
        status: 'COMPLETED',
        mode: 'interactive',
        turnCount: 1,
        messageCount: 2,
        taskDescription: 'Finished task',
        startedAt,
        completedAt: startedAt + 4_300,
        updatedAt: startedAt + 4_300,
        latestTurnId: 'turn-done',
        sandboxSessionId: 'sandbox-done',
        totalTokens: null,
        knownCostUsd: null,
        incompleteCostTurnCount: 0,
      }),
    ]);

    act(() => {
      root.render(<DashboardPage />);
    });
    await flushEffects();

    const durationCell = container.querySelector('[data-testid="conversation-duration"]');
    expect(durationCell?.textContent).toBe('4s');
    expect(container.querySelector('button[data-testid="cancel-run-button"]')).toBeNull();
  });

  it('renders a fixed duration from updatedAt and no cancel action for errored conversations', async () => {
    const startedAt = Date.now() - 13 * 60_000;
    fetchActiveConversationsMock.mockResolvedValue([
      makeConversationSummary({
        id: 'conv-error',
        agentId: 'agent-1',
        status: 'ERROR',
        mode: 'interactive',
        turnCount: 1,
        messageCount: 2,
        taskDescription: 'Failed task',
        startedAt,
        completedAt: null,
        updatedAt: startedAt + 4_300,
        latestTurnId: 'turn-error',
        sandboxSessionId: 'sandbox-error',
        totalTokens: null,
        knownCostUsd: null,
        incompleteCostTurnCount: 0,
      }),
    ]);

    act(() => {
      root.render(<DashboardPage />);
    });
    await flushEffects();

    const durationCell = container.querySelector('[data-testid="conversation-duration"]');
    expect(durationCell?.textContent).toBe('4s');
    expect(container.querySelector('button[data-testid="cancel-run-button"]')).toBeNull();
  });

  it('renders a live duration and cancel action for running conversations', async () => {
    fetchActiveConversationsMock.mockResolvedValue([
      makeConversationSummary({
        id: 'conv-live',
        agentId: 'agent-1',
        status: 'ACTIVE',
        mode: 'interactive',
        turnCount: 1,
        messageCount: 2,
        taskDescription: 'In-flight task',
        startedAt: Date.now() - 5_000,
        completedAt: null,
        updatedAt: Date.now(),
        latestTurnId: 'turn-live',
        sandboxSessionId: 'sandbox-live',
        totalTokens: null,
        knownCostUsd: null,
        incompleteCostTurnCount: 0,
      }),
    ]);

    act(() => {
      root.render(<DashboardPage />);
    });
    await flushEffects();

    const durationCell = container.querySelector('[data-testid="conversation-duration"]');
    expect(durationCell?.textContent).toMatch(/^[5-9]s$/);
    expect(container.querySelector('button[data-testid="cancel-run-button"]')).not.toBeNull();
  });

  it('suppresses dashboard load errors and protected follow-up polls while auth is required', async () => {
    const fetchAgents = vi.fn().mockRejectedValue(new Error('API GET /api/agents failed: 401'));
    useAgentsStore.setState((state) => ({
      ...state,
      agents: [],
      loading: false,
      error: 'API GET /api/agents failed: 401',
      fetchAgents,
    }));
    useApiAuthStore.setState({ token: '', authRequired: true });

    act(() => {
      root.render(<DashboardPage />);
    });
    await flushEffects();

    expect(container.querySelector('[data-testid="dashboard-error-prop"]')?.textContent).toBe('');
    expect(fetchAgents).not.toHaveBeenCalled();
    expect(fetchActiveConversationsMock).not.toHaveBeenCalled();
  });
});
