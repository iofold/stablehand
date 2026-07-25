export const CANONICAL_LLM_PROVIDERS = ['openai', 'anthropic', 'google'] as const;

export type CanonicalLLMProvider = typeof CANONICAL_LLM_PROVIDERS[number];

/**
 * Providers whose protocol-native SDK traffic has been certified against the
 * model gateway. Keep this explicit: adding a canonical provider must not
 * silently opt it into gateway routing before its native protocol is tested.
 */
export const CERTIFIED_NATIVE_MODEL_GATEWAY_PROVIDERS = [
  'openai',
  'anthropic',
  'google',
] as const satisfies readonly CanonicalLLMProvider[];

export type CertifiedNativeModelGatewayProvider =
  typeof CERTIFIED_NATIVE_MODEL_GATEWAY_PROVIDERS[number];

export const LLM_PROVIDER_ALIASES = {
  gemini: 'google',
} as const satisfies Record<string, CanonicalLLMProvider>;

const CANONICAL_PROVIDER_SET: ReadonlySet<string> = new Set(CANONICAL_LLM_PROVIDERS);
const CERTIFIED_NATIVE_MODEL_GATEWAY_PROVIDER_SET: ReadonlySet<string> =
  new Set(CERTIFIED_NATIVE_MODEL_GATEWAY_PROVIDERS);

export function isCanonicalLLMProvider(provider: string): provider is CanonicalLLMProvider {
  return CANONICAL_PROVIDER_SET.has(provider);
}

export function isCertifiedNativeModelGatewayProvider(
  provider: string,
): provider is CertifiedNativeModelGatewayProvider {
  return CERTIFIED_NATIVE_MODEL_GATEWAY_PROVIDER_SET.has(provider);
}

export function normalizeLLMProvider(provider: string): CanonicalLLMProvider | undefined {
  const normalized = provider.trim().toLowerCase();
  if (isCanonicalLLMProvider(normalized)) {
    return normalized;
  }
  return LLM_PROVIDER_ALIASES[normalized as keyof typeof LLM_PROVIDER_ALIASES];
}

export function supportedLLMProviderDescription(): string {
  return `${CANONICAL_LLM_PROVIDERS.join(', ')}; aliases: gemini -> google`;
}
