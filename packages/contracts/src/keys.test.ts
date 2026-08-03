import { describe, expect, it } from 'vitest';

import {
  API_KEY_TOKEN_PATTERN,
  ApiKeyCreateInputSchema,
  CapabilitySchema,
  capabilitySatisfies,
  emitGrantAllows,
  isCapability,
} from './keys.js';

describe('CapabilitySchema', () => {
  it('accepts every v1 verb', () => {
    for (const verb of [
      'agents:read', 'agents:write', 'conversations:write', 'events:read',
      'interrupts:read', 'interrupts:resolve', 'feedback:write',
      'artifacts:read', 'artifacts:write', 'webhooks:manage',
      'schedules:manage', 'triggers:emit',
    ]) {
      expect(isCapability(verb), verb).toBe(true);
    }
  });

  it('accepts a trailing-wildcard emit grant', () => {
    expect(isCapability('triggers:emit:custom.eval.*')).toBe(true);
    expect(isCapability('triggers:emit:custom.mystats.daily.*')).toBe(true);
  });

  it('rejects non-verbs, non-trailing wildcards, and parameterized non-emit grants', () => {
    expect(isCapability('secrets:read')).toBe(false);
    expect(isCapability('agents:read:one')).toBe(false);
    expect(isCapability('triggers:emit:custom.*.eval')).toBe(false);
    expect(isCapability('triggers:emit:custom.eval')).toBe(false); // no wildcard
    expect(isCapability('triggers:emit:turn.completed.*')).toBe(false); // not custom.*
    expect(isCapability('events:read:custom.*')).toBe(false);
    expect(CapabilitySchema.safeParse('').success).toBe(false);
  });
});

describe('capabilitySatisfies', () => {
  it('matches exact verbs and nothing else', () => {
    expect(capabilitySatisfies(['events:read'], 'events:read')).toBe(true);
    expect(capabilitySatisfies(['events:read'], 'agents:read')).toBe(false);
    expect(capabilitySatisfies([], 'events:read')).toBe(false);
  });

  it('lets a parameterized emit grant unlock the flat emit requirement', () => {
    expect(capabilitySatisfies(['triggers:emit:custom.eval.*'], 'triggers:emit')).toBe(true);
    expect(capabilitySatisfies(['triggers:emit'], 'triggers:emit')).toBe(true);
  });

  it('never lets an emit grant unlock other verbs', () => {
    expect(capabilitySatisfies(['triggers:emit:custom.eval.*'], 'events:read')).toBe(false);
  });
});

describe('emitGrantAllows', () => {
  it('unparameterized grant allows any valid custom event', () => {
    expect(emitGrantAllows(['triggers:emit'], 'custom.anything.here')).toBe(true);
  });

  it('prefix grant allows exactly its prefix', () => {
    const granted = ['triggers:emit:custom.eval.*'];
    expect(emitGrantAllows(granted, 'custom.eval.verdict')).toBe(true);
    expect(emitGrantAllows(granted, 'custom.eval.drift')).toBe(true);
    expect(emitGrantAllows(granted, 'custom.evaluation')).toBe(false);
    expect(emitGrantAllows(granted, 'custom.other.verdict')).toBe(false);
  });

  it('rejects invalid event names regardless of grants', () => {
    expect(emitGrantAllows(['triggers:emit'], 'turn.completed')).toBe(false);
    expect(emitGrantAllows(['triggers:emit'], 'custom.')).toBe(false);
  });

  it('rejects when only non-emit capabilities are granted', () => {
    expect(emitGrantAllows(['events:read', 'agents:write'], 'custom.eval.verdict')).toBe(false);
  });
});

describe('ApiKeyCreateInputSchema', () => {
  it('round-trips a valid input', () => {
    const parsed = ApiKeyCreateInputSchema.parse({
      name: 'ext-evals',
      capabilities: ['conversations:write', 'events:read', 'triggers:emit:custom.eval.*'],
      note: 'evals extension',
      expiresAt: null,
    });
    expect(parsed.name).toBe('ext-evals');
  });

  it('rejects bad names, empty capability lists, and unknown fields', () => {
    expect(ApiKeyCreateInputSchema.safeParse({ name: 'Ext Evals', capabilities: ['events:read'] }).success).toBe(false);
    expect(ApiKeyCreateInputSchema.safeParse({ name: 'ext-evals', capabilities: [] }).success).toBe(false);
    expect(ApiKeyCreateInputSchema.safeParse({ name: 'ext-evals', capabilities: ['events:read'], extra: 1 }).success).toBe(false);
  });
});

describe('API_KEY_TOKEN_PATTERN', () => {
  it('matches the cmk_ + 43 base62 format only', () => {
    expect(API_KEY_TOKEN_PATTERN.test(`cmk_${'a'.repeat(43)}`)).toBe(true);
    expect(API_KEY_TOKEN_PATTERN.test(`cmk_${'a'.repeat(42)}`)).toBe(false);
    expect(API_KEY_TOKEN_PATTERN.test(`cmk_${'a'.repeat(44)}`)).toBe(false);
    expect(API_KEY_TOKEN_PATTERN.test(`ck_${'a'.repeat(43)}`)).toBe(false);
    expect(API_KEY_TOKEN_PATTERN.test(`cmk_${'a'.repeat(42)}!`)).toBe(false);
  });
});
