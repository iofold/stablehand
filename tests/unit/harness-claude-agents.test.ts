import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { ClaudeAgentsHarness } from '../../packages/ctxmill/src/harness/claude-agents.js';
import type { AgentHarness, HarnessRunConfig } from '../../packages/ctxmill/src/harness/types.js';
import type { ToolDefinition } from '../../packages/ctxmill/src/tool/types.js';

/**
 * Mock SDK `tool()` function that mirrors the shape of
 * @anthropic-ai/claude-agent-sdk's `tool()`.
 * Returns a plain SdkMcpToolDefinition-shaped object.
 */
function mockToolFn(
  name: string,
  description: string,
  inputSchema: any,
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<any>,
) {
  return {
    name,
    description,
    inputSchema,
    handler,
  };
}

const mockSDK = { tool: mockToolFn };

describe('ClaudeAgentsHarness', () => {
  it('should have name "claude-agents"', () => {
    const harness = new ClaudeAgentsHarness();
    expect(harness.name).toBe('claude-agents');
  });

  it('should implement the AgentHarness interface', () => {
    const harness = new ClaudeAgentsHarness();

    // Verify it satisfies the interface structurally
    const asInterface: AgentHarness = harness;
    expect(asInterface.name).toBe('claude-agents');
    expect(typeof asInterface.run).toBe('function');
  });

  describe('convertToolsWithSDK', () => {
    it('should convert ToolDefinition[] to Claude SDK MCP tools', () => {
      const harness = new ClaudeAgentsHarness();
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
    });

    it('should preserve tool descriptions in conversion', () => {
      const harness = new ClaudeAgentsHarness();
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

    it('should extract Zod raw shape as inputSchema', () => {
      const harness = new ClaudeAgentsHarness();
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
      // The inputSchema should be the raw shape extracted from the ZodObject
      expect(converted[0].inputSchema).toHaveProperty('x');
    });

    it('should handle empty tool list', () => {
      const harness = new ClaudeAgentsHarness();
      const converted = harness.convertToolsWithSDK(mockSDK, [], 'run-1');
      expect(converted).toHaveLength(0);
    });

    it('should wrap handler to return MCP CallToolResult format', async () => {
      const harness = new ClaudeAgentsHarness();
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
      const result = await converted[0].handler({ val: 'hello' }, {});
      expect(result).toEqual({
        content: [{ type: 'text', text: 'result-42' }],
      });
      expect(handler).toHaveBeenCalledWith(
        { val: 'hello' },
        expect.objectContaining({
          conversationId: 'run-1',
        }),
      );
    });

    it('should return rejection text when approval is denied', async () => {
      const harness = new ClaudeAgentsHarness();
      const onApproval = vi.fn().mockResolvedValue({ action: 'reject' });
      const toolDefs: ToolDefinition[] = [
        {
          name: 'needs-approval',
          description: 'Needs approval',
          input: z.object({}),
          requiresApproval: true,
          handler: async () => 'should-not-reach',
        },
      ];

      const converted = harness.convertToolsWithSDK(
        mockSDK,
        toolDefs,
        'run-1',
        undefined,
        onApproval,
      );
      const result = await converted[0].handler({}, {});
      expect(result.content[0].text).toBe('Tool call was rejected by the user.');
      expect(onApproval).toHaveBeenCalledOnce();
    });

    it('should execute handler when approval is granted', async () => {
      const harness = new ClaudeAgentsHarness();
      const onApproval = vi.fn().mockResolvedValue({ action: 'approve' });
      const handler = vi.fn().mockResolvedValue('approved-result');
      const toolDefs: ToolDefinition[] = [
        {
          name: 'needs-approval',
          description: 'Needs approval',
          input: z.object({}),
          requiresApproval: true,
          handler,
        },
      ];

      const converted = harness.convertToolsWithSDK(
        mockSDK,
        toolDefs,
        'run-1',
        undefined,
        onApproval,
      );
      const result = await converted[0].handler({}, {});
      expect(result).toEqual({
        content: [{ type: 'text', text: 'approved-result' }],
      });
      expect(onApproval).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledOnce();
    });

    it('should auto-approve when no onApprovalNeeded callback is provided', async () => {
      const harness = new ClaudeAgentsHarness();
      const handler = vi.fn().mockResolvedValue('auto-approved');
      const toolDefs: ToolDefinition[] = [
        {
          name: 'needs-approval',
          description: 'Needs approval',
          input: z.object({}),
          requiresApproval: true,
          handler,
        },
      ];

      // No onApprovalNeeded callback
      const converted = harness.convertToolsWithSDK(mockSDK, toolDefs, 'run-1');
      const result = await converted[0].handler({}, {});
      expect(result).toEqual({
        content: [{ type: 'text', text: 'auto-approved' }],
      });
      expect(handler).toHaveBeenCalledOnce();
    });
  });

  describe('buildCanUseTool', () => {
    it('should allow tools that do not require approval', async () => {
      const harness = new ClaudeAgentsHarness();
      const toolDefs: ToolDefinition[] = [
        {
          name: 'safe-tool',
          description: 'Safe',
          input: z.object({}),
          handler: async () => 'ok',
        },
      ];

      const canUseTool = harness.buildCanUseTool(toolDefs, undefined, 'run-1');
      const result = await canUseTool('safe-tool', {}, {
        signal: new AbortController().signal,
        toolUseID: 'tu-1',
      });
      expect(result).toEqual({ behavior: 'allow' });
    });

    it('should auto-approve approval-required tools when no callback is provided', async () => {
      const harness = new ClaudeAgentsHarness();
      const toolDefs: ToolDefinition[] = [
        {
          name: 'danger-tool',
          description: 'Dangerous',
          input: z.object({}),
          requiresApproval: true,
          handler: async () => 'ok',
        },
      ];

      const canUseTool = harness.buildCanUseTool(toolDefs, undefined, 'run-1');
      const result = await canUseTool('danger-tool', {}, {
        signal: new AbortController().signal,
        toolUseID: 'tu-2',
      });
      expect(result).toEqual({ behavior: 'allow' });
    });

    it('should deny when onApprovalNeeded rejects', async () => {
      const harness = new ClaudeAgentsHarness();
      const onApproval = vi.fn().mockResolvedValue({ action: 'reject' });
      const toolDefs: ToolDefinition[] = [
        {
          name: 'danger-tool',
          description: 'Dangerous',
          input: z.object({}),
          requiresApproval: true,
          handler: async () => 'ok',
        },
      ];

      const canUseTool = harness.buildCanUseTool(toolDefs, onApproval, 'run-1');
      const result = await canUseTool('danger-tool', { key: 'val' }, {
        signal: new AbortController().signal,
        toolUseID: 'tu-3',
      });
      expect(result).toEqual({
        behavior: 'deny',
        message: 'Tool call was rejected by the user.',
      });
      expect(onApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: 'run-1',
          toolName: 'danger-tool',
          args: { key: 'val' },
        }),
      );
    });

    it('should allow when onApprovalNeeded approves', async () => {
      const harness = new ClaudeAgentsHarness();
      const onApproval = vi.fn().mockResolvedValue({ action: 'approve' });
      const toolDefs: ToolDefinition[] = [
        {
          name: 'danger-tool',
          description: 'Dangerous',
          input: z.object({}),
          requiresApproval: true,
          handler: async () => 'ok',
        },
      ];

      const canUseTool = harness.buildCanUseTool(toolDefs, onApproval, 'run-1');
      const result = await canUseTool('danger-tool', {}, {
        signal: new AbortController().signal,
        toolUseID: 'tu-4',
      });
      expect(result).toEqual({ behavior: 'allow' });
    });
  });

  describe('mapSDKMessage', () => {
    it('should map assistant text content blocks to text_delta', () => {
      const harness = new ClaudeAgentsHarness();

      const message = {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Hello world' },
          ],
        },
      };

      const results = [...harness.mapSDKMessage(message, new Map())];
      expect(results).toEqual([
        { type: 'text_delta', content: 'Hello world' },
      ]);
    });

    it('should map assistant tool_use blocks to tool_call_start', () => {
      const harness = new ClaudeAgentsHarness();
      const toolStartTimes = new Map<string, number>();

      const message = {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_123',
              name: 'get-weather',
              input: { city: 'NYC' },
            },
          ],
        },
      };

      const results = [...harness.mapSDKMessage(message, toolStartTimes)];

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        type: 'tool_call_start',
        id: 'toolu_123',
        name: 'get-weather',
        args: { city: 'NYC' },
      });
      expect(toolStartTimes.has('toolu_123')).toBe(true);
    });

    it('should map stream_event text_delta to text_delta', () => {
      const harness = new ClaudeAgentsHarness();

      const message = {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'streaming text' },
        },
      };

      const results = [...harness.mapSDKMessage(message, new Map())];
      expect(results).toEqual([
        { type: 'text_delta', content: 'streaming text' },
      ]);
    });

    it('should map stream_event content_block_start for tool_use to tool_call_start', () => {
      const harness = new ClaudeAgentsHarness();
      const toolStartTimes = new Map<string, number>();

      const message = {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: {
            type: 'tool_use',
            id: 'toolu_456',
            name: 'send-email',
          },
        },
      };

      const results = [...harness.mapSDKMessage(message, toolStartTimes)];

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        type: 'tool_call_start',
        id: 'toolu_456',
        name: 'send-email',
        args: {},
      });
      expect(toolStartTimes.has('toolu_456')).toBe(true);
    });

    it('should map result message to done with usage', () => {
      const harness = new ClaudeAgentsHarness();

      const message = {
        type: 'result',
        subtype: 'success',
        result: 'Done!',
        usage: {
          input_tokens: 100,
          output_tokens: 50,
        },
        total_cost_usd: 0.005,
      };

      const results = [...harness.mapSDKMessage(message, new Map())];

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        type: 'done',
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          cost: 0.005,
        },
      });
    });

    it('should handle result message without usage', () => {
      const harness = new ClaudeAgentsHarness();

      const message = {
        type: 'result',
        subtype: 'success',
        result: 'Done!',
      };

      const results = [...harness.mapSDKMessage(message, new Map())];

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        type: 'done',
        usage: undefined,
      });
    });

    it('should ignore tool_progress messages', () => {
      const harness = new ClaudeAgentsHarness();

      const message = {
        type: 'tool_progress',
        tool_use_id: 'toolu_789',
        tool_name: 'my-tool',
        elapsed_time_seconds: 1.5,
      };

      const results = [...harness.mapSDKMessage(message, new Map())];
      expect(results).toHaveLength(0);
    });

    it('should ignore tool_use_summary messages', () => {
      const harness = new ClaudeAgentsHarness();

      const message = {
        type: 'tool_use_summary',
        summary: 'Used get-weather tool',
        preceding_tool_use_ids: ['toolu_123'],
      };

      const results = [...harness.mapSDKMessage(message, new Map())];
      expect(results).toHaveLength(0);
    });

    it('should ignore system messages', () => {
      const harness = new ClaudeAgentsHarness();

      const message = {
        type: 'system',
        subtype: 'init',
        claude_code_version: '1.0.0',
      };

      const results = [...harness.mapSDKMessage(message, new Map())];
      expect(results).toHaveLength(0);
    });

    it('should handle stream_event with input_json_delta (no output)', () => {
      const harness = new ClaudeAgentsHarness();

      const message = {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'input_json_delta', partial_json: '{"city":"NY' },
        },
      };

      const results = [...harness.mapSDKMessage(message, new Map())];
      expect(results).toHaveLength(0);
    });

    it('should handle multiple content blocks in a single assistant message', () => {
      const harness = new ClaudeAgentsHarness();
      const toolStartTimes = new Map<string, number>();

      const message = {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Let me check the weather.' },
            {
              type: 'tool_use',
              id: 'toolu_abc',
              name: 'get-weather',
              input: { city: 'London' },
            },
          ],
        },
      };

      const results = [...harness.mapSDKMessage(message, toolStartTimes)];

      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({
        type: 'text_delta',
        content: 'Let me check the weather.',
      });
      expect(results[1]).toEqual({
        type: 'tool_call_start',
        id: 'toolu_abc',
        name: 'get-weather',
        args: { city: 'London' },
      });
    });
  });

  describe('run() - error handling', () => {
    it('should yield error event when SDK throws', async () => {
      const harness = new ClaudeAgentsHarness();

      const events: any[] = [];
      const config: HarnessRunConfig = {
        modelConfig: { provider: 'anthropic', model: 'claude-sonnet-4-5-20250514' },
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
});
