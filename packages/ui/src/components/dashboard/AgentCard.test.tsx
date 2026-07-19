import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentCard } from './AgentCard';
import type { Agent } from '@/stores/agents';

const navigateMock = vi.fn();

vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock,
}));

const baseAgent: Agent = {
  id: 'agent-1',
  name: 'Agent 1',
  status: 'idle',
  tools: [],
  harness: 'langgraph',
  harnessConfig: { model: 'gpt-5.4-mini' },
};

describe('AgentCard', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    navigateMock.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  function renderCard() {
    act(() => {
      root.render(<AgentCard agent={baseAgent} />);
    });
  }

  function statusLabel() {
    return container.querySelector('[data-testid="agent-status-label"]')?.textContent;
  }

  it('navigates to the agent detail page when the card is clicked', async () => {
    renderCard();

    await act(async () => {
      container.querySelector('[data-testid="agent-card"]')?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });

    expect(navigateMock).toHaveBeenCalledWith('/agents/agent-1');
  });

  it('opens a new conversation without bubbling to the detail navigation', async () => {
    renderCard();

    const newConversationButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('New Conversation'),
    );

    await act(async () => {
      newConversationButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(navigateMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith('/agents/agent-1/conversations/new');
  });

  it('shows an explicit idle status even with no active sessions', () => {
    renderCard();

    expect(statusLabel()).toContain('Idle');
    expect(container.textContent).toContain('Sessions');
    expect(container.textContent).toContain('0');
  });

  it('renders sandbox session counts under an honest label (ctx-ohq4)', () => {
    act(() => {
      root.render(<AgentCard agent={{
        ...baseAgent,
        sandboxSessionsByStatus: {
          ACTIVE: 2,
          CHECKPOINTED: 1,
          RESTORING: 0,
          TERMINATED: 3,
        },
      }} />);
    });

    expect(container.textContent).toContain('Sessions');
    const counts = container.querySelector('[role="status"]');
    expect(counts?.getAttribute('aria-label')).toBe('6 sandbox sessions: 2 running, 1 resumable, 3 ended');
    // Live vocabulary only: running and resumable counts render; ended
    // sandboxes stay in the tooltip/aria-label.
    expect(counts?.textContent).toContain('2');
    expect(counts?.textContent).toContain('running');
    expect(counts?.textContent).toContain('1');
    expect(counts?.textContent).toContain('resumable');
    expect(counts?.textContent).not.toContain('3');
  });

  it('maps unknown agent status values with no active sessions to idle', () => {
    act(() => {
      root.render(<AgentCard agent={{ ...baseAgent, status: 'legacy-status' }} />);
    });

    expect(statusLabel()).toContain('Idle');
  });

  it('shows an explicit running status for active agents', () => {
    act(() => {
      root.render(<AgentCard agent={{ ...baseAgent, status: 'running' }} />);
    });

    expect(statusLabel()).toContain('Running');
  });

  it('maps active sandbox sessions to an explicit running status', () => {
    act(() => {
      root.render(<AgentCard agent={{
        ...baseAgent,
        status: 'legacy-status',
        sandboxSessionsByStatus: {
          ACTIVE: 1,
          CHECKPOINTED: 0,
          RESTORING: 0,
          TERMINATED: 0,
        },
      }} />);
    });

    expect(statusLabel()).toContain('Running');
  });
});
