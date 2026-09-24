import { createHash } from 'node:crypto';

import {
  isCertifiedNativeModelGatewayProvider,
  type CanonicalLLMProvider,
  type CertifiedNativeModelGatewayProvider,
} from '@stablehand/shared';
import { resolveModelAuth } from './kit/model-auth.js';
import type { ResolvedSecrets } from './types.js';

const GATEWAY_ENV = {
  enabled: 'STABLEHAND_MODEL_GATEWAY_ENABLED',
  url: 'STABLEHAND_MODEL_GATEWAY_URL',
  runtimeKey: 'STABLEHAND_MODEL_GATEWAY_RUNTIME_KEY',
  revision: 'STABLEHAND_MODEL_GATEWAY_REVISION',
} as const;

export type HarnessModelConnection =
  | {
      mode: 'direct';
      provider: CanonicalLLMProvider;
      apiKey?: string;
      baseUrl?: string;
    }
  | {
      mode: 'gateway';
      provider: CertifiedNativeModelGatewayProvider;
      apiKey: string;
      baseUrl: string;
      gatewayRevision: string;
    };

interface ResolveHarnessModelConnectionInput {
  provider: CanonicalLLMProvider;
  apiKeyRef?: string;
  baseUrl?: string;
  secrets: ResolvedSecrets;
}

function nonEmpty(
  secrets: ResolvedSecrets,
  key: string,
): string | undefined {
  const value = secrets[key]?.trim();
  return value || undefined;
}

function directConnection(
  input: ResolveHarnessModelConnectionInput,
): HarnessModelConnection {
  const { apiKey } = resolveModelAuth({
    provider: input.provider,
    apiKeyRef: input.apiKeyRef,
    secrets: input.secrets,
  });
  return {
    mode: 'direct',
    provider: input.provider,
    ...(apiKey ? { apiKey } : {}),
    ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
  };
}

export function resolveHarnessModelConnection(
  input: ResolveHarnessModelConnectionInput,
): HarnessModelConnection {
  const explicitlyDirect = input.apiKeyRef !== undefined || input.baseUrl !== undefined;
  const gatewayEnabled = nonEmpty(input.secrets, GATEWAY_ENV.enabled) === 'true';
  const gatewayCertified = isCertifiedNativeModelGatewayProvider(
    input.provider,
  );
  if (explicitlyDirect || !gatewayEnabled || !gatewayCertified) {
    return directConnection(input);
  }

  const rootUrl = nonEmpty(input.secrets, GATEWAY_ENV.url);
  const runtimeKey = nonEmpty(input.secrets, GATEWAY_ENV.runtimeKey);
  const revision = nonEmpty(input.secrets, GATEWAY_ENV.revision);
  if (!rootUrl) {
    throw new Error('Model gateway is enabled but its root URL is unavailable');
  }
  if (!runtimeKey) {
    throw new Error('Model gateway is enabled but its runtime credential is unavailable');
  }
  if (!revision) {
    throw new Error('Model gateway is enabled but its credential revision is unavailable');
  }

  if (input.provider === 'openai') {
    return {
      mode: 'gateway',
      provider: 'openai',
      apiKey: runtimeKey,
      baseUrl: `${rootUrl.replace(/\/+$/, '')}/v1`,
      gatewayRevision: revision,
    };
  }
  return {
    mode: 'gateway',
    provider: input.provider,
    apiKey: runtimeKey,
    baseUrl: rootUrl.replace(/\/+$/, ''),
    gatewayRevision: revision,
  };
}

export function toOpaqueTurnCorrelation(turnId: string): string {
  const digest = createHash('sha256').update(turnId).digest('hex').slice(0, 32);
  return `ct_${digest}`;
}

export function createGatewayCorrelationHeaders(
  turnId: string,
): Readonly<Record<string, string>> {
  const correlation = toOpaqueTurnCorrelation(turnId);
  return Object.freeze({
    'x-litellm-trace-id': correlation,
    'x-litellm-spend-logs-metadata': JSON.stringify({
      stablehand_turn_correlation: correlation,
    }),
  });
}
