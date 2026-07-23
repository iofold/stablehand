import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AnalyticsPage } from '../AnalyticsPage';
import {
  fetchAgentBudgetStatuses,
  fetchAnalyticsOverview,
  fetchBudgetPolicies,
  fetchBudgetSpend,
  fetchModelGatewayStatus,
} from '@/lib/api';

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => (
    <div data-testid="responsive-chart">{children}</div>
  ),
  ComposedChart: ({ children }: { children: ReactNode }) => <svg>{children}</svg>,
  Area: () => null,
  Bar: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  XAxis: () => null,
  YAxis: () => null,
}));

vi.mock('@/lib/api', () => ({
  fetchAgentBudgetStatuses: vi.fn(),
  fetchAnalyticsOverview: vi.fn(),
  fetchBudgetPolicies: vi.fn(),
  fetchBudgetSpend: vi.fn(),
  fetchModelGatewayStatus: vi.fn(),
}));

const fetchAnalyticsOverviewMock = vi.mocked(fetchAnalyticsOverview);
const fetchBudgetPoliciesMock = vi.mocked(fetchBudgetPolicies);
const fetchBudgetSpendMock = vi.mocked(fetchBudgetSpend);
const fetchAgentBudgetStatusesMock = vi.mocked(fetchAgentBudgetStatuses);
const fetchModelGatewayStatusMock = vi.mocked(fetchModelGatewayStatus);

const overview = {
  window: '24h' as const,
  from: 1_800_000_000_000,
  to: 1_800_086_400_000,
  bucketSizeMs: 3_600_000,
  totals: {
    agents: 2,
    activeAgents: 2,
    turns: 3,
    completedTurns: 2,
    errorTurns: 1,
    cancelledTurns: 0,
    activeTurns: 0,
    inputTokens: 10_000,
    outputTokens: 2_400,
    totalTokens: 12_400,
    tokenReportedTurns: 3,
    knownCostUsd: 0.024,
    costCoverage: {
      complete: 2,
      partial: 1,
      pending: 0,
      unpriced: 0,
    },
  },
  activity: [{
    from: 1_800_082_800_000,
    to: 1_800_086_400_000,
    turns: 3,
    completedTurns: 2,
    errorTurns: 1,
    cancelledTurns: 0,
    activeTurns: 0,
    inputTokens: 10_000,
    outputTokens: 2_400,
    totalTokens: 12_400,
    tokenReportedTurns: 3,
    knownCostUsd: 0.024,
    costCoverage: {
      complete: 2,
      partial: 1,
      pending: 0,
      unpriced: 0,
    },
  }],
  agents: [{
    agentId: 'agent-1',
    name: 'Close analyst',
    harness: 'langgraph',
    model: 'gpt-5.4-mini',
    lastActivityAt: 1_800_086_300_000,
    turns: 2,
    completedTurns: 2,
    errorTurns: 0,
    cancelledTurns: 0,
    activeTurns: 0,
    inputTokens: 9_000,
    outputTokens: 2_000,
    totalTokens: 11_000,
    tokenReportedTurns: 2,
    knownCostUsd: 0.02,
    costCoverage: {
      complete: 2,
      partial: 0,
      pending: 0,
      unpriced: 0,
    },
  }, {
    agentId: 'agent-2',
    name: 'Variance reviewer',
    harness: 'pi-agent',
    model: 'claude-sonnet-4-6',
    lastActivityAt: 1_800_086_200_000,
    turns: 1,
    completedTurns: 0,
    errorTurns: 1,
    cancelledTurns: 0,
    activeTurns: 0,
    inputTokens: 1_000,
    outputTokens: 400,
    totalTokens: 1_400,
    tokenReportedTurns: 1,
    knownCostUsd: 0.004,
    costCoverage: {
      complete: 0,
      partial: 1,
      pending: 0,
      unpriced: 0,
    },
  }],
};

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('AnalyticsPage', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    fetchAnalyticsOverviewMock.mockResolvedValue(overview);
    fetchBudgetPoliciesMock.mockResolvedValue([{
      id: 'policy-1',
      name: 'Finance daily cap',
      enabled: true,
      doc: {
        selector: { bu: 'finance' },
        groupBy: 'user',
        window: 'rolling-24h',
        limits: { totalTokens: 20_000, costUsd: 5 },
        actions: [
          { threshold: 0.8, action: 'warn' },
          { threshold: 1, action: 'block' },
        ],
      },
      createdAt: 1,
      updatedAt: 1,
    }]);
    fetchAgentBudgetStatusesMock.mockResolvedValue([{
      agentId: 'agent-1',
      state: 'warning',
      evaluatedAt: overview.to,
      matches: [{
        policyId: 'policy-1',
        policyName: 'Finance daily cap',
        bucket: { kind: 'all' },
        statuses: [{
          metric: 'totalTokens',
          spent: 17_000,
          limit: 20_000,
          ratio: 0.85,
          state: 'warning',
          action: { threshold: 0.8, action: 'warn' },
        }],
      }],
    }]);
    fetchBudgetSpendMock.mockResolvedValue({
      policyId: 'policy-1',
      window: 'rolling-24h',
      windowStart: overview.from,
      buckets: [{
        bucket: { kind: 'tag', key: 'user', value: 'alice@example.com' },
        spend: {
          totalTokens: 17_000,
          costUsd: 4.25,
          turns: 4,
          tokenReportedTurnCount: 4,
          costReportedTurnCount: 3,
        },
        statuses: [{
          metric: 'totalTokens',
          spent: 17_000,
          limit: 20_000,
          ratio: 0.85,
          state: 'warning',
          action: { threshold: 0.8, action: 'warn' },
        }, {
          metric: 'costUsd',
          spent: 4.25,
          limit: 5,
          ratio: 0.85,
          state: 'warning',
          action: { threshold: 0.8, action: 'warn' },
        }],
      }],
    });
    fetchModelGatewayStatusMock.mockResolvedValue({
      enabled: true,
      profile: 'default',
      revision: 'dev1-r1',
      state: 'healthy',
      watermarkAt: overview.to,
      lastAttemptAt: overview.to,
      lastSuccessAt: overview.to,
      lagMs: 0,
      lastError: null,
      pendingCalls: 0,
      unpricedCalls: 0,
      quarantinedTransactions: 0,
      orphanTransactions: 0,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  function renderPage(): void {
    act(() => {
      root.render(
        <MemoryRouter>
          <AnalyticsPage />
        </MemoryRouter>,
      );
    });
  }

  it('renders activity, ranked agents, honest cost coverage, and budget health', async () => {
    renderPage();
    await flushEffects();

    expect(container.textContent).toContain('Runtime analytics');
    expect(container.textContent).toContain('12.4K');
    expect(container.textContent).toContain('$0.0240');
    expect(container.textContent).toContain('Close analyst');
    expect(container.textContent).toContain('Variance reviewer');
    expect(container.textContent).toContain('1 cost gap');
    expect(container.textContent).toContain('2 of 3 turns fully priced');
    expect(container.textContent).toContain('Finance daily cap');
    expect(container.textContent).toContain('85%');
    expect(container.textContent).toContain('Gateway healthy');
    expect(container.textContent).toContain('Reported tokens');
    expect(container.textContent).toContain('Current pending');
    expect(container.textContent).toContain('Current unpriced');
    expect(container.querySelector('[data-testid="activity-chart"]')).not.toBeNull();
    expect(fetchAnalyticsOverviewMock).toHaveBeenCalledWith('24h');
  });

  it('loads and reveals a policy definition and usage ledger when its row is clicked', async () => {
    renderPage();
    await flushEffects();

    const row = container.querySelector<HTMLButtonElement>(
      'button[data-policy-row="policy-1"]',
    );
    expect(row).not.toBeNull();
    expect(row?.getAttribute('aria-expanded')).toBe('false');
    expect(fetchBudgetSpendMock).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('alice@example.com');

    await act(async () => {
      row!.click();
    });
    await flushEffects();

    expect(fetchBudgetSpendMock).toHaveBeenCalledWith('policy-1');
    expect(row?.getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('Policy definition');
    expect(container.textContent).toContain('bu = finance');
    expect(container.textContent).toContain('Group by user');
    expect(container.textContent).toContain('Rolling 24 hours');
    expect(container.textContent).toContain('Warn at 80%');
    expect(container.textContent).toContain('Block at 100%');
    expect(container.textContent).toContain('alice@example.com');
    expect(container.textContent).toContain('17K of 20K');
    expect(container.textContent).toContain('3K remaining');
    expect(container.textContent).toContain('$4.2500 of $5.0000');
    expect(container.textContent).toContain('$0.7500 remaining');
    expect(container.textContent).toContain('Tokens reported for 4 of 4 turns');
    expect(container.textContent).toContain('Cost reported for 3 of 4 turns');

    await act(async () => {
      row!.click();
      row!.click();
    });
    await flushEffects();
    expect(fetchBudgetSpendMock).toHaveBeenCalledTimes(1);
  });

  it('offers an in-row retry when policy usage cannot be loaded', async () => {
    fetchBudgetSpendMock
      .mockRejectedValueOnce(new Error('spend temporarily unavailable'));
    renderPage();
    await flushEffects();

    const row = container.querySelector<HTMLButtonElement>(
      'button[data-policy-row="policy-1"]',
    );
    await act(async () => {
      row!.click();
    });
    await flushEffects();

    expect(container.textContent).toContain(
      'Policy usage could not be loaded: spend temporarily unavailable',
    );
    const retry = container.querySelector<HTMLButtonElement>(
      'button[data-policy-spend-retry="policy-1"]',
    );
    expect(retry).not.toBeNull();

    await act(async () => {
      retry!.click();
    });
    await flushEffects();

    expect(fetchBudgetSpendMock).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('alice@example.com');
    expect(container.textContent).not.toContain('spend temporarily unavailable');
  });

  it('keeps core analytics available when supplemental health data fails and refetches windows', async () => {
    fetchBudgetPoliciesMock.mockRejectedValueOnce(new Error('budgets unavailable'));
    fetchAgentBudgetStatusesMock.mockRejectedValueOnce(new Error('statuses unavailable'));
    fetchModelGatewayStatusMock.mockRejectedValueOnce(new Error('gateway unavailable'));
    renderPage();
    await flushEffects();

    expect(container.textContent).toContain('Close analyst');
    expect(container.textContent).toContain('Budget and gateway health is temporarily unavailable.');

    const sevenDays = container.querySelector(
      'button[data-analytics-window="7d"]',
    );
    expect(sevenDays).not.toBeNull();
    await act(async () => {
      sevenDays!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(fetchAnalyticsOverviewMock).toHaveBeenLastCalledWith('7d');
  });
});
