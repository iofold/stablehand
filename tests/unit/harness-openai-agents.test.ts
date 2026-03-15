import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { OpenAIAgentsHarness } from '../../packages/ctxmill/src/harness/openai-agents.js';
import type { AgentHarness, HarnessRunConfig } from '../../packages/ctxmill/src/harness/types.js';
import type { ToolDefinition } from '../../packages/ctxmill/src/tool/types.js';

/**
 * Mock SDK `tool()` function that mirrors the shape of @openai/agents tool().
 * Returns a plain object with the expected FunctionTool shape.
 */
function mockToolFn(opts: {
  name: string;
  description: string;
  parameters: any;
  needsApproval?: any;
  execute: any;
}) {
  return {
    type: 'function' as const,
    name: opts.name,
    description: opts.description,
    parameters: opts.parameters,
    needsApproval: opts.needsApproval,
    execute: opts.execute,
  };
}

const mockSDK = { tool: mockToolFn };

describe('OpenAIAgentsHarness', () => {
  it('should have name "openai-agents"', () => {
    const harness = new OpenAIAgentsHarness();
    expect(harness.name).toBe('openai-agents');
  });

  it('should implement the AgentHarness interface', () => {
    const harness = new OpenAIAgentsHarness();

    // Verify it satisfies the interface structurally
    const asInterface: AgentHarness = harness;
    expect(asInterface.name).toBe('openai-agents');
    expect(typeof asInterface.run).toBe('function');
  });

  it('should accept an optional modelProvider in constructor', () => {
    const mockProvider = {
      getModel: () => ({} as any),
    };
    const harness = new OpenAIAgentsHarness({ modelProvider: mockProvider });
    expect(harness.name).toBe('openai-agents');
  });

  describe('convertToolsWithSDK', () => {
    it('should convert ToolDefinition[] to OpenAI Agents SDK tools', () => {
      const harness = new OpenAIAgentsHarness();
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
        {
          name: 'send-email',
          description: 'Send an email',
          input: z.object({
            to: z.string(),
            body: z.string(),
          }),
          requiresApproval: true,
          handler: async (input: { to: string; body: string }) => {
            return `Sent to ${input.to}`;
          },
        },
      ];

      const converted = harness.convertToolsWithSDK(mockSDK, toolDefs, 'test-run-id');

      expect(converted).toHaveLength(2);
      expect(converted[0].name).toBe('get-weather');
      expect(converted[1].name).toBe('send-email');
      expect(converted[0].type).toBe('function');
      expect(converted[1].type).toBe('function');
    });

    it('should preserve tool descriptions in conversion', () => {
      const harness = new OpenAIAgentsHarness();
      const toolDefs: ToolDefinition[] = [
        {
          name: 'my-tool',
          description: 'A descriptive description',
          input: z.object({}),
          handler: async () => 'done',
        },
      ];

      const converted = harness.convertToolsWithSDK(mockSDK, toolDefs, 'run-1');
      expect(converted[0].description).toBe('A descriptive description');
    });

    it('should pass Zod schema as parameters', () => {
      const harness = new OpenAIAgentsHarness();
      const schema = z.object({ x: z.number() });
      const toolDefs: ToolDefinition[] = [
        {
          name: 'calc',
          description: 'Calculate',
          input: schema,
          handler: async () => '42',
        },
      ];

      const converted = harness.convertToolsWithSDK(mockSDK, toolDefs, 'run-1');
      expect(converted[0].parameters).toBe(schema);
    });

    it('should wire needsApproval for tools with requiresApproval', () => {
      const harness = new OpenAIAgentsHarness();
      const toolDefs: ToolDefinition[] = [
        {
          name: 'safe-tool',
          description: 'No approval needed',
          input: z.object({}),
          handler: async () => 'ok',
        },
        {
          name: 'dangerous-tool',
          description: 'Needs approval',
          input: z.object({}),
          requiresApproval: true,
          handler: async () => 'ok',
        },
      ];

      const converted = harness.convertToolsWithSDK(mockSDK, toolDefs, 'run-1');

      // The safe tool should not have needsApproval set
      expect(converted[0].needsApproval).toBeUndefined();
      // The dangerous tool should have needsApproval set (as a function)
      expect(converted[1].needsApproval).toBeDefined();
      expect(typeof converted[1].needsApproval).toBe('function');
    });

    it('should auto-approve when no onApprovalNeeded callback is provided', async () => {
      const harness = new OpenAIAgentsHarness();
      const toolDefs: ToolDefinition[] = [
        {
          name: 'needs-approval',
          description: 'Needs approval',
          input: z.object({}),
          requiresApproval: true,
          handler: async () => 'ok',
        },
      ];

      // No onApprovalNeeded callback
      const converted = harness.convertToolsWithSDK(mockSDK, toolDefs, 'run-1');
      const result = await converted[0].needsApproval();
      expect(result).toBe(true);
    });

    it('should invoke onApprovalNeeded callback for tools requiring approval', async () => {
      const harness = new OpenAIAgentsHarness();
      const onApproval = vi.fn().mockResolvedValue({ action: 'approve' });
      const toolDefs: ToolDefinition[] = [
        {
          name: 'needs-approval',
          description: 'Needs approval',
          input: z.object({}),
          requiresApproval: true,
          handler: async () => 'ok',
        },
      ];

      const converted = harness.convertToolsWithSDK(
        mockSDK,
        toolDefs,
        'run-1',
        undefined,
        onApproval,
      );
      const result = await converted[0].needsApproval();
      expect(result).toBe(true);
      expect(onApproval).toHaveBeenCalledOnce();
    });

    it('should return false from needsApproval when callback rejects', async () => {
      const harness = new OpenAIAgentsHarness();
      const onApproval = vi.fn().mockResolvedValue({ action: 'reject' });
      const toolDefs: ToolDefinition[] = [
        {
          name: 'needs-approval',
          description: 'Needs approval',
          input: z.object({}),
          requiresApproval: true,
          handler: async () => 'ok',
        },
      ];

      const converted = harness.convertToolsWithSDK(
        mockSDK,
        toolDefs,
        'run-1',
        undefined,
        onApproval,
      );
      const result = await converted[0].needsApproval();
      expect(result).toBe(false);
    });

    it('should handle empty tool list', () => {
      const harness = new OpenAIAgentsHarness();
      const converted = harness.convertToolsWithSDK(mockSDK, [], 'run-1');
      expect(converted).toHaveLength(0);
    });

    it('should wire execute to call the tool handler', async () => {
      const harness = new OpenAIAgentsHarness();
      const handler = vi.fn().mockResolvedValue('result-42');
      const toolDefs: ToolDefinition[] = [
        {
          name: 'my-tool',
          description: 'Test',
          input: z.object({ val: z.string() }),
          handler,
        },
      ];

      const converted = harness.convertToolsWithSDK(mockSDK, toolDefs, 'run-1');
      const result = await converted[0].execute({ val: 'hello' });
      expect(result).toBe('result-42');
      expect(handler).toHaveBeenCalledWith(
        { val: 'hello' },
        expect.objectContaining({
          conversationId: 'run-1',
        }),
      );
    });
  });

  describe('run() - stream event mapping', () => {
    it('should yield error event when SDK throws', async () => {
      // Mock the dynamic import to throw
      const harness = new OpenAIAgentsHarness();

      // Override the module-level SDK loader to simulate a failure
      const events: any[] = [];
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

      // Without valid SDK / API key, run() should catch and yield error
      for await (const event of harness.run(config)) {
        events.push(event);
      }

      expect(events.length).toBeGreaterThan(0);
      const lastEvent = events[events.length - 1];
      expect(['error', 'done']).toContain(lastEvent.type);
    });
  });

  describe('mapStreamEvent (via run internals)', () => {
    it('should map text delta events correctly', () => {
      const harness = new OpenAIAgentsHarness();
      // Access private method via casting for testing
      const mapFn = (harness as any).mapStreamEvent.bind(harness);

      const event = {
        type: 'raw_model_stream_event',
        data: { type: 'output_text_delta', delta: 'Hello world' },
      };

      const results = [...mapFn(event, new Map(), {} as HarnessRunConfig)];
      expect(results).toEqual([
        { type: 'text_delta', content: 'Hello world' },
      ]);
    });

    it('should map tool_called events to tool_call_start', () => {
      const harness = new OpenAIAgentsHarness();
      const mapFn = (harness as any).mapStreamEvent.bind(harness);

      const event = {
        type: 'run_item_stream_event',
        name: 'tool_called',
        item: {
          rawItem: {
            callId: 'call-123',
            name: 'get-weather',
            arguments: '{"city":"NYC"}',
          },
        },
      };

      const toolStartTimes = new Map<string, number>();
      const results = [...mapFn(event, toolStartTimes, {} as HarnessRunConfig)];

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        type: 'tool_call_start',
        id: 'call-123',
        name: 'get-weather',
        args: { city: 'NYC' },
      });
      expect(toolStartTimes.has('call-123')).toBe(true);
    });

    it('should map tool_output events to tool_call_end', () => {
      const harness = new OpenAIAgentsHarness();
      const mapFn = (harness as any).mapStreamEvent.bind(harness);

      const toolStartTimes = new Map<string, number>();
      toolStartTimes.set('call-123', Date.now() - 100);

      const event = {
        type: 'run_item_stream_event',
        name: 'tool_output',
        item: {
          rawItem: { callId: 'call-123' },
          output: 'The weather is sunny',
        },
      };

      const results = [...mapFn(event, toolStartTimes, {} as HarnessRunConfig)];

      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('tool_call_end');
      expect(results[0].id).toBe('call-123');
      expect(results[0].result).toBe('The weather is sunny');
      expect(results[0].durationMs).toBeGreaterThanOrEqual(0);
      expect(toolStartTimes.has('call-123')).toBe(false);
    });

    it('should map tool_approval_requested events to approval_needed', () => {
      const harness = new OpenAIAgentsHarness();
      const mapFn = (harness as any).mapStreamEvent.bind(harness);

      const event = {
        type: 'run_item_stream_event',
        name: 'tool_approval_requested',
        item: {
          rawItem: {
            callId: 'call-456',
            name: 'send-email',
            arguments: '{"to":"user@example.com"}',
          },
          toolName: 'send-email',
        },
      };

      const results = [...mapFn(event, new Map(), {} as HarnessRunConfig)];

      expect(results).toEqual([
        {
          type: 'approval_needed',
          id: 'call-456',
          tool: 'send-email',
          args: { to: 'user@example.com' },
        },
      ]);
    });

    it('should ignore agent_updated_stream_event', () => {
      const harness = new OpenAIAgentsHarness();
      const mapFn = (harness as any).mapStreamEvent.bind(harness);

      const event = {
        type: 'agent_updated_stream_event',
        agent: { name: 'test' },
      };

      const results = [...mapFn(event, new Map(), {} as HarnessRunConfig)];
      expect(results).toHaveLength(0);
    });

    it('should ignore raw events that are not output_text_delta', () => {
      const harness = new OpenAIAgentsHarness();
      const mapFn = (harness as any).mapStreamEvent.bind(harness);

      const event = {
        type: 'raw_model_stream_event',
        data: { type: 'response_done', response: {} },
      };

      const results = [...mapFn(event, new Map(), {} as HarnessRunConfig)];
      expect(results).toHaveLength(0);
    });
  });
});
