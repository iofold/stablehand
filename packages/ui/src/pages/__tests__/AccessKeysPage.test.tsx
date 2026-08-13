import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AccessKeysPage } from '../AccessKeysPage';
import {
  createApiKey,
  fetchApiKeys,
  fetchConfig,
  revokeApiKey,
} from '@/lib/api';

vi.mock('@/lib/api', () => ({
  createApiKey: vi.fn(),
  fetchApiKeys: vi.fn(),
  fetchConfig: vi.fn(),
  revokeApiKey: vi.fn(),
}));

const createApiKeyMock = vi.mocked(createApiKey);
const fetchApiKeysMock = vi.mocked(fetchApiKeys);
const fetchConfigMock = vi.mocked(fetchConfig);
const revokeApiKeyMock = vi.mocked(revokeApiKey);

const activeKey = {
  id: 'key_1',
  name: 'artifact-gallery',
  capabilities: ['artifacts:read', 'webhooks:manage'],
  note: 'Gallery extension',
  status: 'active' as const,
  createdAt: 1_786_000_000_000,
  createdBy: 'master',
  expiresAt: null,
  lastUsedAt: null,
  revokedAt: null,
};

const enforcedConfig = {
  system: { version: 'test', uptime: 1_000, dbPath: '/tmp/test.db' },
  agentDefaults: { harness: 'langgraph', temperature: 0.7, maxTokens: 4096 },
  authentication: { mode: 'enforced' as const },
};

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function setInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('AccessKeysPage', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    window.localStorage.clear();
    fetchConfigMock.mockResolvedValue(enforcedConfig);
    fetchApiKeysMock.mockResolvedValue({ keys: [activeKey] });
    createApiKeyMock.mockResolvedValue({
      ...activeKey,
      token: `cmk_${'a'.repeat(43)}`,
    });
    revokeApiKeyMock.mockResolvedValue({
      ...activeKey,
      status: 'revoked',
      revokedAt: 1_786_000_001_000,
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  async function render(): Promise<void> {
    act(() => {
      root.render(
        <MemoryRouter initialEntries={['/settings/access-keys']}>
          <AccessKeysPage />
        </MemoryRouter>,
      );
    });
    await flushEffects();
  }

  function button(label: string): HTMLButtonElement {
    const found = Array.from(container.querySelectorAll('button')).find(
      (candidate) => candidate.textContent?.trim() === label,
    );
    if (!(found instanceof HTMLButtonElement)) throw new Error(`Button not found: ${label}`);
    return found;
  }

  it('lists lifecycle status and creates an artifact-consumer key with a transient token', async () => {
    const storageSpy = vi.spyOn(Storage.prototype, 'setItem');
    await render();

    expect(container.textContent).toContain('Runtime');
    expect(container.textContent).toContain('Access keys');
    expect(container.textContent).toContain('artifact-gallery');
    expect(container.textContent).toContain('Active');
    expect(container.textContent).toContain('Never');
    expect(container.textContent).toContain('Never authenticated');

    act(() => button('Create access key').click());
    expect(container.textContent).toContain('Permission receipt');
    expect(container.textContent).toContain('Read artifacts');
    expect(container.textContent).toContain('Manage webhooks');
    expect(container.textContent).toContain('Always blocked');
    expect(container.textContent).toContain('Secrets and workspace files');

    const name = container.querySelector<HTMLInputElement>('#access-key-name');
    expect(name).not.toBeNull();
    setInput(name!, 'artifact-gallery-next');
    const form = container.querySelector<HTMLFormElement>('form[aria-label="Create access key"]');
    await act(async () => {
      form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(createApiKeyMock).toHaveBeenCalledWith({
      name: 'artifact-gallery-next',
      capabilities: ['artifacts:read', 'webhooks:manage'],
      expiresAt: null,
    });
    const token = `cmk_${'a'.repeat(43)}`;
    expect(container.textContent).toContain(token);
    expect(storageSpy).not.toHaveBeenCalledWith(expect.any(String), expect.stringContaining(token));

    act(() => button('I saved it').click());
    expect(container.textContent).not.toContain(token);
  });

  it('keeps key metadata and revocation visible in a responsive mobile row', async () => {
    await render();

    const table = container.querySelector('table');
    const row = Array.from(container.querySelectorAll('tbody tr')).find(
      (candidate) => candidate.textContent?.includes(activeKey.name),
    );
    expect(table?.className).toContain('max-sm:block');
    expect(row?.className).toContain('max-sm:grid');
    expect(row?.textContent).toContain('Capabilities');
    expect(row?.textContent).toContain('Expires');
    expect(row?.textContent).toContain('Created');
    expect(row?.textContent).toContain('Last authenticated');
    expect(row?.querySelector<HTMLButtonElement>('button')?.textContent).toContain('Revoke');
  });

  it('builds a namespace-limited custom event grant in the receipt', async () => {
    await render();
    act(() => button('Create access key').click());
    act(() => button('Custom').click());

    const emit = container.querySelector<HTMLInputElement>('#capability-triggers-emit');
    expect(emit).not.toBeNull();
    act(() => emit!.click());
    act(() => button('Limit namespace').click());
    const namespace = container.querySelector<HTMLInputElement>('#event-namespace');
    expect(namespace).not.toBeNull();
    setInput(namespace!, 'gallery');

    expect(container.textContent).toContain('triggers:emit:custom.gallery.*');
    expect(container.textContent).toContain('Only custom.gallery.* events');
  });

  it('accepts the full namespace length allowed by the capability contract', async () => {
    await render();
    act(() => button('Create access key').click());
    act(() => button('Custom').click());
    act(() => container.querySelector<HTMLInputElement>('#capability-triggers-emit')!.click());
    act(() => button('Limit namespace').click());

    const namespace = 'a'.repeat(125);
    setInput(container.querySelector<HTMLInputElement>('#event-namespace')!, namespace);

    expect(container.textContent).toContain(`triggers:emit:custom.${namespace}.*`);
  });

  it('disables key creation when API authentication is disabled', async () => {
    fetchConfigMock.mockResolvedValue({
      ...enforcedConfig,
      authentication: { mode: 'disabled' },
    });

    await render();

    expect(container.textContent).toContain('API authentication is disabled');
    expect(button('Create access key').disabled).toBe(true);
  });

  it('warns that revocation does not clean up extension resources', async () => {
    await render();

    await act(async () => {
      button('Revoke').click();
    });

    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining(
      'Existing turns, webhooks, schedules, artifacts, and signed URLs are not removed',
    ));
    expect(revokeApiKeyMock).toHaveBeenCalledWith('key_1');
    expect(container.textContent).toContain('Revoked');
  });
});
