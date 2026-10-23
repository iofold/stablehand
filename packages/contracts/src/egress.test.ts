import { describe, expect, it } from 'vitest';

import {
  AgentCreateInputSchema,
  AgentPatchInputSchema,
  AgentSchema,
} from './api.js';
import {
  AgentEgressSchema,
  EGRESS_RULES_MAX,
  EgressLeaseResponseSchema,
  parseEgressRule,
} from './egress.js';

describe('parseEgressRule', () => {
  it('accepts the proxy grammar', () => {
    expect(parseEgressRule('GET *')).toEqual({
      ok: true,
      rule: { method: 'GET', host: '*', path: '/**' },
    });
    expect(parseEgressRule('  * API.Example.com:8443/v1/** ')).toEqual({
      ok: true,
      rule: { method: '*', host: 'api.example.com', port: 8443, path: '/v1/**' },
    });
    expect(parseEgressRule('head *.githubusercontent.com/*/raw/**')).toEqual({
      ok: true,
      rule: { method: 'HEAD', host: '*.githubusercontent.com', path: '/*/raw/**' },
    });
    expect(parseEgressRule('POST 203.0.113.7/hook').ok).toBe(true);
  });

  it('rejects anything the proxy would not read the same way', () => {
    const rejected = [
      '',
      'GET',
      'GET  ',
      '* * !internal',
      '* ollama:11434/** !internal',
      'GET api.example.com # comment',
      'GET a.example.com;* b.example.com',
      'GET a*b.example.com',
      'GET -bad.example.com',
      'GET api.example.com:0',
      'GET api.example.com:70000',
      'GET api.example.com/a b',
      'GET http://api.example.com/',
      'G3T api.example.com',
      'GET [::1]',
      `GET ${'a'.repeat(600)}.com`,
      'GET api.example.com/\u0000',
    ];
    for (const rule of rejected) {
      expect(parseEgressRule(rule).ok, JSON.stringify(rule)).toBe(false);
    }
  });

  it('explains why !internal is refused', () => {
    const parsed = parseEgressRule('* minio:9000/** !internal');
    expect(parsed).toMatchObject({ ok: false });
    expect(parsed.ok ? '' : parsed.error).toMatch(/server's rule files/);
  });
});

describe('AgentEgressSchema', () => {
  it('accepts each mode in its valid shape', () => {
    for (const egress of [
      { mode: 'default' },
      { mode: 'default', rules: [] },
      { mode: 'deny' },
      { mode: 'deny', rules: ['GET pypi.org/simple/**'] },
      { mode: 'allow', rules: ['GET *', 'HEAD *'] },
    ]) {
      expect(AgentEgressSchema.parse(egress)).toEqual(egress);
    }
  });

  it('rejects rules that cannot apply and unknown fields', () => {
    const invalid: unknown[] = [
      { mode: 'default', rules: ['GET *'] },
      { mode: 'allow' },
      { mode: 'allow', rules: [] },
      { mode: 'open' },
      { mode: 'deny', rules: ['* * !internal'] },
      { mode: 'deny', extra: true },
      { mode: 'allow', rules: Array.from({ length: EGRESS_RULES_MAX + 1 }, () => 'GET *') },
      { rules: ['GET *'] },
    ];
    for (const egress of invalid) {
      expect(AgentEgressSchema.safeParse(egress).success, JSON.stringify(egress).slice(0, 80)).toBe(false);
    }
  });

  it('is part of the agent create, update and response contracts', () => {
    const base = {
      name: 'solver',
      harness: 'pi-agent',
      harnessConfig: { model: 'gpt-5.4-mini' },
      systemPrompt: 'Fix the bug.',
      tools: [],
    };
    expect(AgentCreateInputSchema.parse({ ...base, egress: { mode: 'deny' } }).egress).toEqual({ mode: 'deny' });
    expect(AgentCreateInputSchema.safeParse({ ...base, egress: { mode: 'allow' } }).success).toBe(false);
    expect(AgentPatchInputSchema.parse({ egress: null })).toEqual({ egress: null });
    expect(AgentPatchInputSchema.parse({ egress: { mode: 'allow', rules: ['GET *'] } }).egress)
      .toEqual({ mode: 'allow', rules: ['GET *'] });
    expect(AgentSchema.shape.egress.safeParse(null).success).toBe(true);
    expect(AgentSchema.shape.egress.safeParse(undefined).success).toBe(false);
  });

  it('describes the lease answer the egress proxy consumes', () => {
    const answer = {
      sessionId: '3e98a63a-5c88-4f1d-80bd-a1d636545c4b',
      agentId: 'agent-1',
      egress: { mode: 'deny' },
      runtimeRules: ['* s3.example.com/**'],
      ttlSeconds: 30,
    };
    expect(EgressLeaseResponseSchema.parse(answer)).toEqual(answer);
    expect(EgressLeaseResponseSchema.safeParse({ ...answer, runtimeRules: ['* minio/** !internal'] }).success)
      .toBe(false);
  });
});
