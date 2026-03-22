import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { zodToJsonSchema, jsonSchemaToZod } from '../schema-convert.js';

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Round-trip: Zod -> JSON Schema -> Zod, then validate `input`. */
function roundTrip(schema: z.ZodType, input: unknown) {
  const json = zodToJsonSchema(schema);
  const rebuilt = jsonSchemaToZod(json);
  return rebuilt.safeParse(input);
}

/* -------------------------------------------------------------------------- */
/*  Round-trip tests — one per supported type                                  */
/* -------------------------------------------------------------------------- */

describe('zodToJsonSchema / jsonSchemaToZod round-trip', () => {
  it('z.string()', () => {
    const schema = z.string();
    expect(roundTrip(schema, 'hello').success).toBe(true);
    expect(roundTrip(schema, 123).success).toBe(false);
  });

  it('z.string() with min/max/regex', () => {
    const schema = z.string().min(2).max(5).regex(/^[a-z]+$/);
    expect(roundTrip(schema, 'abc').success).toBe(true);
    expect(roundTrip(schema, 'a').success).toBe(false); // too short
    expect(roundTrip(schema, 'abcdef').success).toBe(false); // too long
    expect(roundTrip(schema, 'ABC').success).toBe(false); // regex fail
  });

  it('z.number()', () => {
    const schema = z.number();
    expect(roundTrip(schema, 42).success).toBe(true);
    expect(roundTrip(schema, 3.14).success).toBe(true);
    expect(roundTrip(schema, 'nope').success).toBe(false);
  });

  it('z.number() with min/max', () => {
    const schema = z.number().min(0).max(100);
    expect(roundTrip(schema, 50).success).toBe(true);
    expect(roundTrip(schema, -1).success).toBe(false);
    expect(roundTrip(schema, 101).success).toBe(false);
  });

  it('z.number().int()', () => {
    const schema = z.number().int();
    expect(roundTrip(schema, 5).success).toBe(true);
    expect(roundTrip(schema, 5.5).success).toBe(false);
  });

  it('z.boolean()', () => {
    const schema = z.boolean();
    expect(roundTrip(schema, true).success).toBe(true);
    expect(roundTrip(schema, false).success).toBe(true);
    expect(roundTrip(schema, 'true').success).toBe(false);
  });

  it('z.enum()', () => {
    const schema = z.enum(['alpha', 'beta', 'gamma']);
    expect(roundTrip(schema, 'alpha').success).toBe(true);
    expect(roundTrip(schema, 'delta').success).toBe(false);
  });

  it('z.object() flat', () => {
    const schema = z.object({
      name: z.string(),
      age: z.number(),
    });
    expect(roundTrip(schema, { name: 'Ada', age: 36 }).success).toBe(true);
    expect(roundTrip(schema, { name: 'Ada' }).success).toBe(false); // missing age
    expect(roundTrip(schema, { name: 123, age: 36 }).success).toBe(false);
  });

  it('z.object() nested', () => {
    const schema = z.object({
      user: z.object({
        name: z.string(),
        address: z.object({
          city: z.string(),
        }),
      }),
    });
    const valid = { user: { name: 'Ada', address: { city: 'London' } } };
    const invalid = { user: { name: 'Ada', address: { city: 42 } } };
    expect(roundTrip(schema, valid).success).toBe(true);
    expect(roundTrip(schema, invalid).success).toBe(false);
  });

  it('z.array()', () => {
    const schema = z.array(z.string());
    expect(roundTrip(schema, ['a', 'b']).success).toBe(true);
    expect(roundTrip(schema, [1, 2]).success).toBe(false);
    expect(roundTrip(schema, 'not-array').success).toBe(false);
  });

  it('z.array(z.object(...))', () => {
    const schema = z.array(z.object({ id: z.number() }));
    expect(roundTrip(schema, [{ id: 1 }, { id: 2 }]).success).toBe(true);
    expect(roundTrip(schema, [{ id: 'x' }]).success).toBe(false);
  });

  it('optional fields', () => {
    const schema = z.object({
      required: z.string(),
      optional: z.string().optional(),
    });
    expect(roundTrip(schema, { required: 'yes' }).success).toBe(true);
    expect(roundTrip(schema, { required: 'yes', optional: 'also' }).success).toBe(true);
    expect(roundTrip(schema, {}).success).toBe(false); // missing required
  });

  it('z.union()', () => {
    const schema = z.union([z.string(), z.number()]);
    expect(roundTrip(schema, 'hello').success).toBe(true);
    expect(roundTrip(schema, 42).success).toBe(true);
    expect(roundTrip(schema, true).success).toBe(false);
  });

  it('.describe()', () => {
    const schema = z.string().describe('A user name');
    const json = zodToJsonSchema(schema);
    expect(json.description).toBe('A user name');

    // Validate round-trip still works
    expect(roundTrip(schema, 'hello').success).toBe(true);
  });

  it('.default()', () => {
    const schema = z.object({
      color: z.string().default('red'),
    });
    const json = zodToJsonSchema(schema);
    // The default should appear in the JSON Schema
    const props = json.properties as Record<string, Record<string, unknown>>;
    expect(props.color.default).toBe('red');

    // Round-trip: missing field should get the default
    const rebuilt = jsonSchemaToZod(json);
    const result = rebuilt.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).color).toBe('red');
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  Complex schema test                                                        */
/* -------------------------------------------------------------------------- */

describe('complex schema round-trip', () => {
  it('object with multiple field types, some optional', () => {
    const schema = z.object({
      name: z.string().min(1).describe('Agent name'),
      version: z.number().int().min(0),
      enabled: z.boolean(),
      tags: z.array(z.string()),
      mode: z.enum(['auto', 'manual', 'hybrid']),
      config: z.object({
        maxRetries: z.number().int().default(3),
        timeout: z.number().optional(),
      }),
      metadata: z.union([z.string(), z.object({ key: z.string() })]).optional(),
    });

    const validInput = {
      name: 'test-agent',
      version: 2,
      enabled: true,
      tags: ['fast', 'reliable'],
      mode: 'auto' as const,
      config: { maxRetries: 5 },
    };

    const json = zodToJsonSchema(schema);
    const rebuilt = jsonSchemaToZod(json);

    // Valid input accepted by both
    expect(schema.safeParse(validInput).success).toBe(true);
    expect(rebuilt.safeParse(validInput).success).toBe(true);

    // Invalid inputs rejected by both
    const badInputs = [
      { ...validInput, name: '' }, // min(1) violation
      { ...validInput, version: 1.5 }, // int() violation
      { ...validInput, enabled: 'yes' }, // boolean type
      { ...validInput, tags: [1, 2] }, // array item type
      { ...validInput, mode: 'unknown' }, // enum violation
    ];

    for (const bad of badInputs) {
      expect(schema.safeParse(bad).success).toBe(false);
      expect(rebuilt.safeParse(bad).success).toBe(false);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  Determinism test                                                           */
/* -------------------------------------------------------------------------- */

describe('determinism', () => {
  it('same schema produces identical JSON Schema on repeated calls', () => {
    const schema = z.object({
      a: z.string().min(1),
      b: z.number().max(100),
      c: z.array(z.boolean()),
      d: z.enum(['x', 'y']).optional(),
    });

    const first = JSON.stringify(zodToJsonSchema(schema));
    const second = JSON.stringify(zodToJsonSchema(schema));
    const third = JSON.stringify(zodToJsonSchema(schema));

    expect(first).toBe(second);
    expect(second).toBe(third);
  });
});

/* -------------------------------------------------------------------------- */
/*  Invalid inputs rejected by both original and reconverted schema            */
/* -------------------------------------------------------------------------- */

describe('invalid input rejection parity', () => {
  const testCases: Array<{ name: string; schema: z.ZodType; invalid: unknown[] }> = [
    {
      name: 'string constraints',
      schema: z.string().min(3).max(10),
      invalid: ['ab', 'a]very-long-string-that-exceeds-max', 42, null, undefined],
    },
    {
      name: 'number constraints',
      schema: z.number().int().min(0).max(100),
      invalid: [-1, 101, 50.5, 'fifty', true],
    },
    {
      name: 'object required fields',
      schema: z.object({ x: z.string(), y: z.number() }),
      invalid: [{}, { x: 'hello' }, { y: 42 }, { x: 1, y: 2 }, null],
    },
    {
      name: 'enum values',
      schema: z.enum(['a', 'b', 'c']),
      invalid: ['d', '', 1, null, undefined],
    },
    {
      name: 'array items',
      schema: z.array(z.number()),
      invalid: [['a', 'b'], [1, 'mixed'], 'not-array', 42],
    },
  ];

  for (const { name, schema, invalid } of testCases) {
    it(name, () => {
      const json = zodToJsonSchema(schema);
      const rebuilt = jsonSchemaToZod(json);

      for (const input of invalid) {
        const origResult = schema.safeParse(input);
        const rebuiltResult = rebuilt.safeParse(input);
        expect(origResult.success).toBe(false);
        expect(rebuiltResult.success).toBe(false);
      }
    });
  }
});
