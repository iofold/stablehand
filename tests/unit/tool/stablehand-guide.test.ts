import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ToolDefinition } from '@stablehand/sandbox-daemon';
import {
  createStablehandGuideTool,
  STABLEHAND_GUIDE_TOOL_NAME,
} from '../../../packages/stablehand/src/tool/builtin/stablehand-guide.js';
import { createMockToolContext } from '../../utils/event-bus-test-helpers.js';

const mockCtx = createMockToolContext();

function createTestTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: 'test-tool',
    description: 'A test tool',
    input: z.object({}),
    handler: async () => 'ok',
    ...overrides,
  };
}

describe('stablehand-guide tool', () => {
  it('creates a valid tool definition', () => {
    const tool = createStablehandGuideTool({ listTools: () => [] });

    expect(tool.name).toBe(STABLEHAND_GUIDE_TOOL_NAME);
    expect(tool.description).toContain('stablehand platform capabilities');
    expect(tool.location).toBe('orchestrator');
  });

  it('returns PTC guide content', async () => {
    const tool = createStablehandGuideTool({ listTools: () => [] });

    const result = await tool.handler({ topic: 'ptc' }, mockCtx);

    expect(result).toContain('# Programmatic Tool Calling (PTC)');
    expect(result).toContain('Always prefer PTC scripts');
    expect(result).toContain('/workspace/.tools/');
  });

  it('returns the A2UI guide stub', async () => {
    const tool = createStablehandGuideTool({ listTools: () => [] });

    const result = await tool.handler({ topic: 'a2ui' }, mockCtx);

    expect(result).toContain('# A2UI — Structured Visual Rendering');
    expect(result).toContain('a2ui-render');
    expect(result).toContain('BarChart');
  });

  it('enriches PTC content with programmatic tools', async () => {
    const tool = createStablehandGuideTool({
      listTools: () => [
        createTestTool({ name: 'search-heavy', description: 'Searches a huge corpus', programmatic: true }),
        createTestTool({ name: 'plain-tool', description: 'Regular tool' }),
      ],
    });

    const result = await tool.handler({ topic: 'ptc' }, mockCtx);

    expect(result).toContain('## PTC-Enabled Tools');
    expect(result).toContain('search-heavy');
    expect(result).not.toContain('plain-tool');
  });

  it('enriches HITL content with approval-required tools', async () => {
    const tool = createStablehandGuideTool({
      listTools: () => [
        createTestTool({ name: 'request-approval', description: 'Requests human approval', requiresApproval: true }),
        createTestTool({ name: 'safe-tool', description: 'Does not need approval' }),
      ],
    });

    const result = await tool.handler({ topic: 'hitl' }, mockCtx);

    expect(result).toContain('# Human-in-the-Loop (HITL) Approvals');
    expect(result).toContain('## Approval-Gated Tools');
    expect(result).toContain('request-approval');
    expect(result).not.toContain('safe-tool');
  });

  it('lists full tool inventory for capabilities', async () => {
    const tool = createStablehandGuideTool({
      listTools: () => [
        createTestTool({ name: 'alpha', description: 'Alpha tool', location: 'sandbox' }),
        createTestTool({ name: 'beta', description: 'Beta tool', location: 'orchestrator' }),
      ],
    });

    const result = await tool.handler({ topic: 'capabilities' }, mockCtx);

    expect(result).toContain('# Platform Capabilities');
    expect(result).toContain('## Tool Inventory');
    expect(result).toContain('alpha');
    expect(result).toContain('location: sandbox');
    expect(result).toContain('beta');
    expect(result).toContain('location: orchestrator');
  });

  it('returns an error message for an invalid topic', async () => {
    const tool = createStablehandGuideTool({ listTools: () => [] });

    const result = await tool.handler({ topic: 'unknown-topic' }, mockCtx);

    expect(result).toContain('Error: Unknown stablehand-guide topic');
    expect(result).toContain('ptc');
    expect(result).toContain('capabilities');
  });
});
