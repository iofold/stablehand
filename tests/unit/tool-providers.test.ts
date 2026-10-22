import { describe, it, expect, beforeEach, vi } from 'vitest';
import { z } from 'zod';
import { LocalFunctionExecutor } from '../../packages/stablehand/src/tool/executor.js';
import { LocalToolProvider } from '../../packages/stablehand/src/tool/providers/local.js';
import { MCPToolProvider } from '../../packages/stablehand/src/tool/providers/mcp.js';
import type { ToolDefinition, ToolContext } from '@stablehand/sandbox-daemon';

const mockCtx: ToolContext = {
  agentId: 'test-agent',
  conversationId: 'test-conv',
  workspaceDir: '/tmp/test',
};

function createTool(name: string, description = 'A test tool'): ToolDefinition {
  return {
    name,
    description,
    input: z.object({ value: z.string() }),
    handler: async (input: { value: string }) => `echo:${input.value}`,
  };
}

// ---------- LocalToolProvider ----------

describe('LocalToolProvider', () => {
  let executor: LocalFunctionExecutor;
  let provider: LocalToolProvider;

  beforeEach(() => {
    executor = new LocalFunctionExecutor();
    provider = new LocalToolProvider(executor);
  });

  it('should have name "local"', () => {
    expect(provider.name).toBe('local');
  });

  it('should list tools from the underlying executor', async () => {
    executor.register(createTool('tool-a'));
    executor.register(createTool('tool-b'));

    const tools = await provider.listTools();
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['tool-a', 'tool-b']),
    );
  });

  it('should return empty array when no tools registered', async () => {
    const tools = await provider.listTools();
    expect(tools).toHaveLength(0);
  });

  it('should execute a tool by name', async () => {
    executor.register(createTool('my-tool'));

    const result = await provider.execute('my-tool', { value: 'hello' }, mockCtx);
    expect(result).toBe('echo:hello');
  });

  it('should throw when executing unknown tool', async () => {
    await expect(
      provider.execute('nonexistent', { value: 'x' }, mockCtx),
    ).rejects.toThrow(/unknown tool/i);
  });

  it('should throw when handler errors', async () => {
    executor.register({
      name: 'failing-tool',
      description: 'Fails',
      input: z.object({ value: z.string() }),
      handler: async () => {
        throw new Error('Boom');
      },
    });

    await expect(
      provider.execute('failing-tool', { value: 'x' }, mockCtx),
    ).rejects.toThrow('Boom');
  });
});

// ---------- MCPToolProvider ----------

describe('MCPToolProvider', () => {
  it('should have a configurable name', () => {
    const provider = new MCPToolProvider(
      { type: 'stdio', command: 'echo' },
      'my-mcp-server',
    );
    expect(provider.name).toBe('my-mcp-server');
  });

  it('should default name based on transport type', () => {
    const stdioProvider = new MCPToolProvider({
      type: 'stdio',
      command: 'node',
      args: ['server.js'],
    });
    expect(stdioProvider.name).toBe('mcp-stdio');

    const httpProvider = new MCPToolProvider({
      type: 'http',
      url: 'http://localhost:3000',
    });
    expect(httpProvider.name).toBe('mcp-http');
  });

  it('should convert MCP tools to ToolDefinition format', async () => {
    // Mock the MCP client
    const provider = new MCPToolProvider(
      { type: 'stdio', command: 'echo' },
      'test-mcp',
    );

    // Mock connect and client
    const mockClient = {
      listTools: vi.fn().mockResolvedValue({
        tools: [
          {
            name: 'search',
            description: 'Search for items',
            inputSchema: {
              type: 'object',
              properties: {
                query: { type: 'string', description: 'Search query' },
                limit: { type: 'number', description: 'Max results' },
              },
              required: ['query'],
            },
          },
          {
            name: 'ping',
            description: 'Ping the server',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      }),
      callTool: vi.fn(),
      close: vi.fn(),
    };

    Reflect.set(provider, 'client', mockClient);

    const tools = await provider.listTools();
    expect(tools).toHaveLength(2);

    const searchTool = tools.find((t) => t.name === 'search')!;
    expect(searchTool).toBeDefined();
    expect(searchTool.description).toBe('Search for items');

    // Verify the Zod schema accepts valid input
    const parseResult = searchTool.input.safeParse({ query: 'test' });
    expect(parseResult.success).toBe(true);

    // Verify caching (second call should not call listTools again)
    const tools2 = await provider.listTools();
    expect(tools2).toBe(tools);
    expect(mockClient.listTools).toHaveBeenCalledTimes(1);
  });

  it('should execute MCP tools and return text content', async () => {
    const provider = new MCPToolProvider(
      { type: 'stdio', command: 'echo' },
      'test-mcp',
    );

    const mockClient = {
      callTool: vi.fn().mockResolvedValue({
        content: [
          { type: 'text', text: 'Hello' },
          { type: 'text', text: 'World' },
        ],
      }),
      close: vi.fn(),
    };

    Reflect.set(provider, 'client', mockClient);

    const result = await provider.execute('my-tool', { key: 'val' }, mockCtx);
    expect(result).toBe('Hello\nWorld');
    expect(mockClient.callTool).toHaveBeenCalledWith({
      name: 'my-tool',
      arguments: { key: 'val' },
    });
  });

  it('should stringify non-text MCP results', async () => {
    const provider = new MCPToolProvider(
      { type: 'stdio', command: 'echo' },
      'test-mcp',
    );

    const mockClient = {
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: 'image', data: 'base64...' }],
      }),
      close: vi.fn(),
    };

    Reflect.set(provider, 'client', mockClient);

    const result = await provider.execute('img-tool', {}, mockCtx);
    expect(result).toContain('base64...');
  });
});
