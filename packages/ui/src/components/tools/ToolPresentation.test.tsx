import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToolBadges, ToolDetailsPanel } from './ToolPresentation';

describe('tool presentation', () => {
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

  it('renders normalized badges and tool details', () => {
    act(() => root.render(
      <div>
        <ToolBadges tool={{ builtin: true, location: 'daemon', source: 'local', requiresApproval: true }} compact />
        <ToolDetailsPanel tool={{ inputSchema: { type: 'object' }, secrets: ['API_KEY'] }} compact />
      </div>,
    ));

    expect(container.textContent).toContain('builtin');
    expect(container.textContent).toContain('daemon');
    expect(container.textContent).toContain('local');
    expect(container.textContent).toContain('approval');
    expect(container.textContent).toContain('Input Schema');
    expect(container.textContent).toContain('API_KEY');
  });
});
