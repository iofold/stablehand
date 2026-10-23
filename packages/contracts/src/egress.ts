import { z } from 'zod';

/**
 * Per-agent sandbox egress (ctx-3aef).
 *
 * - `default`: the server's egress allowlist (what every sandbox got before per-agent rules).
 * - `deny`: only what the runtime itself needs (the model provider or gateway, the artifact
 *   store), plus `rules` when given. Nothing from the server's allowlist.
 * - `allow`: the server's allowlist plus `rules`.
 *
 * Rules use the egress proxy grammar: `<METHOD|*> <host-glob>[:<port>][/<path-glob>]`, e.g.
 * `GET *` (read-only access to any public host) or `* api.example.com/v1/**`. Private and
 * internal destinations stay closed to agent rules; only the operator's rule files can open them.
 */
export const EGRESS_MODES = ['default', 'deny', 'allow'] as const;
export const EGRESS_RULES_MAX = 200;
export const EGRESS_RULE_MAX_LENGTH = 512;

export const EgressModeSchema = z.enum(EGRESS_MODES);

export interface ParsedEgressRule {
  method: string;
  host: string;
  port?: number;
  path: string;
}

export type EgressRuleParseResult =
  | { ok: true; rule: ParsedEgressRule }
  | { ok: false; error: string };

const RULE_PATTERN = /^(?<method>\*|[A-Za-z]+)\s+(?<host>[^\s:/]+)(?::(?<port>\d{1,5}))?(?<path>\/\S*)?$/;
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function isHostname(value: string): boolean {
  if (value.length > 253) return false;
  return value.split('.').every((label) => HOST_LABEL.test(label));
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

/** Parse one agent egress rule. The proxy re-checks every rule it receives. */
export function parseEgressRule(input: string): EgressRuleParseResult {
  const text = input.trim();
  if (text.length === 0) return { ok: false, error: 'Egress rule is empty' };
  if (text.length > EGRESS_RULE_MAX_LENGTH) {
    return { ok: false, error: `Egress rule is longer than ${EGRESS_RULE_MAX_LENGTH} characters` };
  }
  if (hasControlCharacter(text) || text.includes('#') || text.includes(';')) {
    return { ok: false, error: 'Egress rule must not contain control characters, "#" or ";"' };
  }
  if (/(^|\s)!/.test(text)) {
    return {
      ok: false,
      error: 'Egress rule flags such as !internal are only available in the server\'s rule files',
    };
  }
  const match = RULE_PATTERN.exec(text);
  const groups = match?.groups;
  if (!groups?.method || !groups.host) {
    return {
      ok: false,
      error: 'Egress rule must look like "<METHOD|*> <host>[:<port>][/<path>]", e.g. "GET *" or "* api.example.com/v1/**"',
    };
  }
  const host = groups.host.toLowerCase();
  const wildcardHost = host === '*';
  const subdomainHost = host.startsWith('*.') && isHostname(host.slice(2));
  if (!wildcardHost && !subdomainHost && !isHostname(host)) {
    return { ok: false, error: `Egress rule host "${groups.host}" must be "*", "*.<domain>" or a hostname` };
  }
  let port: number | undefined;
  if (groups.port !== undefined) {
    port = Number(groups.port);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      return { ok: false, error: `Egress rule port ${groups.port} is out of range` };
    }
  }
  return {
    ok: true,
    rule: {
      method: groups.method.toUpperCase(),
      host,
      ...(port !== undefined ? { port } : {}),
      path: groups.path ?? '/**',
    },
  };
}

export const EgressRuleSchema = z.string().superRefine((value, context) => {
  const parsed = parseEgressRule(value);
  if (!parsed.ok) {
    context.addIssue({ code: 'custom', message: parsed.error });
  }
});

export const AgentEgressSchema = z.strictObject({
  mode: EgressModeSchema,
  rules: z.array(EgressRuleSchema).max(EGRESS_RULES_MAX).optional(),
}).superRefine((egress, context) => {
  const ruleCount = egress.rules?.length ?? 0;
  if (egress.mode === 'default' && ruleCount > 0) {
    context.addIssue({
      code: 'custom',
      path: ['rules'],
      message: 'rules apply only to egress mode "allow" or "deny"; mode "default" uses the server allowlist as is',
    });
  }
  if (egress.mode === 'allow' && ruleCount === 0) {
    context.addIssue({
      code: 'custom',
      path: ['rules'],
      message: 'egress mode "allow" needs at least one rule to add to the server allowlist',
    });
  }
});

/** What the egress proxy sends to check a sandbox's session lease. */
export const EgressLeaseRequestSchema = z.strictObject({
  sessionId: z.string().min(1).max(128),
  token: z.string().min(1).max(512),
});

/** The orchestrator's answer for a valid lease: the session's egress setting. */
export const EgressLeaseResponseSchema = z.strictObject({
  sessionId: z.string().min(1),
  agentId: z.string().min(1),
  egress: AgentEgressSchema,
  /** Runtime endpoints the sandbox reaches through the proxy (model gateway, artifact store). */
  runtimeRules: z.array(EgressRuleSchema),
  ttlSeconds: z.number().int().positive(),
});

export type EgressMode = z.infer<typeof EgressModeSchema>;
export type AgentEgress = z.infer<typeof AgentEgressSchema>;
export type EgressLeaseRequest = z.infer<typeof EgressLeaseRequestSchema>;
export type EgressLeaseResponse = z.infer<typeof EgressLeaseResponseSchema>;
