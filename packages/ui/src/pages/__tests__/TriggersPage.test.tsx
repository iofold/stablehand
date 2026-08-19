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
import { makeAgentFixture } from '@/test/agent-fixture';

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

function setControlValue(control: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = control instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  setter?.call(control, value);
  control.dispatchEvent(new Event('input', { bubbles: true }));
  control.dispatchEvent(new Event('change', { bubbles: true }));
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
      agents: [makeAgentFixture({ status: 'idle', harness: 'test', harnessConfig: {} })],
      loading: false,
      error: null,
      fetchAgents: vi.fn().mockResolvedValue(undefined),
    }));

    fetchTriggersMock.mockResolvedValue([{
      id: 'trigger-1',
      agentId: 'agent-1',
      eventType: 'turn.completed',
      taskTemplate: 'summarize',
      enabled: true,
      createdAt: 1_755_000_000_000,
    }]);
    fetchEventTypesMock.mockResolvedValue({ types: ['turn.completed'] });
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

    expect(container.textContent).toContain('turn.completed');
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

  it('rolls back optimistic toggle and shows row-level error when update fails', async () => {
    updateTriggerMock.mockRejectedValueOnce(new Error('toggle failed'));

    act(() => {
      root.render(<TriggersPage />);
    });
    await flushEffects();

    // Capture initial enabled state from the visible "Enabled" badge text.
    expect(container.textContent).toContain('Enabled');

    const toggle = Array.from(container.querySelectorAll('button')).find((button) =>
      button.className.includes('relative inline-flex'),
    );
    expect(toggle).not.toBeNull();

    await act(async () => {
      toggle!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    // Row-level inline error rendered.
    const rowError = container.querySelector('[data-testid="trigger-row-error"]');
    expect(rowError).not.toBeNull();
    expect(rowError!.textContent).toContain('Failed to update trigger status.');
    // Optimistic toggle was rolled back: the trigger is still shown as Enabled.
    expect(container.textContent).toContain('Enabled');
  });

  it('rolls back optimistic delete and re-shows the row when delete fails', async () => {
    deleteTriggerMock.mockRejectedValueOnce(new Error('delete failed'));

    act(() => {
      root.render(<TriggersPage />);
    });
    await flushEffects();

    // Trigger card present before action.
    const cardsBefore = container.querySelectorAll('[data-testid="trigger-card"]');
    expect(cardsBefore.length).toBe(1);

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

    // Row was rolled back into the list and shows row-level error.
    const cardsAfter = container.querySelectorAll('[data-testid="trigger-card"]');
    expect(cardsAfter.length).toBe(1);
    const rowError = container.querySelector('[data-testid="trigger-row-error"]');
    expect(rowError).not.toBeNull();
    expect(rowError!.textContent).toContain('Failed to delete trigger.');
  });

  it('clears an existing selector with an explicit null update', async () => {
    fetchTriggersMock.mockResolvedValueOnce([{
      id: 'trigger-1',
      agentId: 'agent-1',
      eventType: 'turn.completed',
      taskTemplate: 'summarize',
      selector: { kind: 'invoice' },
      enabled: true,
      createdAt: 1_755_000_000_000,
    }]);

    act(() => {
      root.render(<TriggersPage />);
    });
    await flushEffects();

    const editButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.title === 'Edit trigger',
    );
    expect(editButton).not.toBeNull();
    act(() => {
      editButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const selector = container.querySelector<HTMLTextAreaElement>('textarea[placeholder=\'{"key": "value"}\']');
    expect(selector).not.toBeNull();
    act(() => setControlValue(selector!, ''));

    const updateButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.trim() === 'Update',
    );
    expect(updateButton).not.toBeNull();
    await act(async () => {
      updateButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(updateTriggerMock).toHaveBeenCalledWith('trigger-1', expect.objectContaining({
      selector: null,
    }));
  });

  it('rejects a selector JSON array before making an API request', async () => {
    act(() => {
      root.render(<TriggersPage />);
    });
    await flushEffects();

    const editButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.title === 'Edit trigger',
    );
    act(() => {
      editButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const selector = container.querySelector<HTMLTextAreaElement>('textarea[placeholder=\'{"key": "value"}\']');
    act(() => setControlValue(selector!, '[]'));
    const updateButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.trim() === 'Update',
    );
    await act(async () => {
      updateButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(updateTriggerMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Selector must be a JSON object.');
  });

  it('shows the server mutation detail when saving fails', async () => {
    updateTriggerMock.mockRejectedValueOnce(new Error('Trigger conflict detail'));

    act(() => {
      root.render(<TriggersPage />);
    });
    await flushEffects();

    const editButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.title === 'Edit trigger',
    );
    act(() => {
      editButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const updateButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.trim() === 'Update',
    );
    await act(async () => {
      updateButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('Trigger conflict detail');
  });
});
