import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { BudgetsSection } from './BudgetsSection';
import {
  deleteBudgetPolicy,
  fetchBudgetPolicies,
  fetchBudgetSpend,
  updateBudgetPolicy,
} from '@/lib/api';

vi.mock('@/lib/api', () => ({
  fetchBudgetPolicies: vi.fn().mockResolvedValue([
    {
      id: 'p1',
      name: 'per-user daily cap',
      enabled: true,
      doc: {
        selector: { bu: 'finance' },
        groupBy: 'user',
        window: 'rolling-24h',
        limits: { totalTokens: 200000 },
        actions: [
          { threshold: 0.5, action: 'warn' },
          { threshold: 0.9, action: 'block' },
        ],
      },
      createdAt: 1,
      updatedAt: 1,
    },
  ]),
  fetchBudgetSpend: vi.fn().mockResolvedValue({
    policyId: 'p1',
    window: 'rolling-24h',
    windowStart: 0,
    buckets: [
      {
        bucket: { kind: 'tag', key: 'user', value: 'alice@acme.com' },
        spend: {
          totalTokens: 150000,
          costUsd: 0,
          turns: 12,
          tokenReportedTurnCount: 12,
          costReportedTurnCount: 12,
        },
        statuses: [{
          metric: 'totalTokens',
          spent: 150000,
          limit: 200000,
          ratio: 0.75,
          state: 'warning',
          action: { threshold: 0.5, action: 'warn' },
        }],
      },
    ],
  }),
  createBudgetPolicy: vi.fn(),
  updateBudgetPolicy: vi.fn(),
  deleteBudgetPolicy: vi.fn(),
}));

const updateBudgetPolicyMock = vi.mocked(updateBudgetPolicy);
const deleteBudgetPolicyMock = vi.mocked(deleteBudgetPolicy);
const fetchBudgetPoliciesMock = vi.mocked(fetchBudgetPolicies);
const fetchBudgetSpendMock = vi.mocked(fetchBudgetSpend);

const POLICY = {
  id: 'p1',
  name: 'per-user daily cap',
  enabled: true,
  doc: {
    selector: { bu: 'finance' },
    groupBy: 'user',
    window: 'rolling-24h',
    limits: { totalTokens: 200000 },
    actions: [
      { threshold: 0.5, action: 'warn' },
      { threshold: 0.9, action: 'block' },
    ],
  },
  createdAt: 1,
  updatedAt: 1,
} as const;

const SPEND = {
  policyId: 'p1',
  window: 'rolling-24h',
  windowStart: 0,
  buckets: [{
    bucket: { kind: 'tag', key: 'user', value: 'alice@acme.com' },
    spend: {
      totalTokens: 150000,
      costUsd: 0,
      turns: 12,
      tokenReportedTurnCount: 12,
      costReportedTurnCount: 12,
    },
    statuses: [{
      metric: 'totalTokens',
      spent: 150000,
      limit: 200000,
      ratio: 0.75,
      state: 'warning',
      action: { threshold: 0.5, action: 'warn' },
    }],
  }],
} as const;

describe('BudgetsSection', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    fetchBudgetPoliciesMock.mockReset().mockResolvedValue([POLICY] as never);
    fetchBudgetSpendMock.mockReset().mockResolvedValue(SPEND as never);
    updateBudgetPolicyMock.mockReset().mockResolvedValue(POLICY as never);
    deleteBudgetPolicyMock.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
    vi.clearAllMocks();
  });

  it('lists policies with selector, groupBy, and window summary', async () => {
    await act(async () => {
      root.render(<BudgetsSection />);
    });

    expect(container.textContent).toContain('per-user daily cap');
    expect(container.textContent).toContain('by user');
    expect(container.textContent).toContain('rolling-24h');
  });

  it('loads and renders spend meters on expand', async () => {
    await act(async () => {
      root.render(<BudgetsSection />);
    });

    const toggle = container.querySelector('[aria-label="Toggle spend for per-user daily cap"]') as HTMLButtonElement;
    expect(toggle).not.toBeNull();
    await act(async () => {
      toggle.click();
    });

    expect(container.textContent).toContain('user=alice@acme.com');
    expect(container.textContent).toContain('150K / 200K tokens');
    expect(container.querySelector('.bg-status-warning')).not.toBeNull();
  });

  it('preserves meaningful precision for sub-dollar cost meters', async () => {
    fetchBudgetSpendMock.mockResolvedValueOnce({
      ...SPEND,
      buckets: [{
        ...SPEND.buckets[0],
        spend: {
          ...SPEND.buckets[0].spend,
          costUsd: 0.017,
        },
        statuses: [{
          metric: 'costUsd',
          spent: 0.017,
          limit: 0.01,
          ratio: 1.7,
          state: 'warning',
          action: { threshold: 0.5, action: 'warn' },
        }],
      }],
    } as never);

    await act(async () => {
      root.render(<BudgetsSection />);
    });

    const toggle = container.querySelector('[aria-label="Toggle spend for per-user daily cap"]') as HTMLButtonElement;
    await act(async () => {
      toggle.click();
    });

    expect(container.textContent).toContain('0.0170 / 0.0100 USD');
    expect(container.textContent).not.toContain('0 / 0 USD');
  });

  it('shows the API detail when enabling a policy fails', async () => {
    updateBudgetPolicyMock.mockRejectedValueOnce(new Error('Budget update denied'));
    await act(async () => {
      root.render(<BudgetsSection />);
    });

    const enabled = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    await act(async () => {
      enabled!.click();
      await Promise.resolve();
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Budget update denied');
    expect(container.textContent).toContain('per-user daily cap');
  });

  it('shows the API detail and keeps the row when deletion fails', async () => {
    deleteBudgetPolicyMock.mockRejectedValueOnce(new Error('Budget deletion denied'));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await act(async () => {
      root.render(<BudgetsSection />);
    });

    const remove = container.querySelector<HTMLButtonElement>('[aria-label="Delete per-user daily cap"]');
    await act(async () => {
      remove!.click();
      await Promise.resolve();
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Budget deletion denied');
    expect(container.textContent).toContain('per-user daily cap');
    vi.mocked(window.confirm).mockRestore();
  });
});
