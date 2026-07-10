import type { CTXMillConfig } from './types.js';

export function resolveDatabaseUrl(userConfig: CTXMillConfig = {}): string {
  const configured = userConfig.database?.url ?? 'env:DATABASE_URL';
  const resolved = configured.startsWith('env:')
    ? process.env[configured.slice(4)] ?? ''
    : configured;

  if (!resolved || resolved.startsWith('env:')) {
    throw new Error(
      `Configuration error: database.url is required. ` +
      `Set the DATABASE_URL environment variable or provide database.url in your config.`,
    );
  }

  return resolved;
}
