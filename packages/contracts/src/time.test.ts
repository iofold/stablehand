/**
 * ctx-iqzy T11 — temporal/unit contract enforcement.
 *
 * Walks every exported object schema and asserts:
 *  - every field ending in `At` (and every field named `timestamp`) accepts
 *    integer epoch-ms and rejects floats, negatives, and ISO strings;
 *  - duration-ish names carry an Ms/Sec suffix; sizes carry Bytes; relative
 *    expiry is Sec-suffixed.
 *
 * LEGACY_DEBT lists the known Wave-3 renames. The test is self-cleaning:
 * a fixed field must be REMOVED from the list or the test fails, so the
 * list can only shrink.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import * as contracts from './index.js';

const LEGACY_DEBT = new Set([
  // U3: bare ms timeout beside timeoutSec (rename tracked with a data migration)
  'AgentCreateInputSchema.httpTools.timeout',
  'AgentListResponseSchema.httpTools.timeout',
  'AgentPatchInputSchema.httpTools.timeout',
  'AgentSchema.httpTools.timeout',
  'HttpToolDefinitionSchema.timeout',
  // U4: bare byte sizes
  'FileListResponseSchema.entries.size',
  'FileReadResponseSchema.size',
  'FileWriteResponseSchema.size',
  // U9/T8 (ScheduleSchema.nextRun) is name-only debt this walker cannot
  // detect — tracked in the Wave-3 plan, not here.
]);

type Violation = string;

function unwrap(schema: unknown): unknown {
  let current = schema as { unwrap?: () => unknown; removeDefault?: () => unknown };
  for (let i = 0; i < 10; i += 1) {
    if (typeof current.unwrap === 'function') { current = current.unwrap() as never; continue; }
    if (typeof current.removeDefault === 'function') { current = current.removeDefault() as never; continue; }
    break;
  }
  return current;
}

function isEpochMillisLike(schema: z.ZodType): boolean {
  const accepts = (v: unknown) => schema.safeParse(v).success;
  return accepts(1_755_000_000_000) && !accepts(1.5) && !accepts(-5) && !accepts('2026-01-01T00:00:00.000Z');
}

function checkField(path: string, name: string, schema: z.ZodType, violations: Violation[]): void {
  const timestampName = /At$/.test(name) || name === 'timestamp';
  if (timestampName && !isEpochMillisLike(schema)) {
    violations.push(path);
  }
  // Duration-ish names must carry a unit suffix. Whole camelCase words only —
  // "age" must not match inside "agentId"/"message"/"coverage".
  const words = name.split(/(?=[A-Z])/).map((w) => w.toLowerCase());
  const durationWords = ['duration', 'age', 'lag', 'uptime', 'elapsed', 'interval', 'timeout'];
  if (words.some((w) => durationWords.includes(w))
    && !/(Ms|Sec|Seconds)$/.test(name) && !/At$/.test(name)) {
    violations.push(path);
  }
  // Relative expiry must be Sec-suffixed; bare sizes must be Bytes-suffixed.
  if (/^expiresIn$/.test(name)) violations.push(path);
  if (/^(size|maxSize)$/.test(name)) violations.push(path);
}

function walk(path: string, schema: unknown, violations: Violation[], depth: number): void {
  if (depth > 8) return;
  const base = unwrap(schema) as {
    shape?: Record<string, z.ZodType>;
    element?: unknown;
    options?: unknown[];
  };
  if (base.shape && typeof base.shape === 'object') {
    for (const [name, field] of Object.entries(base.shape)) {
      checkField(`${path}.${name}`, name, field, violations);
      walk(`${path}.${name}`, field, violations, depth + 1);
    }
    return;
  }
  if (base.element) walk(path, base.element, violations, depth + 1);
  if (Array.isArray(base.options)) {
    for (const option of base.options) walk(path, option, violations, depth + 1);
  }
}

describe('temporal/unit contract enforcement (ctx-iqzy)', () => {
  const violations: Violation[] = [];
  for (const exportName of Object.keys(contracts).sort()) {
    const value = (contracts as Record<string, unknown>)[exportName];
    if (value instanceof z.ZodType) {
      walk(exportName, value, violations, 0);
    }
  }
  const unique = [...new Set(violations)].sort();

  it('every violation is a tracked legacy-debt entry', () => {
    const untracked = unique.filter((v) => !LEGACY_DEBT.has(v));
    expect(untracked, 'new fields must follow the temporal/unit rules (see time.ts)').toEqual([]);
  });

  it('the debt list is self-cleaning: fixed fields must be removed from it', () => {
    const stale = [...LEGACY_DEBT].filter((entry) => !unique.includes(entry));
    expect(stale, 'these entries no longer violate — delete them from LEGACY_DEBT').toEqual([]);
  });

  it('the shared schemas behave as documented', () => {
    expect(contracts.EpochMillisSchema.safeParse(1_755_000_000_000).success).toBe(true);
    expect(contracts.EpochMillisSchema.safeParse(-1).success).toBe(false);
    expect(contracts.EpochMillisSchema.safeParse('2026-01-01').success).toBe(false);
    expect(contracts.DurationMsSchema.safeParse(1500).success).toBe(true);
    expect(contracts.DurationMsSchema.safeParse(-1).success).toBe(false);
  });
});
