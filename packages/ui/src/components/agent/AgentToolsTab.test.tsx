import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentToolsTab } from './AgentToolsTab';

const fetchCatalogToolsMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api', () => ({
  fetchCatalogTools: fetchCatalogToolsMock,
}));

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('AgentToolsTab', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    fetchCatalogToolsMock.mockResolvedValue([
      { name: 'emit-event', description: 'Emit an event', builtin: true },
      { name: 'request-approval', description: 'Request approval', builtin: true },
      { name: 'custom-tool', description: 'Custom tool', builtin: false },
    ]);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('shows canonical policies and only lists builtin tools enabled by policy', async () => {
    act(() => root.render(
      <AgentToolsTab
        agentId="agent-1"
        tools={['custom-tool']}
        nativeToolPolicy={{ policy: 'deny', names: ['Write'] }}
        builtinToolPolicy={{ policy: 'none' }}
      />,
    ));
    await flushEffects();

    expect(container.textContent).toContain('Native SDK tools — Deny listed');
    expect(container.textContent).toContain('Write');
    expect(container.textContent).toContain('Built-in tools — None');

    const cards = [...container.querySelectorAll('[data-testid="tool-detail-card"]')]
      .map((card) => card.textContent);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toContain('custom-tool');
    expect(cards.join(' ')).not.toContain('emit-event');
    expect(cards.join(' ')).not.toContain('request-approval');
  });

  it('renders HTTP tools as separate capabilities without mixing them into base tools', async () => {
    act(() => root.render(
      <AgentToolsTab
        agentId="agent-1"
        tools={['custom-tool']}
        builtinToolPolicy={{ policy: 'none' }}
        httpTools={[{
          name: 'customer-lookup',
          description: 'Look up a customer in the CRM',
          endpoint: 'https://crm.example.test/customers',
          method: 'GET',
        }]}
      />,
    ));
    await flushEffects();

    const baseCards = [...container.querySelectorAll('[data-testid="tool-detail-card"]')]
      .map((card) => card.textContent ?? '');
    const httpCards = [...container.querySelectorAll('[data-testid="http-tool-card"]')]
      .map((card) => card.textContent ?? '');

    const httpSection = container.querySelector('[data-testid="http-tools-section"]');
    expect(httpSection).not.toBeNull();
    expect(httpSection!.textContent).toContain('HTTP tools');
    expect(baseCards).toHaveLength(1);
    expect(baseCards[0]).toContain('custom-tool');
    expect(baseCards.join(' ')).not.toContain('customer-lookup');
    expect(httpCards).toHaveLength(1);
    expect(httpCards[0]).toContain('customer-lookup');
    expect(httpCards[0]).toContain('GET');
    expect(httpCards[0]).toContain('https://crm.example.test/customers');
    expect(httpCards[0]).toContain('Look up a customer in the CRM');
  });
});
