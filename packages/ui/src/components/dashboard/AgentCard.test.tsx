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

  it('navigates to the agent detail page when the card is clicked', async () => {
    renderCard();

    await act(async () => {
      container.querySelector('[data-testid="agent-card"]')?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });

    expect(navigateMock).toHaveBeenCalledWith('/agents/agent-1');
  });

  it('opens a new session without bubbling to the detail navigation', async () => {
    renderCard();

    const newSessionButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('New Session'),
    );

    await act(async () => {
      newSessionButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(navigateMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith('/agents/agent-1/sessions/new');
  });
});
