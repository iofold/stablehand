import { describe, it, expect, beforeEach, vi } from 'vitest';
import { z } from 'zod';
import { DefaultToolRegistry } from '../../packages/stablehand/src/tool/registry.js';
import type { ToolProvider } from '../../packages/stablehand/src/tool/provider.js';
import type { ToolDefinition } from '@stablehand/sandbox-daemon';

function createMockProvider(
  name: string,
  tools: ToolDefinition[],
): ToolProvider {
  return {
    name,
    listTools: vi.fn().mockResolvedValue(tools),
    execute: vi.fn().mockResolvedValue('ok'),
  };
}

function createToolDef(name: string, description = 'test'): ToolDefinition {
  return {
    name,
    description,
    input: z.object({}),
    handler: async () => 'result',
  };
}

describe('DefaultToolRegistry', () => {
  let registry: DefaultToolRegistry;

  beforeEach(() => {
    registry = new DefaultToolRegistry();
  });

  it('should start empty', () => {
    expect(registry.listAll()).toEqual([]);
  });

  it('should add a provider and list its tools after refresh', async () => {
    const provider = createMockProvider('local', [
      createToolDef('tool-a'),
      createToolDef('tool-b'),
    ]);

    registry.addProvider(provider);
    await registry.refresh();

    const tools = registry.listAll();
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['tool-a', 'tool-b']),
    );
  });

  it('should aggregate tools from multiple providers', async () => {
    const local = createMockProvider('local', [createToolDef('local-tool')]);
    const mcp = createMockProvider('mcp', [createToolDef('mcp-tool')]);

    registry.addProvider(local);
    registry.addProvider(mcp);
    await registry.refresh();

    const tools = registry.listAll();
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['local-tool', 'mcp-tool']),
    );
  });

  it('should resolve provider for a tool name', async () => {
    const local = createMockProvider('local', [createToolDef('tool-a')]);
    const mcp = createMockProvider('mcp', [createToolDef('tool-b')]);

    registry.addProvider(local);
    registry.addProvider(mcp);
    await registry.refresh();

    expect(registry.getProvider('tool-a')?.name).toBe('local');
    expect(registry.getProvider('tool-b')?.name).toBe('mcp');
    expect(registry.getProvider('nonexistent')).toBeUndefined();
  });

  it('should remove a provider and its tools', async () => {
    const local = createMockProvider('local', [createToolDef('tool-a')]);
    const mcp = createMockProvider('mcp', [createToolDef('tool-b')]);

    registry.addProvider(local);
    registry.addProvider(mcp);
    await registry.refresh();

    registry.removeProvider('mcp');

    const tools = registry.listAll();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('tool-a');
    expect(registry.getProvider('tool-b')).toBeUndefined();
  });

  it('should filter tools for an agent by declared names', async () => {
    const provider = createMockProvider('local', [
      createToolDef('tool-a'),
      createToolDef('tool-b'),
      createToolDef('tool-c'),
    ]);

    registry.addProvider(provider);
    await registry.refresh();

    const agentTools = registry.listForAgent(['tool-a', 'tool-c']);
    expect(agentTools).toHaveLength(2);
    expect(agentTools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['tool-a', 'tool-c']),
    );
  });

  it('should always include builtin tools for any agent', async () => {
    // The emit-event tool is a builtin
    const provider = createMockProvider('local', [
      createToolDef('tool-a'),
      createToolDef('emit-event'), // builtin name
    ]);

    registry.addProvider(provider);
    await registry.refresh();

    // Agent only declares tool-a, but emit-event should be included as builtin
    const agentTools = registry.listForAgent(['tool-a']);
    expect(agentTools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['tool-a', 'emit-event']),
    );
  });

  it('should keep duplicate tool names provider-scoped and resolve the unscoped tool deterministically', async () => {
    const provider1 = createMockProvider('provider-1', [
      createToolDef('shared-tool', 'from provider 1'),
    ]);
    const provider2 = createMockProvider('provider-2', [
      createToolDef('shared-tool', 'from provider 2'),
    ]);

    registry.addProvider(provider1);
    registry.addProvider(provider2);
    await registry.refresh();

    const tools = registry.listAll();
    expect(tools).toHaveLength(1);
    expect(tools[0].description).toBe('from provider 1');
    expect(registry.getProvider('shared-tool')?.name).toBe('provider-1');
  });

  it('resolves duplicate HTTP tool names by agent-scoped provider', async () => {
    const provider1 = createMockProvider('http-agent-1', [
      createToolDef('shared-tool', 'from agent 1'),
    ]);
    const provider2 = createMockProvider('http-agent-2', [
      createToolDef('shared-tool', 'from agent 2'),
    ]);

    registry.addProvider(provider1);
    registry.addProvider(provider2);
    await registry.refresh();

    expect(registry.getTool('shared-tool', 'agent-1')?.description).toBe('from agent 1');
    expect(registry.getProvider('shared-tool', 'agent-1')?.name).toBe('http-agent-1');
    expect(registry.getTool('shared-tool', 'agent-2')?.description).toBe('from agent 2');
    expect(registry.getProvider('shared-tool', 'agent-2')?.name).toBe('http-agent-2');
    expect(registry.listForAgent(['shared-tool'], 'agent-1').map((tool) => tool.description)).toEqual([
      'from agent 1',
    ]);
  });

  it('should track dirty state', async () => {
    expect(registry.needsRefresh).toBe(true);

    await registry.refresh();
    expect(registry.needsRefresh).toBe(false);

    registry.addProvider(createMockProvider('new', []));
    expect(registry.needsRefresh).toBe(true);
  });

  it('should get a specific tool by name', async () => {
    const provider = createMockProvider('local', [createToolDef('my-tool', 'My description')]);
    registry.addProvider(provider);
    await registry.refresh();

    const tool = registry.getTool('my-tool');
    expect(tool).toBeDefined();
    expect(tool!.description).toBe('My description');

    expect(registry.getTool('nonexistent')).toBeUndefined();
  });
});
