import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DashboardPage } from '../DashboardPage';
import { useAgentsStore } from '@/stores/agents';
import { useApiAuthStore } from '@/lib/auth';
import {
  fetchAnalyticsOverview,
  fetchModelGatewayStatus,
  fetchQueueStatus,
  fetchRecentConversations,
} from '@/lib/api';
import { makeAgentFixture } from '@/test/agent-fixture';
import { ConversationSummarySchema } from '@ctxmill/contracts';

vi.mock('@/components/dashboard/Dashboard', () => ({
  Dashboard: ({ error }: { error?: string | null }) => (
    <div data-testid="agents-grid">
      <div data-testid="dashboard-error-prop">{error ?? ''}</div>
    </div>
  ),
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="responsive-chart">{children}</div>
  ),
  ComposedChart: ({ children }: { children: React.ReactNode }) => <svg>{children}</svg>,
  Area: () => null,
  Bar: () => null,
  Line: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  XAxis: () => null,
  YAxis: () => null,
}));

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return {
    ...actual,
    fetchRecentConversations: vi.fn(),
    fetchAnalyticsOverview: vi.fn(),
    fetchModelGatewayStatus: vi.fn(),
    fetchQueueStatus: vi.fn(),
  };
});

const fetchRecentConversationsMock = vi.mocked(fetchRecentConversations);
const fetchAnalyticsOverviewMock = vi.mocked(fetchAnalyticsOverview);
const fetchModelGatewayStatusMock = vi.mocked(fetchModelGatewayStatus);
const fetchQueueStatusMock = vi.mocked(fetchQueueStatus);

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

  const renderPage = () => {
    act(() => {
      root.render(
        <MemoryRouter>
          <DashboardPage />
        </MemoryRouter>,
      );
    });
  };

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

    fetchRecentConversationsMock.mockResolvedValue({
      conversations: [
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
      ],
    });
    fetchAnalyticsOverviewMock.mockRejectedValue(new Error('analytics unavailable in test'));
    fetchModelGatewayStatusMock.mockRejectedValue(new Error('gateway unavailable in test'));
    fetchQueueStatusMock.mockRejectedValue(new Error('queue unavailable in test'));
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  it('shows recent sessions on the overview tab and cancels using latestTurnId', async () => {
    renderPage();
    await flushEffects();

    expect(container.querySelector('[data-testid="recent-sessions"]')).not.toBeNull();
    expect(container.textContent).toContain('Investigate issue');

    const cancelButton = container.querySelector('button[data-testid="cancel-run-button"]');
    expect(cancelButton).not.toBeNull();

    await act(async () => {
      cancelButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(cancelRunMock).toHaveBeenCalledWith('agent-1', 'turn-1');
    expect(cancelRunMock).not.toHaveBeenCalledWith('agent-1', 'sandbox-1');
  });

  it('keeps the session visible and reports the API detail when cancellation fails', async () => {
    cancelRunMock.mockRejectedValueOnce(new Error('Cancellation denied by runtime'));
    renderPage();
    await flushEffects();

    const cancelButton = container.querySelector('button[data-testid="cancel-run-button"]');
    await act(async () => {
      cancelButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Cancellation denied by runtime');
    expect(container.textContent).toContain('Investigate issue');
    expect(container.querySelector('button[data-testid="cancel-run-button"]')).not.toBeNull();
  });

  it('renders a fixed duration and no cancel action for completed sessions', async () => {
    const startedAt = Date.now() - 13 * 60_000;
    fetchRecentConversationsMock.mockResolvedValue({
      conversations: [
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
      ],
    });

    renderPage();
    await flushEffects();

    const durationCell = container.querySelector('[data-testid="conversation-duration"]');
    expect(durationCell?.textContent).toBe('4s');
    expect(container.querySelector('button[data-testid="cancel-run-button"]')).toBeNull();
  });

  it('renders a fixed duration from updatedAt for errored sessions', async () => {
    const startedAt = Date.now() - 13 * 60_000;
    fetchRecentConversationsMock.mockResolvedValue({
      conversations: [
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
      ],
    });

    renderPage();
    await flushEffects();

    const durationCell = container.querySelector('[data-testid="conversation-duration"]');
    expect(durationCell?.textContent).toBe('4s');
    expect(container.querySelector('button[data-testid="cancel-run-button"]')).toBeNull();
  });

  it('switches to the agents tab and renders the agent grid', async () => {
    renderPage();
    await flushEffects();

    expect(container.querySelector('[data-testid="agents-grid"]')).toBeNull();

    const agentsTab = container.querySelector('[data-testid="dashboard-tab-agents"]');
    await act(async () => {
      agentsTab!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.querySelector('[data-testid="agents-grid"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="recent-sessions"]')).toBeNull();
  });

  it('switches to the sessions tab and loads the session browser', async () => {
    renderPage();
    await flushEffects();

    const sessionsTab = container.querySelector('[data-testid="dashboard-tab-sessions"]');
    await act(async () => {
      sessionsTab!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(container.querySelector('[data-testid="sessions-tab"]')).not.toBeNull();
    // Overview poll (limit 25) plus the browser page (limit 50).
    expect(fetchRecentConversationsMock).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 50 }),
    );
  });

  it('suppresses dashboard polling while auth is required', async () => {
    const fetchAgents = vi.fn().mockRejectedValue(new Error('API GET /api/agents failed: 401'));
    useAgentsStore.setState((state) => ({
      ...state,
      agents: [],
      loading: false,
      error: 'API GET /api/agents failed: 401',
      fetchAgents,
    }));
    useApiAuthStore.setState({ token: '', authRequired: true });

    renderPage();
    await flushEffects();

    expect(fetchAgents).not.toHaveBeenCalled();
    expect(fetchRecentConversationsMock).not.toHaveBeenCalled();
  });
});
