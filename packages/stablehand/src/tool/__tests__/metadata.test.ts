import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  toToolMetadata,
  toToolMetadataList,
} from '../metadata.js';
import { jsonSchemaToZod } from '@stablehand/sandbox-daemon';
import type { ToolDefinition } from '@stablehand/sandbox-daemon';

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function makeTool(overrides?: Partial<ToolDefinition>): ToolDefinition {
  return {
    name: 'test-tool',
    description: 'A test tool',
    input: z.object({ text: z.string() }),
    handler: async (input: unknown) => (input as { text: string }).text,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/*  toToolMetadata — simple tool                                               */
/* -------------------------------------------------------------------------- */

describe('toToolMetadata', () => {
  it('converts a simple tool with a string input field', () => {
    const tool = makeTool();
    const meta = toToolMetadata(tool);

    expect(meta.name).toBe('test-tool');
    expect(meta.description).toBe('A test tool');
    expect(meta.location).toBe('orchestrator');
    expect(meta.inputSchema).toBeDefined();
    expect(meta.inputSchema.type).toBe('object');

    const props = meta.inputSchema.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(props.text).toBeDefined();
    expect(props.text.type).toBe('string');

    // required array should contain 'text'
    expect(meta.inputSchema.required).toEqual(['text']);
  });

  it('converts a complex tool with multiple field types', () => {
    const tool = makeTool({
      name: 'complex-tool',
      description: 'A complex tool with many field types',
      input: z.object({
        query: z.string().min(1).describe('Search query'),
        limit: z.number().int().min(1).max(100).default(10),
        tags: z.array(z.string()),
        mode: z.enum(['fast', 'accurate']),
        verbose: z.boolean().optional(),
      }),
    });

    const meta = toToolMetadata(tool);

    expect(meta.name).toBe('complex-tool');
    expect(meta.description).toBe('A complex tool with many field types');
    expect(meta.location).toBe('orchestrator');

    const props = meta.inputSchema.properties as Record<
      string,
      Record<string, unknown>
    >;

    // query — string with minLength
    expect(props.query.type).toBe('string');
    expect(props.query.minLength).toBe(1);
    expect(props.query.description).toBe('Search query');

    // limit — integer with min/max and default
    expect(props.limit.type).toBe('integer');
    expect(props.limit.minimum).toBe(1);
    expect(props.limit.maximum).toBe(100);
    expect(props.limit.default).toBe(10);

    // tags — array of strings
    expect(props.tags.type).toBe('array');

    // mode — enum
    expect(props.mode).toBeDefined();

    // required should include query, tags, mode (limit has default, verbose is optional)
    const required = meta.inputSchema.required as string[];
    expect(required).toContain('query');
    expect(required).toContain('tags');
    expect(required).toContain('mode');
  });

  it('defaults location to orchestrator', () => {
    const tool = makeTool({ name: 'my-registry-tool' });
    const meta = toToolMetadata(tool);
    expect(meta.location).toBe('orchestrator');
  });

  it('uses explicit orchestrator location on the tool', () => {
    const tool = makeTool({ name: 'emit-event', location: 'orchestrator' });
    const meta = toToolMetadata(tool);
    expect(meta.location).toBe('orchestrator');
  });

  it('uses explicit daemon location on the tool', () => {
    const tool = makeTool({ name: 'artifact_upload', location: 'daemon' });
    const meta = toToolMetadata(tool);
    expect(meta.location).toBe('daemon');
  });

  it('explicit location override works for sandbox', () => {
    const tool = makeTool({ name: 'emit-event' });
    const meta = toToolMetadata(tool, 'sandbox');
    expect(meta.location).toBe('sandbox');
  });

  it('explicit location override works for orchestrator', () => {
    const tool = makeTool({ name: 'custom-tool' });
    const meta = toToolMetadata(tool, 'orchestrator');
    expect(meta.location).toBe('orchestrator');
  });

  it('uses tool.location when set to orchestrator', () => {
    const tool = makeTool({ name: 'http-tool', location: 'orchestrator' });
    const meta = toToolMetadata(tool);
    expect(meta.location).toBe('orchestrator');
  });

  it('uses tool.location when set to sandbox', () => {
    const tool = makeTool({ name: 'emit-event', location: 'sandbox' });
    const meta = toToolMetadata(tool);
    expect(meta.location).toBe('sandbox');
  });

  it('explicit parameter overrides tool.location', () => {
    const tool = makeTool({ name: 'http-tool', location: 'orchestrator' });
    const meta = toToolMetadata(tool, 'sandbox');
    expect(meta.location).toBe('sandbox');
  });

  it('respects tool.location when explicitly set to orchestrator', () => {
    const tool = makeTool({ name: 'plain-tool', location: 'orchestrator' });
    const meta = toToolMetadata(tool);
    expect(meta.location).toBe('orchestrator');
  });

  it('defaults to orchestrator when tool.location is unset', () => {
    const tool = makeTool({ name: 'plain-tool' });
    expect(tool.location).toBeUndefined();
    const meta = toToolMetadata(tool);
    expect(meta.location).toBe('orchestrator');
  });
});

/* -------------------------------------------------------------------------- */
/*  toToolMetadataList — bulk conversion                                       */
/* -------------------------------------------------------------------------- */

describe('toToolMetadataList', () => {
  it('converts multiple tools at once', () => {
    const tools = [
      makeTool({ name: 'tool-a', description: 'Tool A' }),
      makeTool({ name: 'tool-b', description: 'Tool B' }),
      makeTool({ name: 'emit-event', description: 'Emit event', location: 'orchestrator' }),
    ];

    const metaList = toToolMetadataList(tools);

    expect(metaList).toHaveLength(3);
    expect(metaList[0].name).toBe('tool-a');
    expect(metaList[0].location).toBe('orchestrator');
    expect(metaList[1].name).toBe('tool-b');
    expect(metaList[1].location).toBe('orchestrator');
    expect(metaList[2].name).toBe('emit-event');
    expect(metaList[2].location).toBe('orchestrator');
  });

  it('handles empty array', () => {
    const metaList = toToolMetadataList([]);
    expect(metaList).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*  Round-trip: toToolMetadata → jsonSchemaToZod → validate                    */
/* -------------------------------------------------------------------------- */

describe('round-trip validation', () => {
  it('reconverted schema accepts the same valid inputs as the original', () => {
    const originalSchema = z.object({
      query: z.string().min(1),
      count: z.number().int().min(0),
      tags: z.array(z.string()),
    });

    const tool = makeTool({
      name: 'search',
      input: originalSchema,
    });

    const meta = toToolMetadata(tool);
    const rebuilt = jsonSchemaToZod(meta.inputSchema);

    const validInput = { query: 'hello', count: 5, tags: ['a', 'b'] };

    expect(originalSchema.safeParse(validInput).success).toBe(true);
    expect(rebuilt.safeParse(validInput).success).toBe(true);
  });

  it('reconverted schema rejects the same invalid inputs as the original', () => {
    const originalSchema = z.object({
      query: z.string().min(1),
      count: z.number().int().min(0),
    });

    const tool = makeTool({
      name: 'search',
      input: originalSchema,
    });

    const meta = toToolMetadata(tool);
    const rebuilt = jsonSchemaToZod(meta.inputSchema);

    const invalidInputs = [
      { query: '', count: 5 }, // min(1) violation
      { query: 'ok', count: -1 }, // min(0) violation
      { query: 'ok', count: 1.5 }, // int() violation
      { query: 123, count: 5 }, // type mismatch
      {}, // missing required fields
    ];

    for (const input of invalidInputs) {
      expect(originalSchema.safeParse(input).success).toBe(false);
      expect(rebuilt.safeParse(input).success).toBe(false);
    }
  });

  it('round-trip preserves optional fields and defaults', () => {
    const originalSchema = z.object({
      required: z.string(),
      optional: z.string().optional(),
      withDefault: z.number().default(42),
    });

    const tool = makeTool({ name: 'defaults-test', input: originalSchema });
    const meta = toToolMetadata(tool);
    const rebuilt = jsonSchemaToZod(meta.inputSchema);

    // Minimal input — only required field
    const minimal = { required: 'yes' };
    const origResult = originalSchema.safeParse(minimal);
    const rebuiltResult = rebuilt.safeParse(minimal);

    expect(origResult.success).toBe(true);
    expect(rebuiltResult.success).toBe(true);

    if (origResult.success && rebuiltResult.success) {
      // Default should be applied
      expect(
        (origResult.data as Record<string, unknown>).withDefault,
      ).toBe(42);
      expect(
        (rebuiltResult.data as Record<string, unknown>).withDefault,
      ).toBe(42);
    }
  });
});
