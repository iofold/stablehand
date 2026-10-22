import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToolCallCard } from './ToolCallCard';

describe('ToolCallCard', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
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

  const nameText = () => container.querySelector('[data-testid="tool-call-name"]')?.textContent;

  it('shows a plain label and summary, with the raw name in details', () => {
    act(() => {
      root.render(
        <ToolCallCard
          toolCall={{
            id: 't1',
            name: 'mcp__stablehand__request-approval',
            args: JSON.stringify({ reason: 'Write the summary file', details: { action: 'Write' } }),
            status: 'complete',
          }}
        />,
      );
    });

    expect(nameText()).toBe('Approval request');
    expect(container.textContent).toContain('Write the summary file');
    expect(container.textContent).not.toContain('mcp__stablehand__');
    expect(container.textContent).not.toContain('Arguments');

    const toggle = container.querySelector('button');
    act(() => {
      toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('mcp__stablehand__request-approval');
    expect(container.textContent).toContain('Arguments');
  });

  it('opens failed calls so the error is visible', () => {
    act(() => {
      root.render(
        <ToolCallCard
          toolCall={{ id: 't2', name: 'Bash', args: '{"command":"exit 1"}', error: 'exit code 1', status: 'error' }}
        />,
      );
    });

    expect(container.textContent).toContain('exit code 1');
  });

  it('labels calls with no recorded name without inventing one', () => {
    act(() => {
      root.render(
        <ToolCallCard toolCall={{ id: 't3', name: 'unknown', args: '{"todos":[]}', status: 'complete' }} />,
      );
    });

    expect(nameText()).toBe('Tool call');
    act(() => {
      container.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.textContent).toContain('Not recorded');
  });

  it('names A2UI cards after the rendered component', () => {
    act(() => {
      root.render(
        <ToolCallCard
          toolCall={{
            id: 't4',
            name: 'mcp__stablehand__a2ui-render',
            args: JSON.stringify({ component: 'MetricCard', props: { title: 'Growth', value: '2,600', suffix: 'subs' } }),
            status: 'complete',
          }}
        />,
      );
    });

    expect(nameText()).toBe('Metric');
    expect(container.querySelector('[data-testid="a2ui-metric-card"]')).not.toBeNull();
    expect(container.textContent).toContain('2,600');
  });
});
