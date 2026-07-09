export const CANONICAL_LLM_PROVIDERS = ['openai', 'anthropic', 'google'] as const;

export type CanonicalLLMProvider = typeof CANONICAL_LLM_PROVIDERS[number];

export const LLM_PROVIDER_ALIASES = {
  gemini: 'google',
} as const satisfies Record<string, CanonicalLLMProvider>;

const CANONICAL_PROVIDER_SET: ReadonlySet<string> = new Set(CANONICAL_LLM_PROVIDERS);

export function isCanonicalLLMProvider(provider: string): provider is CanonicalLLMProvider {
  return CANONICAL_PROVIDER_SET.has(provider);
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
