import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TriggersPage } from '../TriggersPage';
import { useAgentsStore } from '@/stores/agents';
import {
  deleteTrigger,
  fetchEventTypes,
  fetchTriggers,
  updateTrigger,
} from '@/lib/api';

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return {
    ...actual,
    fetchTriggers: vi.fn(),
    fetchEventTypes: vi.fn(),
    updateTrigger: vi.fn(),
    deleteTrigger: vi.fn(),
  };
});

const fetchTriggersMock = vi.mocked(fetchTriggers);
const fetchEventTypesMock = vi.mocked(fetchEventTypes);
const updateTriggerMock = vi.mocked(updateTrigger);
const deleteTriggerMock = vi.mocked(deleteTrigger);

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('TriggersPage', () => {
  let container: HTMLDivElement;
  let root: Root;

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
    }));

    fetchTriggersMock.mockResolvedValue([{
      id: 'trigger-1',
      agentId: 'agent-1',
      eventType: 'run.completed',
      taskTemplate: 'summarize',
      enabled: true,
    }]);
    fetchEventTypesMock.mockResolvedValue({ types: ['run.completed'] });
    updateTriggerMock.mockResolvedValue({ id: 'trigger-1' } as never);
    deleteTriggerMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  it('shows a blocking retryable error on trigger load failures', async () => {
    fetchTriggersMock.mockRejectedValueOnce(new Error('triggers down'));

    act(() => {
      root.render(<TriggersPage />);
    });
    await flushEffects();

    expect(container.textContent).toContain('Failed to load triggers.');
    const retryButton = container.querySelector('button[data-testid="triggers-retry-button"]');
    expect(retryButton).not.toBeNull();

    await act(async () => {
      retryButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(container.textContent).toContain('run.completed');
    expect(fetchTriggersMock).toHaveBeenCalledTimes(2);
  });

  it('shows a visible retryable warning when event types fail to load', async () => {
    fetchEventTypesMock.mockRejectedValueOnce(new Error('types down'));

    act(() => {
      root.render(<TriggersPage />);
    });
    await flushEffects();

    expect(container.textContent).toContain('Event type suggestions are unavailable.');
    const retryButton = container.querySelector('button[data-testid="triggers-type-retry-button"]');
    expect(retryButton).not.toBeNull();

    await act(async () => {
      retryButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(container.textContent).not.toContain('Event type suggestions are unavailable.');
    expect(fetchEventTypesMock).toHaveBeenCalledTimes(2);
  });

  it('shows a visible action error when toggling a trigger fails', async () => {
    updateTriggerMock.mockRejectedValueOnce(new Error('toggle failed'));

    act(() => {
      root.render(<TriggersPage />);
    });
    await flushEffects();

    const toggle = Array.from(container.querySelectorAll('button')).find((button) =>
      button.className.includes('relative inline-flex'),
    );
    expect(toggle).not.toBeNull();

    await act(async () => {
      toggle!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(container.textContent).toContain('Failed to update trigger status.');
  });

  it('shows a visible action error when deleting a trigger fails', async () => {
    deleteTriggerMock.mockRejectedValueOnce(new Error('delete failed'));

    act(() => {
      root.render(<TriggersPage />);
    });
    await flushEffects();

    const deleteButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.title === 'Delete trigger',
    );
    expect(deleteButton).not.toBeNull();

    await act(async () => {
      deleteButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const confirmButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Confirm'),
    );
    expect(confirmButton).not.toBeNull();

    await act(async () => {
      confirmButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(container.textContent).toContain('Failed to delete trigger.');
  });
});
