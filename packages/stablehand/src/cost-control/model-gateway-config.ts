export const MODEL_GATEWAY_SANDBOX_ENV = {
  enabled: 'STABLEHAND_MODEL_GATEWAY_ENABLED',
  url: 'STABLEHAND_MODEL_GATEWAY_URL',
  runtimeKey: 'STABLEHAND_MODEL_GATEWAY_RUNTIME_KEY',
  revision: 'STABLEHAND_MODEL_GATEWAY_REVISION',
} as const;

const MODEL_GATEWAY_SANDBOX_ENV_KEYS: ReadonlySet<string> = new Set(
  Object.values(MODEL_GATEWAY_SANDBOX_ENV),
);

export type ModelGatewayConfig =
  | { enabled: false }
  | {
      enabled: true;
      profile: 'default';
      baseUrl: string;
      runtimeKey: string;
      meteringKey: string;
      revision: string;
      explicitFreeModels: readonly string[];
      sandboxEnvironment: Readonly<Record<string, string>>;
    };

type GatewayEnvironment = Readonly<Record<string, string | undefined>>;

function requireValue(
  env: GatewayEnvironment,
  key: string,
): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`Configuration error: ${key} is required when the model gateway is enabled`);
  }
  return value;
}

function normalizeRootUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Configuration error: STABLEHAND_MODEL_GATEWAY_URL must be an absolute HTTP(S) URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Configuration error: STABLEHAND_MODEL_GATEWAY_URL must use HTTP or HTTPS');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      'Configuration error: STABLEHAND_MODEL_GATEWAY_URL cannot contain credentials, a query, or a fragment',
    );
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error(
      'Configuration error: STABLEHAND_MODEL_GATEWAY_URL must be the gateway root URL; harnesses add protocol-native paths',
    );
  }
  return url.origin;
}

export function resolveModelGatewayConfig(
  env: GatewayEnvironment = process.env,
): ModelGatewayConfig {
  const enabled = env.STABLEHAND_MODEL_GATEWAY_ENABLED?.trim().toLowerCase();
  if (enabled === undefined || enabled === '' || enabled === 'false') {
    return { enabled: false };
  }
  if (enabled !== 'true') {
    throw new Error(
      'Configuration error: STABLEHAND_MODEL_GATEWAY_ENABLED must be "true" or "false"',
    );
  }

  const baseUrl = normalizeRootUrl(requireValue(env, 'STABLEHAND_MODEL_GATEWAY_URL'));
  const runtimeKey = requireValue(env, 'STABLEHAND_MODEL_GATEWAY_RUNTIME_KEY');
  const meteringKey = requireValue(env, 'STABLEHAND_MODEL_GATEWAY_METERING_KEY');
  const revision = requireValue(env, 'STABLEHAND_MODEL_GATEWAY_REVISION');
  const explicitFreeModels = Object.freeze([
    ...new Set(
      (env.STABLEHAND_MODEL_GATEWAY_EXPLICIT_FREE_MODELS ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ]);
  const sandboxEnvironment = Object.freeze({
    [MODEL_GATEWAY_SANDBOX_ENV.enabled]: 'true',
    [MODEL_GATEWAY_SANDBOX_ENV.url]: baseUrl,
    [MODEL_GATEWAY_SANDBOX_ENV.runtimeKey]: runtimeKey,
    [MODEL_GATEWAY_SANDBOX_ENV.revision]: revision,
  });

  return {
    enabled: true,
    profile: 'default',
    baseUrl,
    runtimeKey,
    meteringKey,
    revision,
    explicitFreeModels,
    sandboxEnvironment,
  };
}

export function mergeSandboxSecrets(
  agentAndEnvironmentSecrets: Readonly<Record<string, string>>,
  modelGatewayEnvironment: Readonly<Record<string, string>> = {},
): Readonly<Record<string, string>> {
  const sanitizedEntries = Object.entries(agentAndEnvironmentSecrets)
    .filter(([key]) => !MODEL_GATEWAY_SANDBOX_ENV_KEYS.has(key));
  return Object.freeze({
    ...Object.fromEntries(sanitizedEntries),
    ...modelGatewayEnvironment,
  });
}
