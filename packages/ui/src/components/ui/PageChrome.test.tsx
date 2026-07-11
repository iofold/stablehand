import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AlertBanner } from './AlertBanner';
import { PageShell } from './PageShell';
import { StatsRow } from './StatsRow';

describe('page chrome', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('renders page headings, actions, metrics, and alert actions', () => {
    const onRetry = vi.fn();
    act(() => root.render(
      <div>
        <PageShell title="Events" description="Monitor activity" actions={<button>Refresh</button>} />
        <StatsRow items={[{ label: 'Total', value: 12 }]} />
        <AlertBanner
          tone="warning"
          message="Types unavailable"
          actionLabel="Retry"
          onAction={onRetry}
          testId="retry-types"
        />
      </div>,
    ));

    expect(container.textContent).toContain('Events');
    expect(container.textContent).toContain('Monitor activity');
    expect(container.textContent).toContain('Total');
    expect(container.querySelector<HTMLElement>('[data-testid="retry-types"]')).not.toBeNull();

    act(() => container.querySelector<HTMLButtonElement>('[data-testid="retry-types"]')?.click());
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
