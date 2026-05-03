import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Dashboard } from './Dashboard';

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
}));

// AgentFormModal pulls in API; stub it out to keep this test focused on
// the empty-vs-error rendering decision.
vi.mock('@/components/agents/AgentFormModal', () => ({
  AgentFormModal: () => null,
}));

describe('Dashboard error vs empty rendering', () => {
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

  it('shows the onboarding empty state when there are no agents and no error', () => {
    act(() => {
      root.render(<Dashboard agents={[]} loading={false} error={null} />);
    });

    expect(container.textContent).toContain('No agents yet');
    expect(container.textContent).not.toContain('Failed to load agents');
    expect(container.querySelector('[data-testid="dashboard-load-error"]')).toBeNull();
  });

  it('shows the load error banner instead of the empty state when fetch fails', () => {
    act(() => {
      root.render(<Dashboard agents={[]} loading={false} error="Network error: 503" />);
    });

    expect(container.textContent).toContain('Failed to load agents');
    expect(container.textContent).toContain('Network error: 503');
    expect(container.textContent).not.toContain('No agents yet');
    expect(container.querySelector('[data-testid="dashboard-load-error"]')).not.toBeNull();
  });

  it('invokes onRetry when the retry button is clicked', async () => {
    const retry = vi.fn();
    act(() => {
      root.render(<Dashboard agents={[]} loading={false} error="boom" onRetry={retry} />);
    });

    const retryButton = container.querySelector('[data-testid="dashboard-retry-button"]') as HTMLButtonElement | null;
    expect(retryButton).not.toBeNull();

    await act(async () => {
      retryButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(retry).toHaveBeenCalledTimes(1);
  });
});
