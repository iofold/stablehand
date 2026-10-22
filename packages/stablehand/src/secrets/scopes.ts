import type { SecretProvider } from './types.js';

/**
 * Agent secrets live in one of two scopes.
 *
 * - `sandbox` (the default, stored with an empty tool id): injected into the
 *   agent's sandbox as environment variables, for model keys and anything
 *   code inside the sandbox must read.
 * - `tools`: read only by the orchestrator when it calls a tool on the
 *   agent's behalf (HTTP tools, MCP servers). These values never enter the
 *   sandbox env, checkpoints or the runtime fingerprint.
 */
export type SecretScope = 'sandbox' | 'tools';

/** The `tool_id` the `tools` scope is stored under in the secrets table. */
export const TOOL_SECRET_SCOPE_ID = 'tools';

export function secretScopeToolId(scope: SecretScope | undefined): string | undefined {
  return scope === 'tools' ? TOOL_SECRET_SCOPE_ID : undefined;
}

/** A `$secret:NAME` reference, the only form tool auth config accepts. */
export const SECRET_REFERENCE_PATTERN = /^\$secret:([A-Za-z_][A-Za-z0-9_]{0,127})$/;

export function parseSecretReference(value: string): string | undefined {
  return SECRET_REFERENCE_PATTERN.exec(value.trim())?.[1];
}

/**
 * The agent secrets that may enter its sandbox env: the sandbox scope only.
 * Tools-scope secrets are deliberately absent.
 */
export async function readSandboxScopeSecrets(
  secretProvider: SecretProvider,
  agentId: string,
): Promise<Record<string, string>> {
  const keys = await secretProvider.list(agentId);
  const entries = await Promise.all(
    keys.map(async (key): Promise<[string, string | null]> => [key, await secretProvider.get(agentId, key)]),
  );
  return Object.fromEntries(
    entries.filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

/** Read one tools-scope secret; never falls back to the sandbox scope. */
export async function readToolSecret(
  secretProvider: SecretProvider | undefined,
  agentId: string,
  key: string,
): Promise<string | null> {
  if (!secretProvider) return null;
  return secretProvider.get(agentId, key, TOOL_SECRET_SCOPE_ID);
}

/**
 * Every secret a tool may use for this agent: the sandbox scope (legacy HTTP
 * tool behaviour) overlaid by the tools scope, which wins on a name clash.
 */
export async function readAgentToolSecrets(
  secretProvider: SecretProvider | undefined,
  agentId: string,
): Promise<Record<string, string>> {
  if (!secretProvider) return {};
  const secrets: Record<string, string> = await readSandboxScopeSecrets(secretProvider, agentId);
  const toolKeys = await secretProvider.list(agentId, TOOL_SECRET_SCOPE_ID);
  for (const key of toolKeys) {
    const value = await secretProvider.get(agentId, key, TOOL_SECRET_SCOPE_ID);
    if (value !== null) {
      secrets[key] = value;
    }
  }
  return secrets;
}
