import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TokenGate } from './TokenGate';
import { useApiAuthStore } from '@/lib/auth';

const mockJson = vi.fn();
const mockFetch = vi.fn<() => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>>();

describe('TokenGate', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.localStorage.clear();
    useApiAuthStore.setState({ token: '', authRequired: false });
    mockJson.mockResolvedValue({});
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: mockJson });
    globalThis.fetch = mockFetch as unknown as typeof fetch;
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

  function render() {
    act(() => {
      root.render(<TokenGate />);
    });
  }

  it('renders only when auth is required', () => {
    render();
    expect(container.textContent).not.toContain('API token required');

    act(() => {
      useApiAuthStore.getState().setAuthRequired(true);
    });

    expect(container.textContent).toContain('API token required');
  });

  it('validates the token against /api/config and hides after success', async () => {
    act(() => {
      useApiAuthStore.getState().setAuthRequired(true);
    });
    render();

    const input = container.querySelector('input');
    const form = container.querySelector('form');
    expect(input).not.toBeNull();
    expect(form).not.toBeNull();

    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )?.set;
      valueSetter?.call(input, 'secret-token');
      input!.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await act(async () => {
      form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(mockFetch).toHaveBeenCalledWith('/api/config', {
      headers: { Authorization: 'Bearer secret-token' },
    });
    expect(useApiAuthStore.getState().authRequired).toBe(false);
    expect(container.textContent).not.toContain('API token required');
  });
});
