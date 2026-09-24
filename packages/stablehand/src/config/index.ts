import type { StablehandConfig } from './types.js';

export function defineConfig<T extends StablehandConfig>(config: T): T {
  return config;
}

export type { StablehandConfig } from './types.js';
export { resolveDatabaseUrl } from './resolve.js';
export { createContainer } from './container.js';
export type { AppContainer } from './container.js';
