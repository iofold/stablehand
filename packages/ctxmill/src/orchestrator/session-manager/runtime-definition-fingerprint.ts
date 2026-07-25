import { createHash } from 'node:crypto';
import { isCertifiedNativeModelGatewayProvider } from '@ctxmill/shared';

export type RuntimeDefinitionFingerprintContext = {
  gateway:
    | { enabled: false }
    | {
        enabled: true;
        profile: string;
        revision: string;
      };
  agentSecretRevision: string;
};

type RuntimeDefinitionShape = {
  name: string;
  harness?: string;
  harnessConfig: Record<string, unknown>;
  systemPrompt: string;
  tools: string[];
  description?: string;
  metadata?: Record<string, unknown>;
  workspaceDir?: string;
  projectDir?: string;
  resourceLimits?: unknown;
  builtinToolPolicy?: unknown;
  nativeToolPolicy?: unknown;
  workspaceContent?: unknown;
  mode?: unknown;
};

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

function canonicalize(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined;
  if (
    value === null
    || typeof value === 'boolean'
    || typeof value === 'string'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Runtime definition contains a non-finite number');
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry) ?? null);
  }
  if (typeof value === 'object') {
    const output: Record<string, JsonValue> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const normalized = canonicalize(
        (value as Record<string, unknown>)[key],
      );
      if (normalized !== undefined) output[key] = normalized;
    }
    return output;
  }
  throw new Error(
    `Runtime definition contains unsupported ${typeof value} value`,
  );
}

function stringField(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const candidate = value[key];
  return typeof candidate === 'string' && candidate.length > 0
    ? candidate
    : undefined;
}

function collectConnectionModes(
  harness: string,
  config: Record<string, unknown>,
  context: RuntimeDefinitionFingerprintContext,
): Array<{
  path: string;
  provider: string;
  mode: 'direct' | 'gateway';
}> {
  const modes: Array<{
    path: string;
    provider: string;
    mode: 'direct' | 'gateway';
  }> = [];
  const rootProvider = stringField(config, 'provider')
    ?? (harness === 'claude-agents' ? 'anthropic' : 'unknown');

  const add = (
    path: string,
    branch: Record<string, unknown>,
    fallbackProvider: string,
  ): void => {
    const provider = stringField(branch, 'provider') ?? fallbackProvider;
    const explicitlyDirect =
      stringField(branch, 'apiKeyRef') !== undefined
      || stringField(branch, 'baseUrl') !== undefined;
    const gatewayCertified = isCertifiedNativeModelGatewayProvider(provider);
    modes.push({
      path,
      provider,
      mode: context.gateway.enabled
        && gatewayCertified
        && !explicitlyDirect
        ? 'gateway'
        : 'direct',
    });
  };

  add('root', config, rootProvider);
  const subagents = config.subagents;
  if (Array.isArray(subagents)) {
    subagents.forEach((candidate, index) => {
      if (candidate && typeof candidate === 'object') {
        add(
          `subagents[${index}]`,
          candidate as Record<string, unknown>,
          rootProvider,
        );
      }
    });
  } else if (subagents && typeof subagents === 'object') {
    for (const [name, candidate] of Object.entries(subagents).sort(
      ([left], [right]) => left.localeCompare(right),
    )) {
      if (candidate && typeof candidate === 'object') {
        add(
          `subagents.${name}`,
          candidate as Record<string, unknown>,
          rootProvider,
        );
      }
    }
  }
  return modes;
}

/**
 * Hash only non-secret determinants of an open sandbox runtime.
 *
 * The hash changes when execution configuration, effective direct/gateway
 * connection behavior, the deployment gateway revision, or agent-secret
 * metadata changes. Credential values are deliberately not accepted.
 */
export function createRuntimeDefinitionFingerprint(
  agentDefinition: RuntimeDefinitionShape,
  context: RuntimeDefinitionFingerprintContext,
): string {
  const harness = agentDefinition.harness ?? 'langgraph';
  const payload = canonicalize({
    schema: 1,
    execution: agentDefinition,
    connectionModes: collectConnectionModes(
      harness,
      agentDefinition.harnessConfig,
      context,
    ),
    gateway: context.gateway,
    agentSecretRevision: context.agentSecretRevision,
  });
  return createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex');
}
