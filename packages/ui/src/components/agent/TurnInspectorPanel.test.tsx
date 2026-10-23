import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TurnSchema } from '@stablehand/contracts';

import { TurnInspectorPanel } from './TurnInspectorPanel';
import {
  fetchAgent,
  fetchAgentBudgetStatuses,
  fetchArtifacts,
  fetchTurnApprovals,
  fetchTurnDetail,
  type Artifact,
} from '@/lib/api';

vi.mock('@/lib/api', () => ({
  fetchTurnDetail: vi.fn(),
  fetchAgentBudgetStatuses: vi.fn(),
  fetchAgent: vi.fn(),
  fetchTurnApprovals: vi.fn(),
  fetchArtifacts: vi.fn(),
  downloadArtifact: vi.fn(),
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
    vi.mocked(fetchAgent).mockResolvedValue({ harnessConfig: { model: 'gpt-5.4-mini' } } as unknown as Awaited<ReturnType<typeof fetchAgent>>);
    vi.mocked(fetchTurnApprovals).mockResolvedValue([]);
    vi.mocked(fetchArtifacts).mockResolvedValue({ artifacts: [] });
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

  it('lists the model, the approvals and the files the turn produced', async () => {
    vi.mocked(fetchTurnDetail).mockResolvedValue({
      turn: TurnSchema.parse({
        ...stoppedTurn({ code: 'budget_reached', source: 'run_limit', capUsd: 0.05, spentUsd: 0.05 }),
        status: 'COMPLETED',
        error: null,
        stopReason: undefined,
      }),
      messages: [],
    });
    vi.mocked(fetchTurnApprovals).mockResolvedValue([
      {
        id: 'int-1',
        turnId: 'turn-1',
        toolName: 'request-approval',
        args: { reason: "Publish today's brief to the gallery" },
        status: 'resolved',
        createdAt: 1_700_000_010_000,
        resolvedAt: 1_700_000_020_000,
        resolvedAction: 'approve',
      },
      {
        id: 'int-2',
        turnId: 'turn-1',
        toolName: 'send_email',
        args: {},
        status: 'resolved',
        createdAt: 1_700_000_030_000,
        resolvedAt: 1_700_000_031_000,
        resolvedAction: 'reject',
      },
    ]);
    vi.mocked(fetchArtifacts).mockResolvedValue({
      artifacts: [
        { id: 'a2', name: 'overnight-brief.html', sizeBytes: 18_400, createdAt: 2 },
        { id: 'a1', name: 'weather.png', sizeBytes: 512_000, createdAt: 1 },
      ] as unknown as Artifact[],
    });

    await renderPanel();

    expect(fetchTurnApprovals).toHaveBeenCalledWith('agent-1', 'turn-1');
    expect(fetchArtifacts).toHaveBeenCalledWith('agent-1', 'turn-1');
    expect(container.textContent).toContain('gpt-5.4-mini');
    const approvals = [...container.querySelectorAll('[data-testid="turn-approval"]')].map((row) => row.textContent);
    expect(approvals).toHaveLength(2);
    expect(approvals[0]).toContain("Publish today's brief to the gallery");
    expect(approvals[0]).toContain('Approved');
    expect(approvals[1]).toContain('Send email');
    expect(approvals[1]).toContain('Rejected');
    const files = [...container.querySelectorAll('[data-testid="turn-file"]')].map((row) => row.textContent);
    expect(files[0]).toContain('weather.png');
    expect(files[1]).toContain('overnight-brief.html');
  });

  it('wraps a task that is one long URL instead of running out of the panel', async () => {
    const url = `https://earthquake.usgs.gov/earthquakes/browse/significant.php?${'x'.repeat(120)}`;
    vi.mocked(fetchTurnDetail).mockResolvedValue({
      turn: TurnSchema.parse({
        ...stoppedTurn({ code: 'budget_reached', source: 'run_limit', capUsd: 0.05, spentUsd: 0.05 }),
        taskDescription: `Overnight briefing run. Sources: ${url}`,
      }),
      messages: [],
    });

    await renderPanel();

    const task = container.querySelector('[data-testid="turn-task"]');
    expect(task?.textContent).toContain(url);
    expect(task?.className).toContain('[overflow-wrap:anywhere]');
  });

  it('says so when a turn asked for no approvals and made no files', async () => {
    vi.mocked(fetchTurnDetail).mockResolvedValue({
      turn: stoppedTurn({ code: 'budget_reached', source: 'run_limit', capUsd: 0.05, spentUsd: 0.05 }),
      messages: [],
    });

    await renderPanel();

    expect(container.textContent).toContain('None asked for.');
    expect(container.textContent).toContain('No files from this turn.');
  });
});
