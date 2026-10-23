import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TurnSchema, type Turn, type TurnStopReason } from '@stablehand/contracts';

import { BudgetStopBanner } from '../BudgetStopBanner';
import { SessionThread } from '../SessionThread';
import type { Message } from '@/stores/conversation';

const RUN_LIMIT_STOP: TurnStopReason = {
  code: 'budget_reached',
  source: 'run_limit',
  capUsd: 0.05,
  spentUsd: 0.0512,
};

function makeTurn(overrides: Record<string, unknown> = {}): Turn {
  return TurnSchema.parse({
    id: 'turn-1',
    agentId: 'agent-1',
    conversationId: 'conv-1',
    sandboxSessionId: 'sandbox-1',
    status: 'ERROR',
    mode: 'interactive',
    queuedAt: 1_000,
    startedAt: 1_000,
    completedAt: 5_000,
    error: 'Stopped: this run reached its $0.05 spend cap.',
    taskDescription: null,
    usage: null,
    ...overrides,
  });
}

function message(overrides: Partial<Message>): Message {
  return {
    id: 'm-1',
    messageRevision: 0,
    role: 'assistant',
    content: '',
    createdAt: 2_000,
    ...overrides,
  } as Message;
}

describe('BudgetStopBanner', () => {
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

  it('states the consequence and the numbers for a per-run cap', () => {
    act(() => root.render(<BudgetStopBanner reason={RUN_LIMIT_STOP} />));

    const banner = container.querySelector('[data-testid="budget-stop-banner"]');
    expect(banner?.getAttribute('role')).toBe('status');
    expect(banner?.textContent).toContain('Stopped: this run reached its $0.05 spend cap');
    expect(banner?.textContent).toContain('It had spent $0.0512.');
    expect(banner?.textContent).toContain('per-run spend limit');
    // Consequence, not mechanism.
    expect(banner?.textContent).not.toMatch(/LiteLLM|virtual key|max_budget|429/);
  });

  it('names the budget whose remaining headroom capped the run', () => {
    act(() => root.render(
      <BudgetStopBanner
        reason={{
          code: 'budget_reached',
          source: 'budget_policy',
          capUsd: 1.25,
          spentUsd: 1.3,
          policyName: 'Growth team',
        }}
      />,
    ));

    expect(container.textContent).toContain('remained of the "Growth team" budget');
  });

  describe('in the session thread', () => {
    it('replaces the generic run error with the receipt and marks the divider', () => {
      act(() => root.render(
        <SessionThread
          messages={[
            message({ id: 'u-1', role: 'user', content: 'Keep researching' }),
            message({ id: 'a-1', turnId: 'turn-1', content: 'Found three sources so far.' }),
            message({ id: 'e-1', role: 'system', turnId: 'turn-1', content: 'Error: Stopped: this run reached its $0.05 spend cap.' }),
          ]}
          streamingContent=""
          isStreaming={false}
          turns={[makeTurn({ stopReason: RUN_LIMIT_STOP })]}
        />,
      ));

      expect(container.querySelectorAll('[data-testid="budget-stop-banner"]')).toHaveLength(1);
      expect(container.querySelector('[data-testid="error-display"]')).toBeNull();
      expect(container.textContent).toContain('Found three sources so far.');
      expect(container.querySelector('[data-testid="turn-divider-stopped"]')?.textContent)
        .toBe('stopped at spend cap');
    });

    it('shows a live stop before the turns list has caught up', () => {
      act(() => root.render(
        <SessionThread
          messages={[
            message({ id: 'a-1', turnId: 'turn-2', content: 'Partial answer' }),
            message({ id: 'e-1', role: 'system', turnId: 'turn-2', content: 'Error: Stopped: this run reached its $0.05 spend cap.' }),
          ]}
          streamingContent=""
          isStreaming={false}
          turnStopReasons={new Map([['turn-2', RUN_LIMIT_STOP]])}
        />,
      ));

      expect(container.querySelectorAll('[data-testid="budget-stop-banner"]')).toHaveLength(1);
      expect(container.querySelector('[data-testid="error-display"]')).toBeNull();
    });

    it('still shows the receipt for a stopped run that left no messages', () => {
      act(() => root.render(
        <SessionThread
          messages={[message({ id: 'a-0', turnId: 'turn-0', content: 'Earlier answer' })]}
          streamingContent=""
          isStreaming={false}
          turns={[
            makeTurn({ id: 'turn-0', status: 'COMPLETED', error: null, startedAt: 100 }),
            makeTurn({ id: 'turn-1', stopReason: RUN_LIMIT_STOP, startedAt: 1_000 }),
          ]}
        />,
      ));

      expect(container.querySelectorAll('[data-testid="budget-stop-banner"]')).toHaveLength(1);
    });

    it('keeps ordinary failures as errors', () => {
      act(() => root.render(
        <SessionThread
          messages={[message({ id: 'e-1', role: 'system', turnId: 'turn-1', content: 'Error: tool exploded' })]}
          streamingContent=""
          isStreaming={false}
          turns={[makeTurn({ error: 'tool exploded' })]}
        />,
      ));

      expect(container.querySelector('[data-testid="budget-stop-banner"]')).toBeNull();
      expect(container.querySelector('[data-testid="error-display"]')).not.toBeNull();
    });
  });
});
