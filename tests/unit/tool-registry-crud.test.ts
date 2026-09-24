import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { DefaultToolRegistry } from '../../packages/stablehand/src/tool/registry.js';
import type { ToolProvider } from '../../packages/stablehand/src/tool/provider.js';
import type { ToolDefinition } from '@stablehand/sandbox-daemon';

function createToolDefinition(
  name: string,
  description = `Tool ${name}`,
): ToolDefinition {
  return {
    name,
    description,
    input: z.object({}),
    handler: async () => 'ok',
  };
}

function createMockProvider(
  name: string,
  tools: ToolDefinition[],
): ToolProvider {
  return {
    name,
    listTools: vi.fn().mockResolvedValue(tools),
    execute: vi.fn().mockResolvedValue({ ok: true }),
  };
}

describe('DefaultToolRegistry CRUD operations and cache lifecycle', () => {
  let registry: DefaultToolRegistry;

  beforeEach(() => {
    registry = new DefaultToolRegistry();
  });

  it('should remove provider tools from the cache after refresh', async () => {
    const removableProvider = createMockProvider('removable', [
      createToolDefinition('tool-a'),
    ]);

    registry.addProvider(removableProvider);
    await registry.refresh();

    expect(registry.getTool('tool-a')).toBeDefined();

    registry.removeProvider('removable');

    expect(registry.getTool('tool-a')).toBeUndefined();
    expect(registry.getProvider('tool-a')).toBeUndefined();
    expect(registry.listAll()).toEqual([]);
  });

  it('should make tools available again after removing and re-registering a provider', async () => {
    const provider = createMockProvider('re-registerable', [
      createToolDefinition('tool-a'),
    ]);

    registry.addProvider(provider);
    await registry.refresh();

    registry.removeProvider('re-registerable');
    expect(registry.getTool('tool-a')).toBeUndefined();

    registry.addProvider(provider);
    await registry.refresh();

    expect(registry.getTool('tool-a')).toBeDefined();
    expect(registry.getProvider('tool-a')).toBe(provider);
  });

  it('should return swapped provider tools from listForAgent after refresh', async () => {
    const firstProvider = createMockProvider('swappable', [
      createToolDefinition('tool-a'),
      createToolDefinition('tool-b'),
    ]);
    const secondProvider = createMockProvider('swappable', [
      createToolDefinition('tool-c'),
    ]);

    registry.addProvider(firstProvider);
    await registry.refresh();

    expect(registry.listForAgent(['tool-a', 'tool-b'])).toHaveLength(2);

    registry.removeProvider('swappable');
    registry.addProvider(secondProvider);
    await registry.refresh();

    const agentTools = registry.listForAgent(['tool-a', 'tool-b', 'tool-c']);

    expect(agentTools.map((tool) => tool.name)).toEqual(['tool-c']);
  });

  it('should mark the registry dirty after add and remove operations', async () => {
    await registry.refresh();
    expect(registry.needsRefresh).toBe(false);

    const provider = createMockProvider('dirty-provider', [
      createToolDefinition('tool-a'),
    ]);

    registry.addProvider(provider);
    expect(registry.needsRefresh).toBe(true);

    await registry.refresh();
    expect(registry.needsRefresh).toBe(false);

    registry.removeProvider('dirty-provider');
    expect(registry.needsRefresh).toBe(true);
  });

  it('should return undefined from getTool after its provider is removed', async () => {
    const provider = createMockProvider('removable', [
      createToolDefinition('tool-a'),
    ]);

    registry.addProvider(provider);
    await registry.refresh();

    expect(registry.getTool('tool-a')).toBeDefined();

    registry.removeProvider('removable');

    expect(registry.getTool('tool-a')).toBeUndefined();
  });

  it('should transition needsRefresh through clean and dirty states', async () => {
    expect(registry.needsRefresh).toBe(true);

    await registry.refresh();
    expect(registry.needsRefresh).toBe(false);

    registry.addProvider(createMockProvider('provider-a', [
      createToolDefinition('tool-a'),
    ]));
    expect(registry.needsRefresh).toBe(true);

    await registry.refresh();
    expect(registry.needsRefresh).toBe(false);

    registry.removeProvider('provider-a');
    expect(registry.needsRefresh).toBe(true);

    await registry.refresh();
    expect(registry.needsRefresh).toBe(false);
  });

  it('should keep a consistent cache when refresh is called concurrently', async () => {
    const providerA = createMockProvider('provider-a', [
      createToolDefinition('tool-a'),
    ]);
    const providerB = createMockProvider('provider-b', [
      createToolDefinition('tool-b'),
    ]);

    registry.addProvider(providerA);
    registry.addProvider(providerB);

    await Promise.all([
      registry.refresh(),
      registry.refresh(),
      registry.refresh(),
    ]);

    expect(registry.needsRefresh).toBe(false);
    expect(registry.listAll().map((tool) => tool.name).sort()).toEqual([
      'tool-a',
      'tool-b',
    ]);
    expect(providerA.listTools).toHaveBeenCalledTimes(3);
    expect(providerB.listTools).toHaveBeenCalledTimes(3);
  });

  it('should return no tool definitions for an empty registry', () => {
    expect(registry.listAll()).toEqual([]);
    expect(registry.listForAgent(['emit-event'])).toEqual([]);
    expect(registry.getTool('emit-event')).toBeUndefined();
    expect(registry.getProvider('emit-event')).toBeUndefined();
  });

  it('should keep the first unscoped provider when tool names overlap', async () => {
    const firstProvider = createMockProvider('provider-a', [
      createToolDefinition('shared-tool', 'from provider a'),
    ]);
    const secondProvider = createMockProvider('provider-b', [
      createToolDefinition('shared-tool', 'from provider b'),
    ]);

    registry.addProvider(firstProvider);
    registry.addProvider(secondProvider);
    await registry.refresh();

    expect(registry.listAll()).toHaveLength(1);
    expect(registry.getTool('shared-tool')?.description).toBe('from provider a');
    expect(registry.getProvider('shared-tool')).toBe(firstProvider);
  });

  it('should return tools from all providers in listAll', async () => {
    registry.addProvider(createMockProvider('provider-a', [
      createToolDefinition('tool-a'),
      createToolDefinition('tool-b'),
    ]));
    registry.addProvider(createMockProvider('provider-b', [
      createToolDefinition('tool-c'),
    ]));

    await registry.refresh();

    expect(registry.listAll().map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['tool-a', 'tool-b', 'tool-c']),
    );
    expect(registry.listAll()).toHaveLength(3);
  });

  it('should return undefined from getProvider after a provider is removed', async () => {
    const provider = createMockProvider('provider-a', [
      createToolDefinition('tool-a'),
    ]);

    registry.addProvider(provider);
    await registry.refresh();

    expect(registry.getProvider('tool-a')).toBe(provider);

    registry.removeProvider('provider-a');

    expect(registry.getProvider('tool-a')).toBeUndefined();
  });

  it('should include emit-event in listForAgent when a provider exposes it', async () => {
    registry.addProvider(createMockProvider('provider-a', [
      createToolDefinition('emit-event'),
      createToolDefinition('tool-a'),
    ]));

    await registry.refresh();

    expect(registry.listForAgent(['tool-a']).map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['emit-event', 'tool-a']),
    );
  });
});
