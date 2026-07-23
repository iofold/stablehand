import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentSecretsTab } from './AgentSecretsTab';
import { deleteSecret, fetchSecretKeys, setSecret } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  deleteSecret: vi.fn(),
  fetchSecretKeys: vi.fn(),
  setSecret: vi.fn(),
}));

const deleteSecretMock = vi.mocked(deleteSecret);
const fetchSecretKeysMock = vi.mocked(fetchSecretKeys);
const setSecretMock = vi.mocked(setSecret);

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function changeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('AgentSecretsTab', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    fetchSecretKeysMock.mockResolvedValue({ keys: [] });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('preserves key spelling and the exact multiline secret value', async () => {
    act(() => root.render(<AgentSecretsTab agentId="agent-1" />));
    await flushEffects();

    const add = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Add Secret')) as HTMLButtonElement;
    act(() => add.click());

    const keyInput = container.querySelector('[data-testid="secret-key-input"]') as HTMLInputElement;
    const valueInput = container.querySelector('[data-testid="secret-value-input"]') as HTMLTextAreaElement;
    const exactValue = '  first line\nsecond line  ';
    act(() => {
      changeValue(keyInput, 'mixed.Case-Key');
      changeValue(valueInput, exactValue);
    });

    expect(valueInput.tagName).toBe('TEXTAREA');
    const save = container.querySelector('[data-testid="save-secret-button"]') as HTMLButtonElement;
    await act(async () => {
      save.click();
      await Promise.resolve();
    });

    expect(setSecretMock).toHaveBeenCalledWith(
      'agent-1',
      'mixed.Case-Key',
      exactValue,
    );
  });

  it('shows the server mutation error instead of replacing it with a generic message', async () => {
    setSecretMock.mockRejectedValue(new Error('Secret storage is unavailable'));
    act(() => root.render(<AgentSecretsTab agentId="agent-1" />));
    await flushEffects();

    const add = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Add Secret')) as HTMLButtonElement;
    act(() => add.click());
    const keyInput = container.querySelector('[data-testid="secret-key-input"]') as HTMLInputElement;
    const valueInput = container.querySelector('[data-testid="secret-value-input"]') as HTMLInputElement;
    act(() => {
      changeValue(keyInput, 'TOKEN');
      changeValue(valueInput, 'value');
    });

    await act(async () => {
      (container.querySelector('[data-testid="save-secret-button"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Secret storage is unavailable');
  });

  void deleteSecretMock;
});
