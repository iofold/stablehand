import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { PIAgentHarness, zodToTypeBox, convertTools } from '../../packages/ctxmill/src/harness/pi-agent.js';
import type { AgentHarness, HarnessRunConfig } from '../../packages/ctxmill/src/harness/types.js';
import type { ToolDefinition } from '../../packages/ctxmill/src/tool/types.js';

// Use @sinclair/typebox directly since @mariozechner/pi-ai re-exports it
// and it's available as a transitive dependency.
const { Type } = await import('@sinclair/typebox');

describe('PIAgentHarness', () => {
  it('should have name "pi-agent"', () => {
    const harness = new PIAgentHarness();
    expect(harness.name).toBe('pi-agent');
  });

  it('should implement the AgentHarness interface', () => {
    const harness = new PIAgentHarness();

    // Verify it satisfies the interface structurally
    const asInterface: AgentHarness = harness;
    expect(asInterface.name).toBe('pi-agent');
    expect(typeof asInterface.run).toBe('function');
  });
});

describe('zodToTypeBox', () => {
  it('should convert a simple Zod object with string fields', () => {
    const zodSchema = z.object({
      city: z.string(),
      country: z.string(),
    });

    const result = zodToTypeBox(Type, zodSchema);

    expect(result).toBeDefined();
    expect(result.type).toBe('object');
    expect(result.properties.city).toBeDefined();
    expect(result.properties.city.type).toBe('string');
    expect(result.properties.country).toBeDefined();
    expect(result.properties.country.type).toBe('string');
  });

  it('should convert number fields', () => {
    const zodSchema = z.object({
      count: z.number(),
    });

    const result = zodToTypeBox(Type, zodSchema);

    expect(result.properties.count).toBeDefined();
    expect(result.properties.count.type).toBe('number');
  });

  it('should convert boolean fields', () => {
    const zodSchema = z.object({
      active: z.boolean(),
    });

    const result = zodToTypeBox(Type, zodSchema);

    expect(result.properties.active).toBeDefined();
    expect(result.properties.active.type).toBe('boolean');
  });

  it('should handle optional fields', () => {
    const zodSchema = z.object({
      required: z.string(),
      optional: z.string().optional(),
    });

    const result = zodToTypeBox(Type, zodSchema);

    expect(result.properties.required).toBeDefined();
    expect(result.properties.optional).toBeDefined();
  });

  it('should handle enum fields', () => {
    const zodSchema = z.object({
      priority: z.enum(['low', 'medium', 'high']),
    });

    const result = zodToTypeBox(Type, zodSchema);

    expect(result.properties.priority).toBeDefined();
    // TypeBox represents enums as Union of Literals
    expect(result.properties.priority.anyOf ?? result.properties.priority.oneOf).toBeDefined();
  });

  it('should handle array fields', () => {
    const zodSchema = z.object({
      tags: z.array(z.string()),
    });

    const result = zodToTypeBox(Type, zodSchema);

    expect(result.properties.tags).toBeDefined();
    expect(result.properties.tags.type).toBe('array');
  });

  it('should handle nested object fields', () => {
    const zodSchema = z.object({
      address: z.object({
        street: z.string(),
        zip: z.number(),
      }),
    });

    const result = zodToTypeBox(Type, zodSchema);

    expect(result.properties.address).toBeDefined();
    expect(result.properties.address.type).toBe('object');
    expect(result.properties.address.properties.street.type).toBe('string');
    expect(result.properties.address.properties.zip.type).toBe('number');
  });

  it('should handle empty object schema', () => {
    const zodSchema = z.object({});
    const result = zodToTypeBox(Type, zodSchema);

    expect(result).toBeDefined();
    expect(result.type).toBe('object');
  });

  it('should fall back to string for unknown Zod types', () => {
    // z.any() and other exotic types should fall back to Type.String()
    const zodSchema = z.object({
      data: z.any(),
    });

    const result = zodToTypeBox(Type, zodSchema);

    expect(result.properties.data).toBeDefined();
    expect(result.properties.data.type).toBe('string');
  });
});

describe('convertTools', () => {
  function makeConfig(overrides?: Partial<HarnessRunConfig>): HarnessRunConfig {
    return {
      modelConfig: { provider: 'openai', model: 'gpt-4o-mini' },
      systemPrompt: 'Test',
      messages: [{ role: 'user', content: 'Hello' } as any],
      tools: [],
      secrets: {},
      agentId: 'test-agent',
      runId: 'test-run',
      conversationId: 'test-conv',
      workspaceDir: '/tmp',
      ...overrides,
    };
  }

  it('should convert ToolDefinition[] to PI AgentTool[] format', () => {
    const toolDefs: ToolDefinition[] = [
      {
        name: 'get-weather',
        description: 'Get the current weather for a city',
        input: z.object({
          city: z.string().describe('The city name'),
        }),
        handler: async (input: { city: string }) => {
          return JSON.stringify({ temp: 72, city: input.city });
        },
      },
    ];

    const config = makeConfig({ tools: toolDefs });
    const converted = convertTools(Type, toolDefs, config);

    expect(converted).toHaveLength(1);
    expect(converted[0].name).toBe('get-weather');
    expect(converted[0].label).toBe('get-weather');
    expect(converted[0].description).toBe('Get the current weather for a city');
    expect(converted[0].parameters).toBeDefined();
    expect(typeof converted[0].execute).toBe('function');
  });

  it('should convert multiple tools', () => {
    const toolDefs: ToolDefinition[] = [
      {
        name: 'tool-a',
        description: 'Tool A',
        input: z.object({}),
        handler: async () => 'a',
      },
      {
        name: 'tool-b',
        description: 'Tool B',
        input: z.object({ x: z.number() }),
        handler: async () => 'b',
      },
    ];

    const config = makeConfig({ tools: toolDefs });
    const converted = convertTools(Type, toolDefs, config);

    expect(converted).toHaveLength(2);
    expect(converted[0].name).toBe('tool-a');
    expect(converted[1].name).toBe('tool-b');
  });

  it('should handle empty tool list', () => {
    const config = makeConfig();
    const converted = convertTools(Type, [], config);
    expect(converted).toHaveLength(0);
  });

  it('should wire execute to call the tool handler', async () => {
    const handler = vi.fn().mockResolvedValue('result-42');
    const toolDefs: ToolDefinition[] = [
      {
        name: 'my-tool',
        description: 'Test',
        input: z.object({ val: z.string() }),
        handler,
      },
    ];

    const config = makeConfig({ tools: toolDefs });
    const converted = convertTools(Type, toolDefs, config);

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
        workspaceDir: '/tmp',
      }),
    );
  });

  it('should wire HITL approval for tools with requiresApproval', async () => {
    const onApproval = vi.fn().mockResolvedValue({ action: 'approve' });
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

    const config = makeConfig({
      tools: toolDefs,
      onApprovalNeeded: onApproval,
    });
    const converted = convertTools(Type, toolDefs, config);
    const result = await converted[0].execute('call-1', {});

    expect(onApproval).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledOnce();
    expect(result.content[0].text).toBe('approved-result');
  });

  it('should return rejection message when approval is rejected', async () => {
    const onApproval = vi.fn().mockResolvedValue({ action: 'reject' });
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

    const config = makeConfig({
      tools: toolDefs,
      onApprovalNeeded: onApproval,
    });
    const converted = convertTools(Type, toolDefs, config);
    const result = await converted[0].execute('call-1', {});

    expect(onApproval).toHaveBeenCalledOnce();
    expect(handler).not.toHaveBeenCalled();
    expect(result.content[0].text).toBe('Tool call was rejected by the user.');
  });

  it('should auto-execute when no onApprovalNeeded provided for approval tool', async () => {
    const handler = vi.fn().mockResolvedValue('auto-approved');
    const toolDefs: ToolDefinition[] = [
      {
        name: 'approval-tool',
        description: 'Needs approval but no callback',
        input: z.object({}),
        requiresApproval: true,
        handler,
      },
    ];

    // No onApprovalNeeded callback
    const config = makeConfig({ tools: toolDefs });
    const converted = convertTools(Type, toolDefs, config);
    const result = await converted[0].execute('call-1', {});

    // Should auto-execute since there's no approval callback
    expect(handler).toHaveBeenCalledOnce();
    expect(result.content[0].text).toBe('auto-approved');
  });
});

describe('PIAgentHarness.mapPIEvent', () => {
  const harness = new PIAgentHarness();

  it('should map text_delta from message_update events', () => {
    const piEvent = {
      type: 'message_update',
      message: {},
      assistantMessageEvent: {
        type: 'text_delta',
        delta: 'Hello world',
        contentIndex: 0,
        partial: {},
      },
    };

    const events = harness.mapPIEvent(piEvent);
    expect(events).toEqual([
      { type: 'text_delta', content: 'Hello world' },
    ]);
  });

  it('should ignore message_update events without text_delta', () => {
    const piEvent = {
      type: 'message_update',
      message: {},
      assistantMessageEvent: {
        type: 'toolcall_start',
        contentIndex: 0,
        partial: {},
      },
    };

    const events = harness.mapPIEvent(piEvent);
    expect(events).toHaveLength(0);
  });

  it('should map tool_execution_start to tool_call_start', () => {
    const piEvent = {
      type: 'tool_execution_start',
      toolCallId: 'call-123',
      toolName: 'get-weather',
      args: { city: 'NYC' },
    };

    const events = harness.mapPIEvent(piEvent);
    expect(events).toEqual([
      {
        type: 'tool_call_start',
        id: 'call-123',
        name: 'get-weather',
        args: { city: 'NYC' },
      },
    ]);
  });

  it('should map tool_execution_end to tool_call_end', () => {
    const piEvent = {
      type: 'tool_execution_end',
      toolCallId: 'call-123',
      toolName: 'get-weather',
      result: {
        content: [{ type: 'text', text: '72F and sunny' }],
        details: {},
      },
      isError: false,
    };

    const events = harness.mapPIEvent(piEvent);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('tool_call_end');
    expect((events[0] as any).id).toBe('call-123');
    expect((events[0] as any).result).toBe('72F and sunny');
    expect((events[0] as any).error).toBeUndefined();
  });

  it('should map tool_execution_end with error to tool_call_end with error', () => {
    const piEvent = {
      type: 'tool_execution_end',
      toolCallId: 'call-456',
      toolName: 'bash',
      result: {
        content: [{ type: 'text', text: 'Command failed' }],
        details: {},
      },
      isError: true,
    };

    const events = harness.mapPIEvent(piEvent);
    expect(events).toHaveLength(1);
    expect((events[0] as any).error).toBe('Command failed');
  });

  it('should ignore agent_start events', () => {
    const events = harness.mapPIEvent({ type: 'agent_start' });
    expect(events).toHaveLength(0);
  });

  it('should ignore agent_end events', () => {
    const events = harness.mapPIEvent({ type: 'agent_end', messages: [] });
    expect(events).toHaveLength(0);
  });

  it('should ignore turn_start events', () => {
    const events = harness.mapPIEvent({ type: 'turn_start' });
    expect(events).toHaveLength(0);
  });

  it('should ignore turn_end events', () => {
    const events = harness.mapPIEvent({ type: 'turn_end', message: {}, toolResults: [] });
    expect(events).toHaveLength(0);
  });

  it('should ignore message_start events', () => {
    const events = harness.mapPIEvent({ type: 'message_start', message: {} });
    expect(events).toHaveLength(0);
  });

  it('should ignore message_end events', () => {
    const events = harness.mapPIEvent({ type: 'message_end', message: {} });
    expect(events).toHaveLength(0);
  });

  it('should ignore tool_execution_update events', () => {
    const events = harness.mapPIEvent({
      type: 'tool_execution_update',
      toolCallId: 'call-1',
      toolName: 'test',
      args: {},
      partialResult: {},
    });
    expect(events).toHaveLength(0);
  });

  it('should handle tool result with multiple text content blocks', () => {
    const piEvent = {
      type: 'tool_execution_end',
      toolCallId: 'call-789',
      toolName: 'multi-result',
      result: {
        content: [
          { type: 'text', text: 'Part 1. ' },
          { type: 'text', text: 'Part 2.' },
          { type: 'image', data: 'base64...', mimeType: 'image/png' },
        ],
        details: {},
      },
      isError: false,
    };

    const events = harness.mapPIEvent(piEvent);
    expect(events).toHaveLength(1);
    // Should concatenate only text content blocks
    expect((events[0] as any).result).toBe('Part 1. Part 2.');
  });

  it('should handle missing toolCallId with generated UUID', () => {
    const piEvent = {
      type: 'tool_execution_start',
      toolName: 'no-id-tool',
      args: {},
    };

    const events = harness.mapPIEvent(piEvent);
    expect(events).toHaveLength(1);
    expect((events[0] as any).id).toBeDefined();
    expect(typeof (events[0] as any).id).toBe('string');
  });
});

describe('PIAgentHarness.run() - error handling', () => {
  it('should yield error event when SDK throws during run', async () => {
    const harness = new PIAgentHarness();

    const config: HarnessRunConfig = {
      modelConfig: { provider: 'openai', model: 'gpt-4o-mini' },
      systemPrompt: 'Test',
      messages: [{ role: 'user', content: 'Hello' } as any],
      tools: [],
      secrets: {},
      agentId: 'test',
      runId: 'test-run',
      conversationId: 'test-conv',
      workspaceDir: '/tmp',
    };

    // Without a valid API key / endpoint, the PI Agent SDK should error.
    // The harness should catch and yield an error event.
    const events: any[] = [];
    for await (const event of harness.run(config)) {
      events.push(event);
    }

    expect(events.length).toBeGreaterThan(0);
    const lastEvent = events[events.length - 1];
    expect(['error', 'done']).toContain(lastEvent.type);
  });
});
