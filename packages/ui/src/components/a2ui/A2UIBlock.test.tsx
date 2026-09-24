import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { A2UIBlock } from './A2UIBlock';
import { registerComponent } from './CatalogRegistry';

describe('A2UIBlock', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    // React 19 requires this flag for act() in custom test harnesses.
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('renders unknown components as a fallback card', () => {
    act(() => {
      root.render(
        <A2UIBlock
          block={{ id: 'b1', component: 'UnknownThing', props: { value: 1 } }}
        />,
      );
    });

    expect(container.textContent).toContain('Unknown Component');
    expect(container.textContent).toContain('UnknownThing');
  });

  it('renders HITL component names as unknown (not supported in A2UI)', () => {
    act(() => {
      root.render(
        <A2UIBlock
          block={{
            id: 'b2',
            component: 'stablehand.hitl:ApprovalCard',
            props: {
              title: 'Approve deployment',
              description: 'Review the deployment request.',
              action: 'deploy',
              details: { env: 'prod' },
            },
          }}
        />,
      );
    });

    expect(container.textContent).toContain('Unknown Component');
  });

  it('isolates render failures to the block', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const Boom = () => {
      throw new Error('boom');
    };
    registerComponent('BoomBlock', Boom);

    act(() => {
      root.render(
        <A2UIBlock
          block={{ id: 'b3', component: 'BoomBlock', props: {} }}
        />,
      );
    });

    expect(container.querySelector('[data-testid="a2ui-block-error"]')).not.toBeNull();
    expect(container.textContent).toContain('Render Failed');
    expect(container.textContent).toContain('boom');

    errorSpy.mockRestore();
  });
});
