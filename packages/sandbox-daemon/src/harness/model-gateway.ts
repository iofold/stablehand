import { createHash } from 'node:crypto';

import { formatSpendUsd } from '@stablehand/contracts';
import {
  isCertifiedNativeModelGatewayProvider,
  type CanonicalLLMProvider,
  type CertifiedNativeModelGatewayProvider,
} from '@stablehand/shared';
import { resolveModelAuth } from './kit/model-auth.js';
import {
  getModelGatewayRelay,
  type GatewayBudgetRefusal,
} from './model-gateway-relay.js';
import type { AgentEvent, ResolvedSecrets } from './types.js';

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
  /**
   * Loopback relay root to use instead of the gateway root. Defaults to the
   * relay this process registered at startup; null forces the direct root.
   */
  relayUrl?: string | null;
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

  // Route through the in-sandbox relay when one is running, so a budget
  // refusal reaches the client as a terminal error instead of a retried 429.
  const relayUrl = input.relayUrl === undefined
    ? getModelGatewayRelay()?.url
    : input.relayUrl ?? undefined;
  const effectiveRoot = (relayUrl ?? rootUrl).replace(/\/+$/, '');

  if (input.provider === 'openai') {
    return {
      mode: 'gateway',
      provider: 'openai',
      apiKey: runtimeKey,
      baseUrl: `${effectiveRoot}/v1`,
      gatewayRevision: revision,
    };
  }
  return {
    mode: 'gateway',
    provider: input.provider,
    apiKey: runtimeKey,
    baseUrl: effectiveRoot,
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

/** Error code for a model call the gateway refused because the run's budget ran out. */
export const MODEL_GATEWAY_BUDGET_EXCEEDED = 'model_gateway_budget_exceeded';

const BUDGET_REFUSAL_TEXT_PATTERNS: readonly RegExp[] = [
  // The relay's rewritten refusal (GATEWAY_BUDGET_REFUSAL_MESSAGE).
  /Stablehand spend cap reached/,
  // LiteLLM's own refusal text, when a client reached the gateway directly.
  /Budget has been exceeded!/,
  /"type"\s*:\s*"budget_exceeded"/,
];

/** True when an SDK error text is a gateway budget refusal (relayed or raw). */
export function isGatewayBudgetRefusalText(text: string): boolean {
  return BUDGET_REFUSAL_TEXT_PATTERNS.some((pattern) => pattern.test(text));
}


type GatewayBudgetErrorEvent = Extract<AgentEvent, { type: 'error' }>;

export function gatewayBudgetErrorEvent(
  refusal: Pick<GatewayBudgetRefusal, 'spentUsd' | 'capUsd'>,
): GatewayBudgetErrorEvent {
  const amounts = refusal.capUsd !== null
    ? ` (${refusal.spentUsd !== null ? `${formatSpendUsd(refusal.spentUsd)} spent of ` : ''}${formatSpendUsd(refusal.capUsd)})`
    : '';
  return {
    type: 'error',
    error: `Stopped: the model gateway refused further model calls because this run reached its spend cap${amounts}.`,
    code: MODEL_GATEWAY_BUDGET_EXCEEDED,
    details: {
      spentUsd: refusal.spentUsd,
      capUsd: refusal.capUsd,
    },
  };
}

/**
 * The typed terminal error for a turn the gateway stopped for budget, if it
 * did. Consults the relay's record for this turn first (exact numbers), then
 * falls back to recognizing the refusal in the SDK's error text.
 */
export function takeGatewayBudgetStop(
  turnId: string,
  errorText?: string,
): GatewayBudgetErrorEvent | undefined {
  const refusal = getModelGatewayRelay()?.takeBudgetRefusal(toOpaqueTurnCorrelation(turnId));
  if (refusal) return gatewayBudgetErrorEvent(refusal);
  if (errorText !== undefined && isGatewayBudgetRefusalText(errorText)) {
    const amounts = /Current cost:\s*([0-9.eE+-]+),\s*Max budget:\s*([0-9.eE+-]+)/.exec(errorText);
    const spent = amounts ? Number(amounts[1]) : Number.NaN;
    const cap = amounts ? Number(amounts[2]) : Number.NaN;
    return gatewayBudgetErrorEvent({
      spentUsd: Number.isFinite(spent) ? spent : null,
      capUsd: Number.isFinite(cap) ? cap : null,
    });
  }
  return undefined;
}

/** True when the relay already saw a budget refusal for this turn. */
export function hasGatewayBudgetRefusal(turnId: string): boolean {
  return getModelGatewayRelay()?.hasBudgetRefusal(toOpaqueTurnCorrelation(turnId)) ?? false;
}
