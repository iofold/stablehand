import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { BudgetsSection } from './BudgetsSection';

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
        actions: [{ threshold: 1, action: 'block' }],
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
        bucket: 'user=alice@acme.com',
        spend: { totalTokens: 150000, costUsd: 0, turns: 12 },
        statuses: [{ metric: 'totalTokens', spent: 150000, limit: 200000, ratio: 0.75 }],
      },
    ],
  }),
  createBudgetPolicy: vi.fn(),
  updateBudgetPolicy: vi.fn(),
  deleteBudgetPolicy: vi.fn(),
}));

describe('BudgetsSection', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
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
  });
});
