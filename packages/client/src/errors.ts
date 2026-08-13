import type { z } from 'zod';
import type { CapabilityVerb } from '@ctxmill/contracts';

export type CtxmillContractDirection = 'request' | 'response' | 'stream';

export class CtxmillContractError extends Error {
  readonly direction: CtxmillContractDirection;
  readonly method: string;
  readonly path: string;
  readonly issues: z.core.$ZodIssue[];

  constructor(input: {
    direction: CtxmillContractDirection;
    method: string;
    path: string;
    issues: z.core.$ZodIssue[];
  }) {
    super(`CTXMill ${input.direction} contract failed for ${input.method} ${input.path}`);
    this.name = 'CtxmillContractError';
    this.direction = input.direction;
    this.method = input.method;
    this.path = input.path;
    this.issues = input.issues;
  }
}

export class CtxmillApiError extends Error {
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
    super(`CTXMill API request failed: ${input.method} ${input.path} returned ${input.status}${suffix}`);
    this.name = 'CtxmillApiError';
    this.status = input.status;
    this.code = input.code;
    this.detail = input.detail;
    this.requiredCapability = input.requiredCapability;
    this.body = input.body;
    this.method = input.method;
    this.path = input.path;
  }
}

export class CtxmillTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`CTXMill request timed out after ${timeoutMs}ms`);
    this.name = 'CtxmillTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}
