import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalCard } from './ApprovalCard';

describe('ApprovalCard', () => {
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

  it('leads with the reason and renders details as labelled rows and lists', () => {
    act(() => {
      root.render(
        <ApprovalCard
          toolLabel="Approval request"
          toolName="mcp__stablehand__request-approval"
          isApprovalRequest
          reason="Write the Q3 summary file."
          details={{
            action: 'Write /workspace/approval-result.md',
            content_preview: 'Three-line Q3 summary',
            downstream_steps: ['Render status card', 'Upload file'],
          }}
          onApprove={vi.fn()}
          onReject={vi.fn()}
        />,
      );
    });

    expect(container.querySelector('[data-testid="approval-reason"]')?.textContent)
      .toBe('Write the Q3 summary file.');
    expect(container.textContent).toContain('Content preview');
    expect(container.textContent).toContain('Downstream steps');
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(container.textContent).not.toContain('{');
    expect(container.textContent).not.toContain('request-approval');
  });

  it('describes a gated tool plainly when no reason is given', () => {
    act(() => {
      root.render(
        <ApprovalCard
          toolLabel="Delete file"
          toolName="delete_file"
          details={{ path: '/workspace/old.csv' }}
          onApprove={vi.fn()}
          onReject={vi.fn()}
        />,
      );
    });

    expect(container.textContent).toContain('The agent wants to run Delete file.');
    expect(container.textContent).toContain('/workspace/old.csv');
  });

  it('sends the decision', async () => {
    const onApprove = vi.fn();
    act(() => {
      root.render(
        <ApprovalCard toolLabel="Approval request" toolName="request-approval" onApprove={onApprove} onReject={vi.fn()} />,
      );
    });

    await act(async () => {
      container.querySelector('[data-testid="approve-button"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="approval-approved"]')).not.toBeNull();
  });
});
