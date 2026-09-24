import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TurnSchema } from '@stablehand/contracts';

import { AgentTurnsTab } from './AgentTurnsTab';
import { restoreSandboxSession } from '@/lib/api';
import type { AgentTurn } from '@/stores/agents';

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return {
    ...actual,
    restoreSandboxSession: vi.fn(),
  };
});

const restoreSandboxSessionMock = vi.mocked(restoreSandboxSession);

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function makeTurn(overrides: Record<string, unknown> = {}): AgentTurn {
  return TurnSchema.parse({
    id: 'turn-1',
    agentId: 'agent-1',
    conversationId: 'conv-1',
    status: 'COMPLETED',
    mode: 'background',
    queuedAt: 1_700_000_000_000,
    startedAt: 1_700_000_000_000,
    completedAt: 1_700_000_001_000,
    sandboxSessionId: null,
    error: null,
    taskDescription: null,
    conversationMessageCount: 1,
    usage: null,
    ...overrides,
  });
}

describe('AgentTurnsTab error vs empty', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  it('renders the empty state when there are no turns and no error', () => {
    act(() => {
      root.render(
        <AgentTurnsTab
          turns={[]}
          loading={false}
          filter="all"
          onFilterChange={() => undefined}
          agentId="agent-1"
        />,
      );
    });

    expect(container.querySelector('[data-testid="turns-empty-state"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="turns-load-error"]')).toBeNull();
    expect(container.textContent).toContain('No turns found');
    expect(container.textContent).toContain('Start a turn to view activity.');
  });

  it('renders an error banner instead of the empty state when load failed', () => {
    act(() => {
      root.render(
        <AgentTurnsTab
          turns={[]}
          loading={false}
          error="boom: 500"
          filter="all"
          onFilterChange={() => undefined}
          agentId="agent-1"
        />,
      );
    });

    expect(container.querySelector('[data-testid="turns-load-error"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="turns-empty-state"]')).toBeNull();
    expect(container.textContent).toContain('Failed to load conversations');
    expect(container.textContent).toContain('boom: 500');
  });

  it('invokes onRetry when the retry button is clicked', async () => {
    const onRetry = vi.fn();
    act(() => {
      root.render(
        <AgentTurnsTab
          turns={[]}
          loading={false}
          error="boom"
          filter="all"
          onFilterChange={() => undefined}
          agentId="agent-1"
          onRetry={onRetry}
        />,
      );
    });

    const retry = container.querySelector('[data-testid="turns-retry-button"]') as HTMLButtonElement | null;
    expect(retry).not.toBeNull();

    await act(async () => {
      retry!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('still shows the turn list when turns are present even if filter is restrictive', () => {
    const turns = [makeTurn()];
    act(() => {
      root.render(
        <AgentTurnsTab
          turns={turns}
          loading={false}
          filter="all"
          onFilterChange={() => undefined}
          agentId="agent-1"
        />,
      );
    });

    expect(container.querySelector('[data-testid="turns-empty-state"]')).toBeNull();
    expect(container.querySelector('[data-testid="turns-load-error"]')).toBeNull();
    // Conversation row renders
    expect(container.textContent).toContain('conv-1'.slice(0, 8));
  });

  it('shows the real conversation message count once when multiple turns share a conversation', () => {
    const turns = [
      makeTurn({ id: 'turn-1', conversationMessageCount: 3 }),
      makeTurn({ id: 'turn-2', startedAt: 1_700_000_002_000, conversationMessageCount: 3 }),
    ];
    act(() => {
      root.render(
        <AgentTurnsTab
          turns={turns}
          loading={false}
          filter="all"
          onFilterChange={() => undefined}
          agentId="agent-1"
        />,
      );
    });

    const cells = Array.from(container.querySelectorAll('tbody tr:first-child td'))
      .map((cell) => cell.textContent?.trim() ?? '');
    expect(cells).toContain('3');
    expect(cells).not.toContain('6');
  });

  it('distinguishes pending conversation cost from a complete zero-cost turn', () => {
    const turns = [
      makeTurn({
        usage: {
          inputTokens: 120,
          outputTokens: 30,
          totalTokens: 150,
          modelCalls: { observed: 1, costKnown: 0, expected: 1 },
          cost: { totalUsd: null, knownUsd: 0, coverage: 'pending' },
        },
      }),
    ];

    act(() => {
      root.render(
        <AgentTurnsTab
          turns={turns}
          loading={false}
          filter="all"
          onFilterChange={() => undefined}
          agentId="agent-1"
        />,
      );
    });

    expect(container.textContent).toContain('Cost pending');

    const firstRow = container.querySelector('tbody tr') as HTMLElement | null;
    act(() => {
      firstRow!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.querySelector('[data-testid="turn-cost"]')?.textContent).toBe('Cost pending');
  });
});

describe('AgentTurnsTab restore retry (ADR 013)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    restoreSandboxSessionMock.mockReset();
    restoreSandboxSessionMock.mockResolvedValue({
      sandboxSessionId: 'sbx-1',
      status: 'ACTIVE',
      restoreAttempts: 0,
    });
  });

  afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
    vi.clearAllMocks();
  });

  function renderWith(turns: AgentTurn[]) {
    act(() => {
      root.render(
        <AgentTurnsTab
          turns={turns}
          loading={false}
          filter="all"
          onFilterChange={() => undefined}
          agentId="agent-1"
        />,
      );
    });
  }

  function expandFirstConversation() {
    const firstRow = container.querySelector('tbody tr') as HTMLElement | null;
    expect(firstRow).not.toBeNull();
    act(() => {
      firstRow!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  }

  it('does not show retry-restore button when sandboxStatus is CHECKPOINTED but lastRestoreError is null', () => {
    renderWith([makeTurn({ status: 'ERROR', sandboxStatus: 'CHECKPOINTED', lastRestoreError: null })]);
    expandFirstConversation();
    expect(container.querySelector('[data-testid="retry-restore-button"]')).toBeNull();
  });

  it('does not show retry-restore button when sandboxStatus is ACTIVE even with a stale lastRestoreError', () => {
    renderWith([makeTurn({ status: 'ERROR', sandboxStatus: 'ACTIVE', lastRestoreError: 'previously failed' })]);
    expandFirstConversation();
    expect(container.querySelector('[data-testid="retry-restore-button"]')).toBeNull();
  });

  it('does not show retry-restore button without a sandboxSessionId', () => {
    renderWith([makeTurn({ status: 'ERROR', sandboxStatus: 'CHECKPOINTED', lastRestoreError: 'snapshot corrupted' })]);
    expandFirstConversation();
    expect(container.querySelector('[data-testid="retry-restore-button"]')).toBeNull();
  });

  it('shows retry-restore button when projected ERROR has CHECKPOINTED sandbox with non-null lastRestoreError', () => {
    renderWith([makeTurn({ status: 'ERROR', sandboxStatus: 'CHECKPOINTED', lastRestoreError: 'snapshot corrupted', sandboxSessionId: 'sbx-1' })]);
    expandFirstConversation();
    const button = container.querySelector('[data-testid="retry-restore-button"]') as HTMLButtonElement | null;
    expect(button).not.toBeNull();
    expect(button!.getAttribute('title')).toContain('snapshot corrupted');
    expect(container.querySelector('[data-testid="restore-error-detail"]')!.textContent).toContain('snapshot corrupted');
  });

  it('POSTs to the restore endpoint when retry-restore is clicked', async () => {
    renderWith([makeTurn({ status: 'ERROR', sandboxStatus: 'CHECKPOINTED', lastRestoreError: 'gone', sandboxSessionId: 'sbx-1' })]);
    expandFirstConversation();
    const button = container.querySelector('[data-testid="retry-restore-button"]') as HTMLButtonElement;

    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(restoreSandboxSessionMock).toHaveBeenCalledWith('agent-1', 'sbx-1');
  });

  it('refetches turns after a restore retry succeeds', async () => {
    const onRetry = vi.fn();
    act(() => {
      root.render(
        <AgentTurnsTab
          turns={[makeTurn({ status: 'ERROR', sandboxStatus: 'CHECKPOINTED', lastRestoreError: 'gone', sandboxSessionId: 'sbx-1' })]}
          loading={false}
          filter="all"
          onFilterChange={() => undefined}
          agentId="agent-1"
          onRetry={onRetry}
        />,
      );
    });
    expandFirstConversation();
    const button = container.querySelector('[data-testid="retry-restore-button"]') as HTMLButtonElement;

    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('surfaces a final-failure toast when retry-restore POST fails', async () => {
    restoreSandboxSessionMock.mockRejectedValueOnce(new Error('still corrupted'));
    renderWith([makeTurn({ status: 'ERROR', sandboxStatus: 'CHECKPOINTED', lastRestoreError: 'gone', sandboxSessionId: 'sbx-1' })]);
    expandFirstConversation();

    const button = container.querySelector('[data-testid="retry-restore-button"]') as HTMLButtonElement;
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const toast = container.querySelector('[data-testid="restore-failure-toast"]');
    expect(toast).not.toBeNull();
    expect(toast!.textContent).toContain('still corrupted');
  });
});
