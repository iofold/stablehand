import type { CTXMillConfig } from './types.js';

export function defineConfig(config: CTXMillConfig): CTXMillConfig {
  return config;
}

export type { CTXMillConfig, ResolvedConfig, Preset } from './types.js';
export { presets } from './presets.js';
export { resolveConfig } from './resolve.js';
export { createContainer } from './container.js';
export type { AppContainer } from './container.js';
