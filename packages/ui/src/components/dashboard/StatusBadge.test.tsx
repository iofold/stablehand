import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';

import { StatusBadge } from './StatusBadge';

describe('StatusBadge', () => {
  it('names the status subject explicitly for assistive technology', async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => {
      root.render(<StatusBadge status="completed" subject="Conversation" />);
    });

    expect(container.querySelector('[role="img"]')?.getAttribute('aria-label'))
      .toBe('Conversation status: completed');

    await act(async () => root.unmount());
  });
});
