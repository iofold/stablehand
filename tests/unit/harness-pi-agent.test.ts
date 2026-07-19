import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const mockCreateAgentSession = vi.fn();
const mockSessionManagerInMemory = vi.fn(() => ({ type: 'session-manager' }));
const mockSessionManagerCreate = vi.fn((cwd: string) => ({ type: 'session-manager-file', cwd }));
const mockSessionManagerContinueRecent = vi.fn((cwd: string) => ({ type: 'session-manager-continue', cwd }));
const mockAuthStorageInMemory = vi.fn(() => ({ setRuntimeApiKey: vi.fn() }));
const mockCreateCodingTools = vi.fn((cwd: string) => [{ name: 'coding-tools', cwd }]);
const mockCreateReadTool = vi.fn((cwd: string) => ({ name: 'read', cwd }));
const mockCreateBashTool = vi.fn((cwd: string) => ({ name: 'bash', cwd }));
const mockCreateEditTool = vi.fn((cwd: string) => ({ name: 'edit', cwd }));
const mockCreateWriteTool = vi.fn((cwd: string) => ({ name: 'write', cwd }));
const mockCreateGrepTool = vi.fn((cwd: string) => ({ name: 'grep', cwd }));
const mockCreateFindTool = vi.fn((cwd: string) => ({ name: 'find', cwd }));
const mockCreateLsTool = vi.fn((cwd: string) => ({ name: 'ls', cwd }));

vi.mock('@mariozechner/pi-coding-agent', () => ({
  createAgentSession: mockCreateAgentSession,
  SessionManager: {
    inMemory: mockSessionManagerInMemory,
    create: mockSessionManagerCreate,
    continueRecent: mockSessionManagerContinueRecent,
  },
  DefaultResourceLoader: vi.fn(function MockDefaultResourceLoader() {
    return {
      reload: vi.fn(async () => undefined),
    };
  }),
  SettingsManager: { inMemory: vi.fn(() => ({ type: 'settings-manager' })) },
  AuthStorage: { inMemory: mockAuthStorageInMemory },
  ModelRegistry: vi.fn(function MockModelRegistry() {
    return { type: 'model-registry' };
  }),
  createCodingTools: mockCreateCodingTools,
  createReadTool: mockCreateReadTool,
  createBashTool: mockCreateBashTool,
  createEditTool: mockCreateEditTool,
  createWriteTool: mockCreateWriteTool,
  createGrepTool: mockCreateGrepTool,
  createFindTool: mockCreateFindTool,
  createLsTool: mockCreateLsTool,
}));

vi.mock('@mariozechner/pi-ai', async () => {
  const { Type } = await import('@sinclair/typebox');
  return {
    Type,
    getModel: vi.fn((provider: string, model: string) => ({ provider, id: model })),
  };
});

import { Type } from '@sinclair/typebox';
import { PIAgentHarness, convertTools, zodToTypeBox, _piMapAgentEvent } from '../../packages/sandbox-daemon/src/index.ts';
import type {
  AgentEvent,
  AgentHarness,
  HarnessSessionConfig,
  TokenUsage,
} from '../../packages/sandbox-daemon/src/index.ts';
import type { ToolDefinition } from '../../packages/sandbox-daemon/src/index.ts';
import type { Message } from '../../packages/sandbox-daemon/src/index.ts';

function makeMessage(
  role: Message['role'],
  content: string,
): Message {
  return {
    id: `${role}-${content}`,
    agentId: 'agent-1',
    role,
    content,
    createdAt: new Date(),
  };
}

function makeConfig(overrides: Partial<HarnessSessionConfig> = {}): HarnessSessionConfig {
  return {
    systemPrompt: 'Test',
    tools: [],
    secrets: { openai: 'test-key' },
    agentId: 'test-agent',
    conversationId: 'test-conv',
    workspaceDir: '/tmp/workspace',
    harnessConfigJson: JSON.stringify({ provider: 'openai', model: 'gpt-4o-mini', apiKeyRef: 'openai' }),
    ...overrides,
  };
}

async function collectEvents(stream: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

type NativeToolBuilder = (
  config: HarnessSessionConfig,
  factories: {
    createReadTool: (cwd: string) => unknown;
    createBashTool: (cwd: string) => unknown;
    createEditTool: (cwd: string) => unknown;
    createWriteTool: (cwd: string) => unknown;
    createGrepTool: (cwd: string) => unknown;
    createFindTool: (cwd: string) => unknown;
    createLsTool: (cwd: string) => unknown;
    createCodingTools: (cwd: string) => unknown[];
  },
) => unknown[];

function getBuildNativeTools(harness: PIAgentHarness): NativeToolBuilder {
  return Reflect.get(harness, 'buildNativeTools') as NativeToolBuilder;
}

describe('PIAgentHarness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should have name "pi-agent"', () => {
    const harness = new PIAgentHarness();
    expect(harness.name).toBe('pi-agent');
  });

  it('should implement the AgentHarness interface', () => {
    const harness = new PIAgentHarness();
    const asInterface: AgentHarness = harness;
    expect(asInterface.name).toBe('pi-agent');
    expect(typeof asInterface.openSession).toBe('function');
  });

  it('throws ZodError when legacy modelConfig is passed without harnessConfigJson', async () => {
    const harness = new PIAgentHarness();
    const legacyConfig = {
      ...makeConfig(),
      modelConfig: { provider: 'openai', model: 'gpt-4o-mini', apiKeyRef: 'openai' },
    };
    Reflect.deleteProperty(legacyConfig, 'harnessConfigJson');

    await expect(
      Reflect.apply(harness.openSession.bind(harness), harness, [legacyConfig]),
    ).rejects.toThrowError(z.ZodError);
  });

  it('throws ZodError when harnessConfigJson does not satisfy PIAgentConfigSchema', async () => {
    const harness = new PIAgentHarness();

    await expect(
      harness.openSession(makeConfig({ harnessConfigJson: JSON.stringify({ provider: 'openai' }) })),
    ).rejects.toThrowError(z.ZodError);
  });
});

describe('zodToTypeBox', () => {
  it('should convert a simple Zod object with string fields', () => {
    const result = zodToTypeBox(Type, z.object({ city: z.string(), country: z.string() }));

    expect(result.type).toBe('object');
    expect(result.properties.city.type).toBe('string');
    expect(result.properties.country.type).toBe('string');
  });

  it('should convert number fields', () => {
    const result = zodToTypeBox(Type, z.object({ count: z.number() }));
    expect(result.properties.count.type).toBe('number');
  });

  it('should convert boolean fields', () => {
    const result = zodToTypeBox(Type, z.object({ active: z.boolean() }));
    expect(result.properties.active.type).toBe('boolean');
  });

  it('should handle optional fields', () => {
    const result = zodToTypeBox(Type, z.object({ required: z.string(), optional: z.string().optional() }));
    expect(result.properties.required).toBeDefined();
    expect(result.properties.optional).toBeDefined();
  });

  it('should handle enum fields', () => {
    const result = zodToTypeBox(Type, z.object({ priority: z.enum(['low', 'medium', 'high']) }));
    expect(result.properties.priority.anyOf ?? result.properties.priority.oneOf).toBeDefined();
  });

  it('should handle array fields', () => {
    const result = zodToTypeBox(Type, z.object({ tags: z.array(z.string()) }));
    expect(result.properties.tags.type).toBe('array');
  });

  it('should handle nested object fields', () => {
    const result = zodToTypeBox(Type, z.object({ address: z.object({ street: z.string(), zip: z.number() }) }));
    expect(result.properties.address.type).toBe('object');
    expect(result.properties.address.properties.street.type).toBe('string');
    expect(result.properties.address.properties.zip.type).toBe('number');
  });

  it('should handle empty object schema', () => {
    const result = zodToTypeBox(Type, z.object({}));
    expect(result.type).toBe('object');
  });

  it('should fall back to string for unknown Zod types', () => {
    const result = zodToTypeBox(Type, z.object({ data: z.any() }));
    expect(result.properties.data.type).toBe('string');
  });
});

describe('convertTools', () => {
  it('should convert ToolDefinition[] to PI AgentTool[] format', () => {
    const toolDefs: ToolDefinition[] = [
      {
        name: 'get-weather',
        description: 'Get the current weather for a city',
        input: z.object({ city: z.string() }),
        handler: async (input) => JSON.stringify(input),
      },
    ];

    const converted = convertTools(Type, toolDefs, makeConfig({ tools: toolDefs }));

    expect(converted).toHaveLength(1);
    expect(converted[0].name).toBe('get-weather');
    expect(converted[0].label).toBe('get-weather');
    expect(converted[0].description).toBe('Get the current weather for a city');
    expect(converted[0].parameters).toBeDefined();
    expect(typeof converted[0].execute).toBe('function');
  });

  it('should wire execute to call the tool handler with full tool context', async () => {
    const handler = vi.fn().mockResolvedValue('result-42');
    const toolDefs: ToolDefinition[] = [
      {
        name: 'my-tool',
        description: 'Test',
        input: z.object({ val: z.string() }),
        handler,
      },
    ];

    const converted = convertTools(Type, toolDefs, makeConfig({ tools: toolDefs }));
    const result = await converted[0].execute('call-1', { val: 'hello' });

    expect(result).toEqual({
      content: [{ type: 'text', text: 'result-42' }],
      details: {},
    });
    expect(handler).toHaveBeenCalledWith(
      { val: 'hello' },
      expect.objectContaining({
        agentId: 'test-agent',
        conversationId: 'test-conv',
        workspaceDir: '/tmp/workspace',
        eventBus: undefined,
      }),
    );
  });

  it('should execute approval-gated tools when approval is granted', async () => {
    const onApprovalNeeded = vi.fn().mockResolvedValue({ action: 'approve' as const });
    const handler = vi.fn().mockResolvedValue('approved-result');
    const toolDefs: ToolDefinition[] = [
      {
        name: 'dangerous-tool',
        description: 'Needs approval',
        input: z.object({}),
        requiresApproval: true,
        handler,
      },
    ];

    const converted = convertTools(Type, toolDefs, makeConfig({ tools: toolDefs, onApprovalNeeded }));
    const result = await converted[0].execute('call-1', {});

    expect(onApprovalNeeded).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledOnce();
    expect(result.content[0].text).toBe('approved-result');
  });

  it('should return rejection message when approval is rejected', async () => {
    const onApprovalNeeded = vi.fn().mockResolvedValue({ action: 'reject' as const });
    const handler = vi.fn().mockResolvedValue('should-not-run');
    const toolDefs: ToolDefinition[] = [
      {
        name: 'dangerous-tool',
        description: 'Needs approval',
        input: z.object({}),
        requiresApproval: true,
        handler,
      },
    ];

    const converted = convertTools(Type, toolDefs, makeConfig({ tools: toolDefs, onApprovalNeeded }));
    const result = await converted[0].execute('call-1', {});

    expect(onApprovalNeeded).toHaveBeenCalledOnce();
    expect(handler).not.toHaveBeenCalled();
    expect(result.content[0].text).toBe('Tool call was rejected by the user.');
  });

  it('should auto-execute when no approval callback is provided', async () => {
    const handler = vi.fn().mockResolvedValue('auto-approved');
    const toolDefs: ToolDefinition[] = [
      {
        name: 'approval-tool',
        description: 'Needs approval',
        input: z.object({}),
        requiresApproval: true,
        handler,
      },
    ];

    const converted = convertTools(Type, toolDefs, makeConfig({ tools: toolDefs }));
    const result = await converted[0].execute('call-1', {});

    expect(handler).toHaveBeenCalledOnce();
    expect(result.content[0].text).toBe('auto-approved');
  });
});

describe('PIAgentHarness private helpers', () => {
  it('should map PI events to ctxmill events', () => {
    expect(_piMapAgentEvent({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'Hello world' },
    }, undefined)).toEqual({ type: 'text_delta', content: 'Hello world' });

    expect(_piMapAgentEvent({
      type: 'tool_execution_start',
      toolCallId: 'call-123',
      toolName: 'get-weather',
      args: { city: 'NYC' },
    }, undefined)).toEqual({
      type: 'tool_call_start',
      id: 'call-123',
      name: 'get-weather',
      args: { city: 'NYC' },
    });

    expect(_piMapAgentEvent({
      type: 'tool_execution_end',
      toolCallId: 'call-123',
      result: { content: [{ type: 'text', text: '72F and sunny' }] },
      isError: false,
    }, undefined)).toEqual({
      type: 'tool_call_end',
      id: 'call-123',
      result: '72F and sunny',
      error: undefined,
      durationMs: 0,
    });
  });

  it('should map agent_end to done with accumulated usage', () => {
    const usage: TokenUsage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

    expect(_piMapAgentEvent({ type: 'agent_end', messages: [] }, usage)).toEqual({
      type: 'done',
      usage,
    });
  });

  it('should build native tools from allowlist and apply blocklist', () => {
    const harness = new PIAgentHarness();
    const buildNativeTools = getBuildNativeTools(harness);
    const factories = {
      createReadTool: vi.fn((cwd: string) => ({ name: 'read', cwd })),
      createBashTool: vi.fn((cwd: string) => ({ name: 'bash', cwd })),
      createEditTool: vi.fn((cwd: string) => ({ name: 'edit', cwd })),
      createWriteTool: vi.fn((cwd: string) => ({ name: 'write', cwd })),
      createGrepTool: vi.fn((cwd: string) => ({ name: 'grep', cwd })),
      createFindTool: vi.fn((cwd: string) => ({ name: 'find', cwd })),
      createLsTool: vi.fn((cwd: string) => ({ name: 'ls', cwd })),
      createCodingTools: vi.fn((cwd: string) => [{ name: 'coding-tools', cwd }]),
    };

    const tools = buildNativeTools(makeConfig({
      nativeTools: {
        allowlist: ['read', 'bash', 'edit'],
        blocklist: ['bash'],
      },
    }), factories) as Array<{ name: string }>;

    expect(tools).toEqual([
      { name: 'read', cwd: '/tmp/workspace' },
      { name: 'edit', cwd: '/tmp/workspace' },
    ]);
  });

  it('should use full coding tool set when nativeTools is undefined', () => {
    const harness = new PIAgentHarness();
    const buildNativeTools = getBuildNativeTools(harness);
    const factories = {
      createReadTool: vi.fn(),
      createBashTool: vi.fn(),
      createEditTool: vi.fn(),
      createWriteTool: vi.fn(),
      createGrepTool: vi.fn(),
      createFindTool: vi.fn(),
      createLsTool: vi.fn(),
      createCodingTools: vi.fn((cwd: string) => [{ name: 'coding-tools', cwd }]),
    };

    const tools = buildNativeTools(makeConfig(), factories);

    expect(tools).toEqual([{ name: 'coding-tools', cwd: '/tmp/workspace' }]);
    expect(factories.createCodingTools).toHaveBeenCalledWith('/tmp/workspace');
  });
});

describe('PIAgentHarness native tool flow', () => {
  it('openSession without restore uses SessionManager.create', async () => {
    vi.resetModules();
    mockCreateAgentSession.mockImplementation(async (options: unknown) => {
      expect(options).toMatchObject({
        sessionManager: {
          type: 'session-manager-file',
          cwd: '/tmp/workspace',
        },
      });
      return {
        session: {
          subscribe: vi.fn(() => () => undefined),
          prompt: vi.fn(async () => undefined),
          abort: vi.fn(async () => undefined),
          dispose: vi.fn(),
          agent: {
            replaceMessages: vi.fn(),
            getMessages: vi.fn(() => []),
          },
        },
      };
    });

    const { PIAgentHarness: FreshPIAgentHarness } = await import('../../packages/sandbox-daemon/src/harness/pi-agent.ts');
    const harness = new FreshPIAgentHarness();
    const session = await harness.openSession(makeConfig());

    await session.close();
  });

  it('openSession with restore uses SessionManager.continueRecent', async () => {
    vi.resetModules();
    mockCreateAgentSession.mockImplementation(async (options: unknown) => {
      expect(options).toMatchObject({
        sessionManager: {
          type: 'session-manager-continue',
          cwd: '/tmp/workspace',
        },
      });
      return {
        session: {
          subscribe: vi.fn(() => () => undefined),
          prompt: vi.fn(async () => undefined),
          abort: vi.fn(async () => undefined),
          dispose: vi.fn(),
          agent: {
            replaceMessages: vi.fn(),
            getMessages: vi.fn(() => []),
          },
        },
      };
    });

    const { PIAgentHarness: FreshPIAgentHarness } = await import('../../packages/sandbox-daemon/src/harness/pi-agent.ts');
    const harness = new FreshPIAgentHarness();
    const session = await harness.openSession(makeConfig(), {
      stateVersion: '1',
      messages: [],
      payload: { transcript: [] },
    });

    await session.close();
  });

  it('openSession with restore populates transcript from payload.transcript', async () => {
    const replaceMessages = vi.fn();
    mockCreateAgentSession.mockResolvedValue({
      session: {
        subscribe: (listener: (event: Record<string, unknown>) => void) => {
          listener({ type: 'agent_end', messages: [] });
          return () => undefined;
        },
        prompt: vi.fn(async () => undefined),
        abort: vi.fn(async () => undefined),
        dispose: vi.fn(),
        agent: {
          replaceMessages,
          getMessages: vi.fn(() => []),
        },
      },
    });

    const harness = new PIAgentHarness();
    const restoredMessage = makeMessage('assistant', 'Restored reply');
    const userMessage = makeMessage('user', 'Hello');
    const session = await harness.openSession(makeConfig(), {
      stateVersion: '1',
      messages: [],
      payload: { transcript: [restoredMessage] },
    });

    await collectEvents(
      session.deliverTurn(
        { messages: [restoredMessage, userMessage], turnId: 'turn-restore' },
        {},
      ),
    );

    await expect(session.exportState()).resolves.toEqual({
      stateVersion: '2',
      payload: {
        transcript: [restoredMessage, userMessage],
        nativePersistence: true,
      },
    });
    expect(replaceMessages).not.toHaveBeenCalled();

    await session.close();
  });

  it('exportState includes nativePersistence flag and stateVersion 2', async () => {
    mockCreateAgentSession.mockResolvedValue({
      session: {
        subscribe: vi.fn(() => () => undefined),
        prompt: vi.fn(async () => undefined),
        abort: vi.fn(async () => undefined),
        dispose: vi.fn(),
        agent: {
          replaceMessages: vi.fn(),
          getMessages: vi.fn(() => []),
        },
      },
    });

    const harness = new PIAgentHarness();
    const session = await harness.openSession(makeConfig());

    await expect(session.exportState()).resolves.toEqual({
      stateVersion: '2',
      payload: {
        transcript: [],
        nativePersistence: true,
      },
    });

    await session.close();
  });

  it('should merge ctxmill tools with filtered native tools for session creation inputs', () => {
    const harness = new PIAgentHarness();
    const customTool: ToolDefinition = {
      name: 'ctx-tool',
      description: 'Ctx tool',
      input: z.object({ value: z.string() }),
      handler: async () => 'ok',
    };

    const nativeTools = getBuildNativeTools(harness)(makeConfig({
      nativeTools: {
        allowlist: ['read', 'bash'],
        blocklist: ['bash'],
      },
    }), {
      createReadTool: mockCreateReadTool,
      createBashTool: mockCreateBashTool,
      createEditTool: mockCreateEditTool,
      createWriteTool: mockCreateWriteTool,
      createGrepTool: mockCreateGrepTool,
      createFindTool: mockCreateFindTool,
      createLsTool: mockCreateLsTool,
      createCodingTools: mockCreateCodingTools,
    }) as Array<{ name: string }>;
    const customTools = convertTools(Type, [customTool], makeConfig({ tools: [customTool] }));

    expect(nativeTools).toEqual([{ name: 'read', cwd: '/tmp/workspace' }]);
    expect(customTools).toEqual([
      expect.objectContaining({ name: 'ctx-tool' }),
    ]);
  });

  it('should surface completion events from deliverTurn()', async () => {
    mockCreateAgentSession.mockResolvedValue({
      session: {
        subscribe: (listener: (event: Record<string, unknown>) => void) => {
          listener({ type: 'agent_end', messages: [] });
          return () => undefined;
        },
        prompt: vi.fn(async () => undefined),
        abort: vi.fn(async () => undefined),
        dispose: vi.fn(),
        agent: {
          replaceMessages: vi.fn(),
          getMessages: vi.fn(() => []),
        },
      },
    });

    const harness = new PIAgentHarness();
    const session = await harness.openSession(makeConfig());
    const events = await collectEvents(
      session.deliverTurn(
        { messages: [makeMessage('user', 'Hello')], turnId: 'turn-1' },
        {},
      ),
    );

    await session.close();

    expect(events.length).toBeGreaterThan(0);
    expect(events[events.length - 1]?.type).toBe('done');
  });
});
