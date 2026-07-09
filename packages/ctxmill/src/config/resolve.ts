import type { CTXMillConfig, Preset, ResolvedConfig } from './types.js';
import { presets } from './presets.js';

/**
 * Resolve a partial user config into a fully-populated ResolvedConfig
 * by merging user overrides on top of the docker preset.
 */
export function resolveConfig(userConfig: CTXMillConfig): ResolvedConfig {
  const preset: Preset = 'docker';
  const base = structuredClone(presets[preset]);

  // Per-section shallow merge of user overrides
  if (userConfig.execution) base.execution = { ...base.execution, ...userConfig.execution };
  if (userConfig.database) base.database = { ...base.database, ...userConfig.database };
  if (userConfig.tools) {
    if (Array.isArray(userConfig.tools)) {
      base.tools = { executors: userConfig.tools };
    } else {
      base.tools = { ...base.tools, ...userConfig.tools };
    }
  }
  if (userConfig.security) base.security = { ...base.security, ...userConfig.security };
  if (userConfig.orchestration) base.orchestration = { ...base.orchestration, ...userConfig.orchestration };
  if (userConfig.observability) base.observability = { ...base.observability, ...userConfig.observability };

  // Resolve env: references in database URL
  if (base.database.url.startsWith('env:')) {
    base.database.url = process.env[base.database.url.slice(4)] || '';
  }

  // ── Validate required config ────────────────────────────
  // Database URL is always required (PostgreSQL-only)
  if (!base.database.url || base.database.url.startsWith('env:')) {
    throw new Error(
      `Configuration error: database.url is required. ` +
      `Set the DATABASE_URL environment variable or provide database.url in your config.`,
    );
  }

  return base;
}
