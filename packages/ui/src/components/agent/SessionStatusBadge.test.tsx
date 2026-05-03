import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SessionStatusBadge } from './SessionStatusBadge';

describe('SessionStatusBadge (ADR 013)', () => {
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

  it('renders without restore-failed marker for ACTIVE sessions', () => {
    act(() => {
      root.render(<SessionStatusBadge status="ACTIVE" />);
    });
    expect(container.querySelector('[data-testid="session-status-badge-restore-failed"]')).toBeNull();
    expect(container.textContent).toContain('active');
  });

  it('renders without restore-failed marker for CHECKPOINTED sessions with no lastRestoreError', () => {
    act(() => {
      root.render(<SessionStatusBadge status="CHECKPOINTED" />);
    });
    expect(container.querySelector('[data-testid="session-status-badge-restore-failed"]')).toBeNull();
  });

  it('renders the restore-failed marker only for CHECKPOINTED + non-null lastRestoreError', () => {
    act(() => {
      root.render(<SessionStatusBadge status="CHECKPOINTED" lastRestoreError="snapshot corrupted" />);
    });

    const wrapper = container.querySelector('[data-testid="session-status-badge-restore-failed"]') as HTMLElement | null;
    expect(wrapper).not.toBeNull();
    expect(wrapper!.getAttribute('title')).toContain('Last restore error: snapshot corrupted');
    expect(container.textContent).toContain('restore failed');
  });

  it('does not show restore failure for non-CHECKPOINTED states even if lastRestoreError is set', () => {
    act(() => {
      root.render(<SessionStatusBadge status="ACTIVE" lastRestoreError="stale" />);
    });
    expect(container.querySelector('[data-testid="session-status-badge-restore-failed"]')).toBeNull();
  });
});
