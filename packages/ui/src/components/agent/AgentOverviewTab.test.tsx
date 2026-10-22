import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, ConversationSummary } from '@stablehand/contracts';

import { AgentOverviewTab } from './AgentOverviewTab';

// The embedded budget card loads live budget status; keep these tests focused
// on the overview content.
vi.mock('@/lib/api', () => ({
  fetchAgentBudgetStatuses: vi.fn(async () => []),
  fetchBudgetPolicies: vi.fn(async () => []),
}));

const AGENT = {
  id: 'agent-1',
  name: 'Close Assistant',
  harness: 'langgraph',
  harnessConfig: { provider: 'openai', model: 'gpt-5.4-mini' },
  systemPrompt: 'Help with the close.',
  tools: [],
  description: null,
  workspaceDir: '/workspace',
  status: 'idle',
  manifest: null,
  metadata: null,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  builtinToolPolicy: null,
  nativeToolPolicy: null,
  httpTools: [],
  workspaceContent: null,
  mode: null,
  resourceLimits: null,
} as unknown as Agent;

function conversation(index: number): ConversationSummary {
  return {
    id: `conversation-${index}`,
    agentId: 'agent-1',
    status: index === 0 ? 'ACTIVE' : 'COMPLETED',
    mode: 'interactive',
    turnCount: index + 1,
    messageCount: (index + 1) * 2,
    taskDescription: `Close task ${index}`,
    startedAt: 1_700_000_000_000 - index * 1_000,
    completedAt: index === 0 ? null : 1_700_000_000_500 - index * 1_000,
    updatedAt: 1_700_000_000_500 - index * 1_000,
    latestTurnId: `turn-${index}`,
    sandboxSessionId: null,
    totalTokens: 100 + index,
  } as ConversationSummary;
}

describe('AgentOverviewTab recent conversations', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('shows a useful set of distinct recent conversations rather than turn rows', async () => {
    const onOpenConversation = vi.fn();
    const onViewAllConversations = vi.fn();
    const conversations = Array.from({ length: 8 }, (_, index) => conversation(index));

    await act(async () => root.render(
      <MemoryRouter>
        <AgentOverviewTab
          agent={AGENT}
          conversationCount={20}
          activeSandboxSessions={1}
          toolsCount={0}
          recentConversations={conversations}
          conversationsLoading={false}
          conversationsError={null}
          onOpenConversation={onOpenConversation}
          onViewAllConversations={onViewAllConversations}
        />
      </MemoryRouter>,
    ));

    expect(container.textContent).toContain('Recent conversations');
    expect(container.textContent).not.toContain('Recent Turns');
    expect(container.querySelectorAll('[data-testid="recent-conversation-row"]')).toHaveLength(8);
    expect(container.textContent).toContain('Close task 7');
    expect(container.textContent).toContain('8 turns');
    expect(container.textContent).toContain('16 messages');

    act(() => {
      container.querySelectorAll<HTMLButtonElement>('[data-testid="recent-conversation-row"]')[4]!.click();
    });
    expect(onOpenConversation).toHaveBeenCalledWith('conversation-4');

    const viewAll = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('View all conversations')) as HTMLButtonElement;
    act(() => viewAll.click());
    expect(onViewAllConversations).toHaveBeenCalledOnce();
  });

  it('distinguishes a load failure from an empty history', async () => {
    const retry = vi.fn();
    await act(async () => root.render(
      <MemoryRouter>
        <AgentOverviewTab
          agent={AGENT}
          conversationCount={4}
          activeSandboxSessions={0}
          toolsCount={0}
          recentConversations={[]}
          conversationsLoading={false}
          conversationsError="Conversation index unavailable"
          onOpenConversation={vi.fn()}
          onViewAllConversations={vi.fn()}
          onRetryConversations={retry}
        />
      </MemoryRouter>,
    ));

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Conversation index unavailable');
    expect(container.textContent).not.toContain('No conversations yet');
    act(() => {
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent === 'Retry')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(retry).toHaveBeenCalledOnce();
  });

  it('shows the canonical API response instead of a handwritten partial config', async () => {
    await act(async () => root.render(
      <MemoryRouter>
        <AgentOverviewTab
          agent={AGENT}
          conversationCount={0}
          activeSandboxSessions={0}
          toolsCount={0}
          recentConversations={[]}
          conversationsLoading={false}
          conversationsError={null}
          onOpenConversation={vi.fn()}
          onViewAllConversations={vi.fn()}
        />
      </MemoryRouter>,
    ));

    act(() => {
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent?.includes('Configuration'))!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('API response');
    expect(container.textContent).toContain('"httpTools": []');
    expect(container.textContent).toContain('"resourceLimits": null');
  });
});
