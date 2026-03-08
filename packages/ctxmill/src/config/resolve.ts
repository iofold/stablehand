import { existsSync } from 'node:fs';
import type { CTXMillConfig, Preset, ResolvedConfig } from './types.js';
import { presets } from './presets.js';

/**
 * Resolve a partial user config into a fully-populated ResolvedConfig
 * by merging user overrides on top of the detected (or specified) preset.
 */
export function resolveConfig(userConfig: CTXMillConfig): ResolvedConfig {
  const preset = userConfig.preset || detectPreset();
  const base = structuredClone(presets[preset]);

  // Per-section shallow merge of user overrides
  if (userConfig.execution) base.execution = { ...base.execution, ...userConfig.execution };
  if (userConfig.database) base.database = { ...base.database, ...userConfig.database };
  if (userConfig.knowledge) {
    const k = userConfig.knowledge;
    if (k.providers) base.knowledge = { ...base.knowledge, providers: k.providers };
  }
  if (userConfig.tools) {
    if (Array.isArray(userConfig.tools)) {
      base.tools = { executors: userConfig.tools };
    } else {
      base.tools = { ...base.tools, ...userConfig.tools };
    }
  }
  if (userConfig.security) base.security = { ...base.security, ...userConfig.security };
  if (userConfig.learning) base.learning = { ...base.learning, ...userConfig.learning };
  if (userConfig.orchestration) base.orchestration = { ...base.orchestration, ...userConfig.orchestration };
  if (userConfig.observability) base.observability = { ...base.observability, ...userConfig.observability };
  if (userConfig.llm) base.llm = { ...base.llm, ...userConfig.llm };

  // Resolve env: references in database URL
  if (base.database.url.startsWith('env:')) {
    base.database.url = process.env[base.database.url.slice(4)] || '';
  }

  // Resolve LLM credentials from environment when not explicitly set
  if (!base.llm.apiKey) {
    base.llm.apiKey = process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || '';
  }
  if (!base.llm.baseUrl) {
    base.llm.baseUrl = process.env.ANTHROPIC_BASE_URL || process.env.OPENAI_BASE_URL || '';
  }

  return base;
}

/**
 * Auto-detect the appropriate preset based on the host environment.
 *  - /dev/kvm present        -> production (Firecracker capable)
 *  - Docker socket present   -> docker
 *  - Otherwise               -> local
 */
function detectPreset(): Preset {
  try {
    if (existsSync('/dev/kvm')) return 'production';
    if (existsSync('/var/run/docker.sock')) return 'docker';
  } catch {
    // Filesystem access may fail in sandboxed environments
  }
  return 'local';
}
