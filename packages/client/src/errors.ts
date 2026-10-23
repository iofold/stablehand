import type { z } from 'zod';
import type { CapabilityVerb } from '@stablehand/contracts';

export type StablehandContractDirection = 'request' | 'response' | 'stream';

export class StablehandContractError extends Error {
  readonly direction: StablehandContractDirection;
  readonly method: string;
  readonly path: string;
  readonly issues: z.core.$ZodIssue[];

  constructor(input: {
    direction: StablehandContractDirection;
    method: string;
    path: string;
    issues: z.core.$ZodIssue[];
  }) {
    super(`Stablehand ${input.direction} contract failed for ${input.method} ${input.path}`);
    this.name = 'StablehandContractError';
    this.direction = input.direction;
    this.method = input.method;
    this.path = input.path;
    this.issues = input.issues;
  }
}

export class StablehandApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly detail?: string;
  readonly requiredCapability?: CapabilityVerb | null;
  readonly body: unknown;
  readonly method: string;
  readonly path: string;

  constructor(input: {
    status: number;
    code?: string;
    detail?: string;
    requiredCapability?: CapabilityVerb | null;
    body: unknown;
    method: string;
    path: string;
  }) {
    const suffix = input.code ? ` (${input.code})` : '';
    super(`Stablehand API request failed: ${input.method} ${input.path} returned ${input.status}${suffix}`);
    this.name = 'StablehandApiError';
    this.status = input.status;
    this.code = input.code;
    this.detail = input.detail;
    this.requiredCapability = input.requiredCapability;
    this.body = input.body;
    this.method = input.method;
    this.path = input.path;
  }
}

export class StablehandTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number, message?: string) {
    super(message ?? `Stablehand request timed out after ${timeoutMs}ms`);
    this.name = 'StablehandTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}
