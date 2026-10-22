import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { McpServersSection } from './McpServersSection';
import { connectMcpServer, fetchMcpServers } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  connectMcpServer: vi.fn(),
  disconnectMcpServer: vi.fn(),
  fetchMcpServers: vi.fn(),
  refreshMcpServer: vi.fn(),
}));

const fetchMock = vi.mocked(fetchMcpServers);
const connectMock = vi.mocked(connectMcpServer);

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('McpServersSection', () => {
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
    vi.clearAllMocks();
  });

  it('shows plain tool names, approval marks and a sign-in link with its host', async () => {
    fetchMock.mockResolvedValue([
      {
        name: 'apify',
        url: 'https://mcp.apify.com/?tools=x',
        authType: 'bearer',
        state: 'ready',
        connected: true,
        toolCount: 2,
        lastListedAt: 1,
        tools: [
          { name: 'apify__get-dataset-items', mcpName: 'get-dataset-items', displayName: 'Get dataset items', requiresApproval: false },
          { name: 'apify__abort-actor-run', mcpName: 'abort-actor-run', displayName: 'Abort Actor run', requiresApproval: true },
        ],
      },
      {
        name: 'granola',
        url: 'https://mcp.granola.ai/mcp',
        authType: 'oauth',
        state: 'needs_auth',
        message: 'granola is not connected yet. Open the agent\'s Tools tab and press Connect.',
        connected: false,
        toolCount: 0,
        lastListedAt: null,
        tools: [],
      },
    ]);
    connectMock.mockResolvedValue({
      authorizationUrl: 'https://mcp-auth.granola.ai/oauth2/authorize?client_id=abc&state=s',
      host: 'mcp-auth.granola.ai',
      expiresAt: Date.now() + 600_000,
    });

    act(() => root.render(<McpServersSection agentId="agent-1" />));
    await flushEffects();

    expect(container.textContent).toContain('Get dataset items');
    expect(container.textContent).toContain('asks first');
    expect(container.textContent).toContain('Needs sign-in');
    expect(container.textContent).not.toContain('Disconnect');

    const connect = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Connect') as HTMLButtonElement;
    await act(async () => {
      connect.click();
      await Promise.resolve();
    });
    await flushEffects();

    expect(connectMock).toHaveBeenCalledWith('agent-1', 'granola');
    const signIn = container.querySelector('[data-testid="mcp-sign-in"]');
    expect(signIn?.textContent).toContain('mcp-auth.granola.ai');
    const link = signIn?.querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://mcp-auth.granola.ai/oauth2/authorize?client_id=abc&state=s');
    expect(link?.getAttribute('rel')).toContain('noopener');
  });
});
