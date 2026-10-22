import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentFormModal } from './AgentFormModal';
import type { Agent } from '@/stores/agents';

const mocks = vi.hoisted(() => ({
  createAgent: vi.fn(),
  fetchCatalogTools: vi.fn(),
  updateAgent: vi.fn(),
}));

vi.mock('@/stores/agents', () => ({
  useAgentsStore: () => ({
    createAgent: mocks.createAgent,
    updateAgent: mocks.updateAgent,
  }),
}));

vi.mock('@/lib/api', () => ({
  fetchCatalogTools: mocks.fetchCatalogTools,
}));

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function makeAgent(
  overrides: Partial<Agent> & { mode?: 'interactive' | 'background' | 'both' | null } = {},
): Agent {
  return {
    id: 'agent-1',
    name: 'Canonical Agent',
    status: 'idle',
    tools: [],
    harness: 'langgraph',
    harnessConfig: { provider: 'openai', model: 'gpt-5.4-mini' },
    systemPrompt: 'Use the configured policies.',
    description: 'Policy test',
    workspaceDir: '/workspace',
    metadata: null,
    manifest: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    nativeToolPolicy: null,
    builtinToolPolicy: null,
    httpTools: [],
    workspaceContent: null,
    mode: null,
    resourceLimits: null,
    ...overrides,
  } as Agent;
}

describe('AgentFormModal', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.fetchCatalogTools.mockResolvedValue([
      { name: 'emit-event', description: 'Emit an event', builtin: true },
      { name: 'request-approval', description: 'Request approval', builtin: true },
    ]);
    mocks.updateAgent.mockResolvedValue(undefined);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('round-trips explicit native and builtin policies as top-level contract fields', async () => {
    const agent = makeAgent({
      name: 'Policy Agent',
      metadata: { owner: 'runtime' },
      nativeToolPolicy: { policy: 'deny', names: ['Write'] },
      builtinToolPolicy: { policy: 'deny', names: ['emit-event'] },
    });

    act(() => root.render(
      <AgentFormModal open agent={agent} onClose={vi.fn()} />,
    ));
    await flushEffects();

    const save = [...document.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Save Changes')) as HTMLButtonElement;
    await act(async () => {
      save.click();
      await Promise.resolve();
    });

    expect(mocks.updateAgent).toHaveBeenCalledWith('agent-1', expect.objectContaining({
      nativeToolPolicy: { policy: 'deny', names: ['Write'] },
      builtinToolPolicy: { policy: 'deny', names: ['emit-event'] },
    }));
    const payload = mocks.updateAgent.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('metadata');
  });

  it('saves edited MCP servers and clears them when the last one is removed', async () => {
    const agent = makeAgent({
      mcpServers: [
        { name: 'granola', url: 'https://mcp.granola.ai/mcp', auth: { type: 'oauth' }, tools: ['list_*'] },
      ],
    });
    act(() => root.render(<AgentFormModal open agent={agent} onClose={vi.fn()} />));
    await flushEffects();

    expect(document.querySelectorAll('[data-testid="mcp-server-row"]')).toHaveLength(1);
    const save = () => [...document.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Save Changes')) as HTMLButtonElement;
    await act(async () => {
      save().click();
      await Promise.resolve();
    });
    expect(mocks.updateAgent).toHaveBeenLastCalledWith('agent-1', expect.objectContaining({
      mcpServers: [{ name: 'granola', url: 'https://mcp.granola.ai/mcp', auth: { type: 'oauth' }, tools: ['list_*'] }],
    }));

    act(() => (document.querySelector('[aria-label="Remove MCP server granola"]') as HTMLButtonElement).click());
    await act(async () => {
      save().click();
      await Promise.resolve();
    });
    expect(mocks.updateAgent).toHaveBeenLastCalledWith('agent-1', expect.objectContaining({ mcpServers: null }));
  });

  it('uses a viewport-scale editing workbench', async () => {
    act(() => root.render(
      <AgentFormModal open agent={makeAgent()} onClose={vi.fn()} />,
    ));
    await flushEffects();

    const dialog = document.querySelector('[role="dialog"][aria-label="Edit Agent"]') as HTMLElement;
    expect(dialog.className).toContain('max-w-6xl');
    expect(dialog.className).toContain('h-[min(92vh,56rem)]');
  });

  it('preserves prompt and description bytes and does not rewrite unedited metadata', async () => {
    const agent = makeAgent({
      systemPrompt: '  preserve leading space\nkeep trailing space  ',
      description: '  exact description  ',
      metadata: { owner: 'accounting' },
    });
    act(() => root.render(
      <AgentFormModal open agent={agent} onClose={vi.fn()} />,
    ));
    await flushEffects();

    const save = [...document.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Save Changes')) as HTMLButtonElement;
    await act(async () => {
      save.click();
      await Promise.resolve();
    });

    const payload = mocks.updateAgent.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload.systemPrompt).toBe('  preserve leading space\nkeep trailing space  ');
    expect(payload.description).toBe('  exact description  ');
    expect(payload).not.toHaveProperty('metadata');
  });

  it('keeps the editor open and shows the exact backend contract error', async () => {
    mocks.updateAgent.mockRejectedValueOnce(
      new Error('API PATCH /api/agents/agent-1 failed: 400 - harnessConfig.model is required'),
    );
    act(() => root.render(
      <AgentFormModal open agent={makeAgent()} onClose={vi.fn()} />,
    ));
    await flushEffects();

    const save = [...document.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Save Changes')) as HTMLButtonElement;
    await act(async () => {
      save.click();
      await Promise.resolve();
    });
    await flushEffects();

    expect(document.querySelector('[role="alert"]')?.textContent)
      .toContain('harnessConfig.model is required');
    expect(document.querySelector('[role="dialog"][aria-label="Edit Agent"]')).not.toBeNull();
  });

  it('rejects legacy harness config with canonical local schema details', async () => {
    act(() => root.render(
      <AgentFormModal open agent={makeAgent()} onClose={vi.fn()} />,
    ));
    await flushEffects();

    const config = document.querySelector<HTMLTextAreaElement>('#agent-harness-config');
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )?.set;
    act(() => {
      valueSetter?.call(config, '{}');
      config?.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const save = [...document.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Save Changes')) as HTMLButtonElement;
    await act(async () => {
      save.click();
      await Promise.resolve();
    });

    expect(mocks.updateAgent).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('model');
  });

  it('edits manifest-backed agents through canonical YAML', async () => {
    const manifest = {
      apiVersion: 'stablehand.io/v1',
      kind: 'Agent',
      metadata: { name: 'manifest-agent', description: 'From YAML' },
      spec: {
        harness: 'langgraph',
        harnessConfig: { provider: 'openai', model: 'gpt-5.4-mini' },
        instructions: 'Preserve this exact prompt.',
        tools: [{ ref: 'calculator' }],
        mode: 'both',
      },
    };
    act(() => root.render(
      <AgentFormModal
        open
        agent={makeAgent({
          name: 'manifest-agent',
          systemPrompt: 'Preserve this exact prompt.',
          description: 'From YAML',
          tools: ['calculator'],
          mode: 'both',
          manifest,
        })}
        onClose={vi.fn()}
      />,
    ));
    await flushEffects();

    const yamlEditor = document.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Agent manifest YAML"]',
    );
    expect(yamlEditor).not.toBeNull();
    expect(yamlEditor?.value).toContain('apiVersion: stablehand.io/v1');
    expect(yamlEditor?.className).toContain('min-h-[32rem]');

    const save = [...document.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Save Changes')) as HTMLButtonElement;
    await act(async () => {
      save.click();
      await Promise.resolve();
    });

    expect(mocks.updateAgent).toHaveBeenCalledWith('agent-1', expect.objectContaining({
      name: 'manifest-agent',
      systemPrompt: 'Preserve this exact prompt.',
      description: 'From YAML',
      tools: ['calculator'],
      mode: 'both',
      manifest,
    }));
  });

  it('preserves allow-list semantics when enabling another current builtin', async () => {
    act(() => root.render(
      <AgentFormModal
        open
        agent={makeAgent({ builtinToolPolicy: { policy: 'allow', names: ['emit-event'] } })}
        onClose={vi.fn()}
      />,
    ));
    await flushEffects();

    const requestApproval = [...document.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('request-approval')) as HTMLButtonElement;
    act(() => requestApproval.click());

    const save = [...document.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Save Changes')) as HTMLButtonElement;
    await act(async () => {
      save.click();
      await Promise.resolve();
    });

    expect(mocks.updateAgent).toHaveBeenCalledWith('agent-1', expect.objectContaining({
      builtinToolPolicy: { policy: 'allow', names: ['emit-event', 'request-approval'] },
    }));
  });
});

describe('AgentFormModal spend cap per run', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.fetchCatalogTools.mockResolvedValue([]);
    mocks.updateAgent.mockResolvedValue(undefined);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  function typeInto(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
    const prototype = element instanceof HTMLInputElement
      ? HTMLInputElement.prototype
      : HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    act(() => {
      setter?.call(element, value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  async function save(): Promise<void> {
    const button = [...document.querySelectorAll('button')]
      .find((candidate) => candidate.textContent?.includes('Save Changes')) as HTMLButtonElement;
    await act(async () => {
      button.click();
      await Promise.resolve();
    });
  }

  it('shows the cap stored in the harness config and saves an edit back into limits.maxCostUsd', async () => {
    act(() => root.render(
      <AgentFormModal
        open
        agent={makeAgent({
          harnessConfig: { provider: 'openai', model: 'gpt-5.4-mini', limits: { maxModelCalls: 40, maxCostUsd: 0.5 } },
        })}
        onClose={vi.fn()}
      />,
    ));
    await flushEffects();

    const field = document.querySelector<HTMLInputElement>('[data-testid="agent-spend-cap"]')!;
    expect(field.value).toBe('0.5');

    typeInto(field, '0.05');
    expect(JSON.parse(document.querySelector<HTMLTextAreaElement>('#agent-harness-config')!.value))
      .toEqual({ provider: 'openai', model: 'gpt-5.4-mini', limits: { maxModelCalls: 40, maxCostUsd: 0.05 } });

    await save();
    expect(mocks.updateAgent).toHaveBeenCalledWith('agent-1', expect.objectContaining({
      harnessConfig: { provider: 'openai', model: 'gpt-5.4-mini', limits: { maxModelCalls: 40, maxCostUsd: 0.05 } },
    }));
  });

  it('clears the cap without touching other limits', async () => {
    act(() => root.render(
      <AgentFormModal
        open
        agent={makeAgent({ harnessConfig: { provider: 'openai', model: 'gpt-5.4-mini', limits: { maxCostUsd: 2 } } })}
        onClose={vi.fn()}
      />,
    ));
    await flushEffects();

    typeInto(document.querySelector<HTMLInputElement>('[data-testid="agent-spend-cap"]')!, '');
    await save();

    expect(mocks.updateAgent).toHaveBeenCalledWith('agent-1', expect.objectContaining({
      harnessConfig: { provider: 'openai', model: 'gpt-5.4-mini' },
    }));
  });

  it('refuses a zero or negative cap', async () => {
    act(() => root.render(<AgentFormModal open agent={makeAgent()} onClose={vi.fn()} />));
    await flushEffects();

    typeInto(document.querySelector<HTMLInputElement>('[data-testid="agent-spend-cap"]')!, '0');
    await save();

    expect(mocks.updateAgent).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Enter a dollar amount above zero');
  });
});
