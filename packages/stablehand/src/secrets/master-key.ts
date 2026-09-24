export const DEV_FALLBACK_SECRET_MASTER_KEY = 'stablehand-dev-key-change-in-prod';
export const MIN_PRODUCTION_KEY_LENGTH = 16;

export class SecretMasterKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretMasterKeyError';
  }
}

interface SecretMasterKeyLogger {
  warn: (message: string) => void;
}

type SecretMasterKeyEnv = Readonly<Record<string, string | undefined>>;

function isProduction(env: SecretMasterKeyEnv): boolean {
  return env.NODE_ENV === 'production';
}

function fatalMessage(reason: string): string {
  return [
    `FATAL: SECRET_MASTER_KEY ${reason} when NODE_ENV=production.`,
    'Set SECRET_MASTER_KEY to a strong unique value before starting Stablehand.',
    'Generate one with: openssl rand -hex 32',
  ].join(' ');
}

function warnDevelopmentFallback(logger: SecretMasterKeyLogger): void {
  logger.warn([
    '',
    'WARNING: SECRET_MASTER_KEY is not set; using the development fallback key.',
    'This is only acceptable outside NODE_ENV=production.',
    'Generate a real key with: openssl rand -hex 32',
    '',
  ].join('\n'));
}

export function resolveSecretMasterKeyPassphrase(
  env: SecretMasterKeyEnv = process.env,
  logger: SecretMasterKeyLogger = console,
): string {
  const rawKey = env.SECRET_MASTER_KEY;
  const key = rawKey ?? '';
  const normalizedKey = key.trim();

  if (isProduction(env)) {
    if (!normalizedKey) {
      throw new SecretMasterKeyError(fatalMessage('must be set'));
    }
    if (normalizedKey === DEV_FALLBACK_SECRET_MASTER_KEY) {
      throw new SecretMasterKeyError(fatalMessage('must not use the development fallback key'));
    }
    if (normalizedKey.length < MIN_PRODUCTION_KEY_LENGTH) {
      throw new SecretMasterKeyError(
        fatalMessage(`must be at least ${MIN_PRODUCTION_KEY_LENGTH} characters long`),
      );
    }
    return key;
  }

  if (!normalizedKey || normalizedKey === DEV_FALLBACK_SECRET_MASTER_KEY) {
    warnDevelopmentFallback(logger);
    return DEV_FALLBACK_SECRET_MASTER_KEY;
  }

  return key;
}
