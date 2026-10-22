import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EditableDocument } from './EditableDocument';

function changeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('EditableDocument', () => {
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

  it('approves with edits and a note', async () => {
    const onSubmit = vi.fn();
    act(() => root.render(
      <EditableDocument title="LinkedIn post" content="Draft" format="linkedin" onSubmit={onSubmit} onReject={vi.fn()} onCancel={vi.fn()} />,
    ));
    const submit = container.querySelector('[data-testid="submit-button"]') as HTMLButtonElement;
    expect(submit.textContent).toBe('Approve');

    act(() => {
      changeValue(container.querySelector('[aria-label="Draft text"]') as HTMLTextAreaElement, 'Draft, tightened');
      changeValue(container.querySelector('[aria-label="Note for the agent"]') as HTMLInputElement, 'Shorter is better');
    });
    expect(submit.textContent).toBe('Approve with edits');
    await act(async () => {
      submit.click();
      await Promise.resolve();
    });
    expect(onSubmit).toHaveBeenCalledWith('Draft, tightened', 'Shorter is better');
  });

  it('rejects with a note', async () => {
    const onReject = vi.fn();
    act(() => root.render(
      <EditableDocument title="X thread" content="Draft" onSubmit={vi.fn()} onReject={onReject} onCancel={vi.fn()} />,
    ));
    act(() => changeValue(container.querySelector('[aria-label="Note for the agent"]') as HTMLInputElement, 'Names a customer'));
    await act(async () => {
      (container.querySelector('[data-testid="reject-document-button"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(onReject).toHaveBeenCalledWith('Names a customer');
  });
});
