import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TurnSchema } from '@stablehand/contracts';

import { TurnInspectorPanel } from './TurnInspectorPanel';
import { fetchAgentBudgetStatuses, fetchTurnDetail } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  fetchTurnDetail: vi.fn(),
  fetchAgentBudgetStatuses: vi.fn(),
}));

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function stoppedTurn(stopReason: Record<string, unknown>) {
  return TurnSchema.parse({
    id: 'turn-1',
    agentId: 'agent-1',
    conversationId: 'conv-1',
    sandboxSessionId: 'sandbox-1',
    status: 'ERROR',
    mode: 'interactive',
    queuedAt: 1_700_000_000_000,
    startedAt: 1_700_000_000_000,
    completedAt: 1_700_000_042_000,
    error: 'Stopped: this run reached its $0.05 spend cap.',
    stopReason,
    taskDescription: null,
    usage: null,
  });
}

describe('TurnInspectorPanel spend-cap receipt', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.mocked(fetchAgentBudgetStatuses).mockResolvedValue([]);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function renderPanel(): Promise<void> {
    act(() => root.render(
      <MemoryRouter>
        <TurnInspectorPanel agentId="agent-1" turnId="turn-1" onClose={vi.fn()} />
      </MemoryRouter>,
    ));
    await flushEffects();
  }

  it('shows the stop as a receipt with cap and spend instead of a failure', async () => {
    vi.mocked(fetchTurnDetail).mockResolvedValue({
      turn: stoppedTurn({ code: 'budget_reached', source: 'run_limit', capUsd: 0.05, spentUsd: 0.0512 }),
      messages: [],
    });

    await renderPanel();

    expect(container.querySelector('[data-testid="budget-stop-banner"]')?.textContent)
      .toContain('Stopped: this run reached its $0.05 spend cap');
    expect(container.textContent).not.toContain('This turn failed');
    expect(container.textContent).toContain('Spend cap');
    expect(container.textContent).toContain('(per-run limit)');
    expect(container.textContent).toContain('Spent when stopped');
  });

  it('names the budget policy when its headroom was the cap', async () => {
    vi.mocked(fetchTurnDetail).mockResolvedValue({
      turn: stoppedTurn({
        code: 'budget_reached',
        source: 'budget_policy',
        capUsd: 1.25,
        spentUsd: null,
        policyId: 'p1',
        policyName: 'Growth team',
      }),
      messages: [],
    });

    await renderPanel();

    expect(container.textContent).toContain('(left in "Growth team")');
    expect(container.textContent).toContain('Not reported');
  });
});
