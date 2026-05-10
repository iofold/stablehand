import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventsPage } from '../EventsPage';
import { useAgentsStore } from '@/stores/agents';
import {
  fetchEvents,
  fetchEventStats,
  fetchEventTypes,
} from '@/lib/api';

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return {
    ...actual,
    fetchEvents: vi.fn(),
    fetchEventStats: vi.fn(),
    fetchEventTypes: vi.fn(),
  };
});

const fetchEventsMock = vi.mocked(fetchEvents);
const fetchEventStatsMock = vi.mocked(fetchEventStats);
const fetchEventTypesMock = vi.mocked(fetchEventTypes);

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('EventsPage', () => {
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

    fetchEventTypesMock.mockResolvedValue({ types: ['run.completed'] });
    fetchEventStatsMock.mockResolvedValue({
      total: 1,
      recentRate: 1,
      byType: { 'run.completed': 1 },
      topAgents: [{ agentId: 'agent-1', count: 1 }],
    });
    fetchEventsMock.mockResolvedValue({
      events: [{
        seq: 1,
        type: 'run.completed',
        agentId: 'agent-1',
        createdAt: Date.now(),
        payload: JSON.stringify({ message: 'done' }),
      }],
      nextCursor: undefined,
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  it('shows a blocking retryable error on first-load failures', async () => {
    fetchEventsMock.mockRejectedValueOnce(new Error('events down'));

    act(() => {
      root.render(<EventsPage />);
    });
    await flushEffects();

    expect(container.textContent).toContain('Failed to load event log.');
    const retryButton = container.querySelector('button[data-testid="events-retry-button"]');
    expect(retryButton).not.toBeNull();

    await act(async () => {
      retryButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(container.textContent).toContain('Event Log');
    expect(container.textContent).toContain('run.completed');
    expect(fetchEventsMock).toHaveBeenCalledTimes(2);
  });

  it('shows a visible retryable warning when event types fail to load', async () => {
    fetchEventTypesMock.mockRejectedValueOnce(new Error('types down'));

    act(() => {
      root.render(<EventsPage />);
    });
    await flushEffects();

    expect(container.textContent).toContain('Event type filters are unavailable.');
    const retryButton = container.querySelector('button[data-testid="events-type-retry-button"]');
    expect(retryButton).not.toBeNull();

    await act(async () => {
      retryButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(container.textContent).not.toContain('Event type filters are unavailable.');
    expect(fetchEventTypesMock).toHaveBeenCalledTimes(2);
  });

  it('shows contextual loading text during the initial load', () => {
    fetchEventsMock.mockReturnValueOnce(new Promise(() => undefined));
    fetchEventStatsMock.mockReturnValueOnce(new Promise(() => undefined));
    fetchEventTypesMock.mockReturnValueOnce(new Promise(() => undefined));

    act(() => {
      root.render(<EventsPage />);
    });

    expect(container.textContent).toContain('Loading event log');
    expect(container.textContent).toContain('Fetching recent events, stats, and filters');
  });

  it('renders concise useful summaries for run and tool events', async () => {
    fetchEventsMock.mockResolvedValueOnce({
      events: [
        {
          seq: 1,
          type: 'run.tool_started',
          agentId: 'agent-1',
          createdAt: Date.now(),
          payload: JSON.stringify({
            toolName: 'search_docs',
            args: { query: 'checkpoint restore failures', limit: 5 },
            requiresApproval: true,
          }),
        },
        {
          seq: 2,
          type: 'run.tool_result',
          agentId: 'agent-1',
          createdAt: Date.now(),
          payload: JSON.stringify({
            toolName: 'search_docs',
            result: 'Found checkpoint lifecycle notes and restore retry guidance.',
            durationMs: 1240,
          }),
        },
        {
          seq: 3,
          type: 'turn.started',
          agentId: 'agent-1',
          createdAt: Date.now(),
          payload: JSON.stringify({
            mode: 'background',
            taskDescription: 'Summarize recent restore failures for the operator.',
          }),
        },
        {
          seq: 4,
          type: 'message.committed',
          agentId: 'agent-1',
          createdAt: Date.now(),
          payload: JSON.stringify({
            role: 'assistant',
            content: 'Restore failed because the checkpoint exceeded the configured limit.',
          }),
        },
        {
          seq: 5,
          type: 'custom',
          agentId: 'agent-1',
          createdAt: Date.now(),
          payload: JSON.stringify({
            type: 'artifact.uploaded',
            payload: { name: 'report.md', path: '/workspace/report.md' },
          }),
        },
      ],
      nextCursor: undefined,
    });

    act(() => {
      root.render(<EventsPage />);
    });
    await flushEffects();

    expect(container.textContent).toContain('Tool started: search_docs approval required');
    expect(container.textContent).toContain('query: checkpoint restore failures');
    expect(container.textContent).toContain('Tool result: search_docs (1.2s) - Found checkpoint lifecycle notes');
    expect(container.textContent).toContain('Background run started: Summarize recent restore failures');
    expect(container.textContent).toContain('Assistant message: Restore failed because');
    expect(container.textContent).toContain('Custom artifact.uploaded: name: report.md');
  });
});
