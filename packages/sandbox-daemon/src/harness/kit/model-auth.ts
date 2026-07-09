import type { CanonicalLLMProvider } from '@ctxmill/shared';

export interface ModelAuthInput {
  provider: CanonicalLLMProvider;
  apiKeyRef?: string;
  secrets: Record<string, string | undefined>;
  env?: Record<string, string | undefined>;
}

export interface ModelAuth {
  provider: CanonicalLLMProvider;
  apiKey?: string;
  apiKeyEnvVar: string;
}

const PROVIDER_API_KEY_ENV: Record<CanonicalLLMProvider, readonly string[]> = {
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  google: ['GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY'],
};

function resolveNamedValue(
  name: string | undefined,
  secrets: Record<string, string | undefined>,
  env: Record<string, string | undefined>,
): string | undefined {
  if (!name) {
    return undefined;
  }

  const key = name.startsWith('$secret:') ? name.slice('$secret:'.length) : name;
  return secrets[key] ?? secrets[name] ?? env[key] ?? env[name];
}

function resolveProviderDefault(
  provider: CanonicalLLMProvider,
  secrets: Record<string, string | undefined>,
  env: Record<string, string | undefined>,
): string | undefined {
  for (const key of PROVIDER_API_KEY_ENV[provider]) {
    const value = secrets[key] ?? env[key];
    if (value) {
      return value;
    }
  }
  return undefined;
}

export function resolveModelAuth(options: ModelAuthInput): ModelAuth {
  const env = options.env ?? process.env;
  const apiKeyEnvVar = PROVIDER_API_KEY_ENV[options.provider][0];
  const explicitApiKey = resolveNamedValue(options.apiKeyRef, options.secrets, env);
  const apiKey = explicitApiKey ?? resolveProviderDefault(options.provider, options.secrets, env);

  return {
    provider: options.provider,
    ...(apiKey ? { apiKey } : {}),
    apiKeyEnvVar,
  };
}
