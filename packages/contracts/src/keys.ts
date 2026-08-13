import { z } from 'zod';

import { CUSTOM_EVENT_NAME_PATTERN } from './api.js';

/**
 * Capability vocabulary v1 (WO-5, signed off 2026-08-03). Frozen; additions
 * are minor-version events. `triggers:emit` is the only capability that
 * accepts a parameter: an optional trailing-wildcard prefix constraining
 * emittable custom event types, e.g. `triggers:emit:custom.eval.*`.
 */
export const CAPABILITY_VERBS = [
  'agents:read',
  'agents:write',
  'conversations:write',
  'events:read',
  'interrupts:read',
  'interrupts:resolve',
  'feedback:write',
  'artifacts:read',
  'artifacts:write',
  'webhooks:manage',
  'schedules:manage',
  'triggers:emit',
] as const;

export type CapabilityVerb = (typeof CAPABILITY_VERBS)[number];

export const EMIT_GRANT_PATTERN_SOURCE = String.raw`^triggers:emit:custom\.[a-z0-9][a-z0-9_.-]{0,125}\*$`;
export const EMIT_GRANT_PATTERN = new RegExp(EMIT_GRANT_PATTERN_SOURCE);

const CapabilityVerbSchema = z.enum(CAPABILITY_VERBS);

export const CapabilitySchema = z.string().refine(
  (value) => CapabilityVerbSchema.safeParse(value).success || EMIT_GRANT_PATTERN.test(value),
  'Capability must be one of the v1 verbs, or a triggers:emit grant with a trailing-wildcard custom-event prefix (e.g. triggers:emit:custom.eval.*)',
);

export type Capability = z.infer<typeof CapabilitySchema>;

export function isCapability(value: string): boolean {
  return CapabilitySchema.safeParse(value).success;
}

/**
 * True when the granted capability list unlocks a route requiring `required`.
 * A parameterized `triggers:emit:<prefix>*` grant satisfies the flat
 * `triggers:emit` route requirement; the emit handler then narrows by prefix
 * via `emitGrantAllows`.
 */
export function capabilitySatisfies(granted: readonly string[], required: CapabilityVerb): boolean {
  if (granted.includes(required)) return true;
  if (required === 'triggers:emit') {
    return granted.some((grant) => EMIT_GRANT_PATTERN.test(grant));
  }
  return false;
}

/**
 * True when the granted capability list allows emitting `eventType`.
 * An unparameterized `triggers:emit` grant allows every valid custom event;
 * a `triggers:emit:<prefix>*` grant allows event types starting with prefix.
 */
export function emitGrantAllows(granted: readonly string[], eventType: string): boolean {
  if (!CUSTOM_EVENT_NAME_PATTERN.test(eventType)) return false;
  for (const grant of granted) {
    if (grant === 'triggers:emit') return true;
    if (EMIT_GRANT_PATTERN.test(grant)) {
      const prefix = grant.slice('triggers:emit:'.length, -1);
      if (eventType.startsWith(prefix)) return true;
    }
  }
  return false;
}

export const API_KEY_TOKEN_PREFIX = 'cmk_';
export const API_KEY_TOKEN_PATTERN_SOURCE = String.raw`^cmk_[0-9A-Za-z]{43}$`;
export const API_KEY_TOKEN_PATTERN = new RegExp(API_KEY_TOKEN_PATTERN_SOURCE);

export const ApiKeyNameSchema = z.string().min(1).max(128)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'Key name must be lowercase alphanumeric with hyphens');

export const ApiKeyCreateInputSchema = z.strictObject({
  name: ApiKeyNameSchema,
  capabilities: z.array(CapabilitySchema).min(1).max(32),
  note: z.string().max(1024).optional(),
  expiresAt: z.number().int().positive().nullable().optional(),
}).superRefine((value, ctx) => {
  const duplicate = value.capabilities.find(
    (capability, index) => value.capabilities.indexOf(capability) !== index,
  );
  if (duplicate) {
    ctx.addIssue({
      code: 'custom',
      path: ['capabilities'],
      message: `Capabilities must be unique; duplicate '${duplicate}'`,
    });
  }
  if (value.expiresAt !== null && value.expiresAt !== undefined && value.expiresAt <= Date.now()) {
    ctx.addIssue({
      code: 'custom',
      path: ['expiresAt'],
      message: 'Expiration must be in the future',
    });
  }
});

export type ApiKeyCreateInput = z.infer<typeof ApiKeyCreateInputSchema>;

/** Public shape — never carries the token or its hash. */
export const ApiKeyStatusSchema = z.enum(['active', 'expired', 'revoked']);
export type ApiKeyStatus = z.infer<typeof ApiKeyStatusSchema>;

export const ApiKeySchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  capabilities: z.array(z.string()),
  note: z.string().nullable(),
  status: ApiKeyStatusSchema,
  createdAt: z.number().int(),
  createdBy: z.string().nullable(),
  expiresAt: z.number().int().nullable(),
  lastUsedAt: z.number().int().nullable(),
  revokedAt: z.number().int().nullable(),
});

export type ApiKey = z.infer<typeof ApiKeySchema>;

export const ApiKeyListResponseSchema = z.strictObject({
  keys: z.array(ApiKeySchema),
});

export type ApiKeyListResponse = z.infer<typeof ApiKeyListResponseSchema>;

/** POST /api/keys response — the only time the token is ever shown. */
export const ApiKeyCreatedSchema = ApiKeySchema.extend({
  token: z.string().regex(API_KEY_TOKEN_PATTERN),
});

export type ApiKeyCreated = z.infer<typeof ApiKeyCreatedSchema>;
