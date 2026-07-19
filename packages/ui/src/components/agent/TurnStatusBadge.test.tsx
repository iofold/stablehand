import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TurnStatusBadge } from './TurnStatusBadge';

describe('TurnStatusBadge (ADR 013)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
  });

  it('renders a running turn without a restore marker', () => {
    act(() => {
      root.render(<TurnStatusBadge status="RUNNING" />);
    });
    expect(container.querySelector('[data-testid="turn-status-badge-restore-failed"]')).toBeNull();
    expect(container.textContent).toContain('running');
  });

  it('shows the resumable chip for finished runs on a CHECKPOINTED sandbox', () => {
    act(() => {
      root.render(<TurnStatusBadge status="COMPLETED" sandboxStatus="CHECKPOINTED" />);
    });
    const wrapper = container.querySelector('[data-testid="turn-status-badge-resumable"]');
    expect(wrapper).not.toBeNull();
    expect(container.textContent).toContain('completed');
    expect(container.textContent).toContain('resumable');
  });

  it('shows resumable independently of the turn status', () => {
    act(() => {
      root.render(<TurnStatusBadge status="RUNNING" sandboxStatus="CHECKPOINTED" />);
    });
    expect(container.querySelector('[data-testid="turn-status-badge-resumable"]')).not.toBeNull();
    expect(container.textContent).toContain('running');
    expect(container.textContent).toContain('resumable');
  });

  it('renders no restore-failed marker without a checkpointed sandbox', () => {
    act(() => {
      root.render(<TurnStatusBadge status="RUNNING" />);
    });
    expect(container.querySelector('[data-testid="turn-status-badge-restore-failed"]')).toBeNull();
  });

  it('renders the restore-failed marker for a checkpointed sandbox with an error', () => {
    act(() => {
      root.render(
        <TurnStatusBadge
          status="RUNNING"
          sandboxStatus="CHECKPOINTED"
          lastRestoreError="snapshot corrupted"
        />,
      );
    });

    const wrapper = container.querySelector('[data-testid="turn-status-badge-restore-failed"]') as HTMLElement | null;
    expect(wrapper).not.toBeNull();
    expect(wrapper!.getAttribute('title')).toContain('Last restore error: snapshot corrupted');
    expect(container.textContent).toContain('restore failed');
  });

  it('does not show restore failure without a checkpoint even if an old error is present', () => {
    act(() => {
      root.render(<TurnStatusBadge status="RUNNING" lastRestoreError="stale" />);
    });
    expect(container.querySelector('[data-testid="turn-status-badge-restore-failed"]')).toBeNull();
  });
});
