import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentDetailPage } from '../AgentDetailPage';
import { useAgentsStore } from '@/stores/agents';

const mocks = vi.hoisted(() => ({
  agentOverviewProps: vi.fn(),
  agentToolsProps: vi.fn(),
  navigate: vi.fn(),
  loadConversations: vi.fn(),
  loadTurns: vi.fn(),
  useAgentDetail: vi.fn(),
  useAgentTurns: vi.fn(),
}));

vi.mock('react-router-dom', () => ({
  useParams: () => ({ id: 'agent-1' }),
  useNavigate: () => mocks.navigate,
  useSearchParams: () => {
    const [params, setParams] = useState(() => new URLSearchParams());
    return [
      params,
      (update: URLSearchParams | ((prev: URLSearchParams) => URLSearchParams)) => {
        setParams((prev: URLSearchParams) =>
          typeof update === 'function' ? update(prev) : update);
      },
    ] as const;
  },
}));

vi.mock('@/hooks/useAgentDetail', () => ({
  useAgentDetail: mocks.useAgentDetail,
}));

vi.mock('@/hooks/useAgentTurns', () => ({
  useAgentTurns: mocks.useAgentTurns,
}));

vi.mock('@/components/agents/AgentFormModal', () => ({
  AgentFormModal: () => null,
}));

vi.mock('@/components/agent', () => ({
  AgentOverviewTab: (props: { onViewAllConversations: () => void }) => {
    mocks.agentOverviewProps(props);
    return (
      <button type="button" data-testid="view-all-conversations" onClick={props.onViewAllConversations}>
        View All Conversations
      </button>
    );
  },
  AgentTurnsTab: () => <div data-testid="conversations-history" />,
  AgentToolsTab: (props: unknown) => {
    mocks.agentToolsProps(props);
    return <div data-testid="agent-tools" />;
  },
  AgentFilesTab: () => null,
  AgentArtifactsTab: () => null,
  AgentSecretsTab: () => null,
}));

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('AgentDetailPage background run mutation', () => {
  let container: HTMLDivElement;
  let root: Root;
  const startBackgroundRun = vi.fn();

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    startBackgroundRun.mockResolvedValue(undefined);
    useAgentsStore.setState((state) => ({ ...state, startBackgroundRun }));
    mocks.useAgentDetail.mockReturnValue({
      agent: {
        id: 'agent-1',
        name: 'Agent 1',
        status: 'active',
        harness: 'test',
        harnessConfig: {},
        tools: ['base-tool'],
        httpTools: [{
          name: 'customer-lookup',
          description: 'Look up a customer',
          endpoint: 'https://crm.example.test/customers',
          method: 'GET',
        }],
      },
      loading: false,
      agents: [{ id: 'agent-1' }],
      allTurns: [],
      turnsLoading: false,
      error: null,
      recentConversations: [],
      conversationsLoading: false,
      conversationsError: null,
      loadConversations: mocks.loadConversations,
      loadTurns: mocks.loadTurns,
    });
    mocks.useAgentTurns.mockReturnValue({ filteredTurns: [] });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('keeps the form open and shows the API detail when starting fails', async () => {
    startBackgroundRun.mockRejectedValueOnce(new Error('Sandbox capacity exhausted'));
    act(() => {
      root.render(<AgentDetailPage />);
    });

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="start-turn-button"]')!.click();
    });
    const input = container.querySelector<HTMLInputElement>('[data-testid="run-task-input"]')!;
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    act(() => {
      valueSetter?.call(input, 'Run a report');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => {
      input.closest('form')!.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    await flushEffects();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Sandbox capacity exhausted');
    expect(container.querySelector('[data-testid="run-task-input"]')).not.toBeNull();
    expect(mocks.loadTurns).not.toHaveBeenCalled();
  });

  it('labels the history as conversations and opens it from the overview', () => {
    act(() => {
      root.render(<AgentDetailPage />);
    });

    expect(container.querySelector('[data-testid="turns-tab"]')?.textContent).toBe('Conversations');
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="view-all-conversations"]')!.click();
    });
    expect(container.querySelector('[data-testid="conversations-history"]')).not.toBeNull();
  });

  it('counts and passes HTTP tools without adding them to the base tool list', () => {
    act(() => {
      root.render(<AgentDetailPage />);
    });

    expect(mocks.agentOverviewProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ toolsCount: 2 }),
    );

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="tools-tab"]')!.click();
    });
    expect(container.querySelector('[data-testid="agent-tools"]')).not.toBeNull();
    expect(mocks.agentToolsProps).toHaveBeenLastCalledWith(expect.objectContaining({
      tools: ['base-tool'],
      httpTools: [expect.objectContaining({ name: 'customer-lookup' })],
    }));
  });
});
