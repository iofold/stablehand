import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SchedulesPage } from '../SchedulesPage';
import { useAgentsStore } from '@/stores/agents';
import {
  fetchSchedules,
  fetchTriggers,
  fireSchedule,
  setScheduleEnabled,
  type Schedule,
  type Trigger,
} from '@/lib/api';
import { makeAgentFixture } from '@/test/agent-fixture';
import { allowConsoleErrors } from '@/test-setup-strict';

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return {
    ...actual,
    fetchSchedules: vi.fn(),
    fetchTriggers: vi.fn(),
    fireSchedule: vi.fn(),
    setScheduleEnabled: vi.fn(),
  };
});

const fetchSchedulesMock = vi.mocked(fetchSchedules);
const fetchTriggersMock = vi.mocked(fetchTriggers);
const fireScheduleMock = vi.mocked(fireSchedule);
const setScheduleEnabledMock = vi.mocked(setScheduleEnabled);

const NOW = Date.parse('2026-10-23T05:00:00Z');

function schedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 'schedule-1',
    agentId: null,
    name: 'content-factory-weekly',
    cronExpression: '0 7 * * 1',
    timezone: 'Asia/Kolkata',
    eventType: 'custom.factory.week',
    payload: {},
    enabled: true,
    createdAt: NOW - 86_400_000,
    updatedAt: NOW - 86_400_000,
    lastFiredAt: null,
    missedFireCount: 0,
    nextRunAt: NOW + 3 * 3_600_000,
    ...overrides,
  };
}

function trigger(overrides: Partial<Trigger> = {}): Trigger {
  return {
    id: 'trigger-1',
    agentId: 'agent-scout',
    eventType: 'custom.factory.week',
    taskTemplate: 'Weekly run',
    enabled: true,
    createdAt: NOW,
    ...overrides,
  };
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('SchedulesPage', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useAgentsStore.setState((state) => ({
      ...state,
      agents: [
        makeAgentFixture({ id: 'agent-scout', name: 'factory-scout' }),
        makeAgentFixture({ id: 'agent-old', name: 'old-scout' }),
      ],
      loading: false,
      error: null,
      fetchAgents: vi.fn().mockResolvedValue(undefined),
    }));
    fetchSchedulesMock.mockResolvedValue([
      schedule(),
      schedule({
        id: 'schedule-2',
        name: 'nightly-cleanup',
        cronExpression: '0 2 * * *',
        timezone: 'UTC',
        eventType: 'custom.cleanup.nightly',
        enabled: false,
        nextRunAt: null,
        lastFiredAt: NOW - 2 * 3_600_000,
        missedFireCount: 3,
      }),
    ]);
    fetchTriggersMock.mockResolvedValue([
      trigger(),
      trigger({ id: 'trigger-2', agentId: 'agent-old', enabled: false }),
    ]);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  async function render(): Promise<void> {
    act(() => {
      root.render(
        <MemoryRouter>
          <SchedulesPage />
        </MemoryRouter>,
      );
    });
    await flushEffects();
  }

  function card(id: string): HTMLElement {
    const element = container.querySelector<HTMLElement>(`[data-schedule-id="${id}"]`);
    if (!element) throw new Error(`no card for ${id}`);
    return element;
  }

  function button(scope: HTMLElement, label: string): HTMLButtonElement {
    const match = [...scope.querySelectorAll<HTMLButtonElement>('button')]
      .find((candidate) => candidate.textContent?.includes(label) || candidate.getAttribute('aria-label')?.includes(label));
    if (!match) throw new Error(`no button ${label}`);
    return match;
  }

  it('lists each schedule with its clock, next and last run, event and the agents it starts', async () => {
    await render();

    expect(container.querySelectorAll('[data-testid="schedule-card"]')).toHaveLength(2);
    expect(container.querySelector('[data-testid="schedules-count"]')?.textContent).toBe('1 of 2 on');

    const weekly = card('schedule-1');
    expect(weekly.textContent).toContain('content-factory-weekly');
    expect(weekly.textContent).toContain('0 7 * * 1 (Asia/Kolkata)');
    expect(weekly.querySelector('[data-testid="schedule-next"]')?.textContent).toContain('(in 3h)');
    expect(weekly.querySelector('[data-testid="schedule-last"]')?.textContent).toBe('Never');
    expect(weekly.textContent).toContain('custom.factory.week');
    const links = [...weekly.querySelectorAll('[data-testid="schedule-agents"] a')];
    expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['factory-scout', '/agents/agent-scout'],
      ['old-scout', '/agents/agent-old'],
    ]);
    expect(weekly.querySelector('[data-testid="schedule-agents"]')?.textContent).toContain('(trigger off)');

    const nightly = card('schedule-2');
    expect(nightly.querySelector('[data-testid="schedule-next"]')?.textContent).toBe('Off, so it will not run');
    expect(nightly.querySelector('[data-testid="schedule-last"]')?.textContent).toContain('(2h ago)');
    expect(nightly.querySelector('[data-testid="schedule-agents"]')?.textContent).toContain('No agent yet. Add a trigger');
    expect(nightly.querySelector('[data-testid="schedule-missed"]')?.textContent)
      .toBe('Missed 3 runs while Stablehand was down.');
  });

  it('turns a schedule off and on', async () => {
    setScheduleEnabledMock.mockResolvedValueOnce(schedule({ enabled: false, nextRunAt: null }));
    await render();

    const toggle = button(card('schedule-1'), 'Turn off content-factory-weekly');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    await act(async () => {
      toggle.click();
    });
    await flushEffects();

    expect(setScheduleEnabledMock).toHaveBeenCalledWith('schedule-1', false);
    expect(button(card('schedule-1'), 'Turn on content-factory-weekly').getAttribute('aria-checked')).toBe('false');
    expect(card('schedule-1').querySelector('[data-testid="schedule-next"]')?.textContent).toBe('Off, so it will not run');
  });

  it('runs a schedule now and says how many agents start', async () => {
    fireScheduleMock.mockResolvedValueOnce(schedule({ lastFiredAt: NOW }));
    await render();

    await act(async () => {
      button(card('schedule-1'), 'Run now').click();
    });
    await flushEffects();

    expect(fireScheduleMock).toHaveBeenCalledWith('schedule-1');
    expect(card('schedule-1').querySelector('[data-testid="schedule-notice"]')?.textContent)
      .toBe('Sent custom.factory.week. 1 agent starts a run.');
    expect(card('schedule-1').querySelector('[data-testid="schedule-last"]')?.textContent).toContain('(just now)');
  });

  it('shows a row error when a change fails and keeps the schedule as it was', async () => {
    allowConsoleErrors();
    setScheduleEnabledMock.mockRejectedValueOnce(new Error('down'));
    fireScheduleMock.mockRejectedValueOnce(new Error('down'));
    await render();

    await act(async () => {
      button(card('schedule-2'), 'Turn on nightly-cleanup').click();
    });
    await flushEffects();
    expect(card('schedule-2').querySelector('[role="alert"]')?.textContent).toBe('Could not turn on this schedule.');

    await act(async () => {
      button(card('schedule-2'), 'Run now').click();
    });
    await flushEffects();
    expect(card('schedule-2').querySelector('[role="alert"]')?.textContent).toBe('Could not run this schedule now.');
    expect(button(card('schedule-2'), 'Turn on nightly-cleanup').getAttribute('aria-checked')).toBe('false');
  });

  it('shows an empty state and a retryable load error', async () => {
    allowConsoleErrors();
    fetchSchedulesMock.mockResolvedValueOnce([]);
    await render();
    expect(container.querySelector('[data-testid="schedules-empty"]')?.textContent).toContain('No schedules yet');

    act(() => {
      root.unmount();
    });
    root = createRoot(container);
    fetchSchedulesMock.mockRejectedValueOnce(new Error('down'));
    await render();
    expect(container.textContent).toContain('Schedules could not be loaded.');
    await act(async () => {
      button(container, 'Retry').click();
    });
    await flushEffects();
    expect(container.querySelectorAll('[data-testid="schedule-card"]')).toHaveLength(2);
  });
});
