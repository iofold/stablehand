import type { CTXMillConfig } from './types.js';

export function defineConfig<T extends CTXMillConfig>(config: T): T {
  return config;
}

export type { CTXMillConfig } from './types.js';
export { resolveDatabaseUrl } from './resolve.js';
export { createContainer } from './container.js';
export type { AppContainer } from './container.js';
