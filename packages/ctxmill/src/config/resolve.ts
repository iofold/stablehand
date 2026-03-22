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

  // Resolve LLM credentials from environment when not explicitly set.
  // This key is only used by the learning pipeline reflector (OpenAI-compatible).
  // Individual agent harnesses resolve their own keys from the secrets pipeline.
  if (!base.llm.apiKey) {
    base.llm.apiKey = process.env.OPENAI_API_KEY || '';
  }
  if (!base.llm.baseUrl) {
    base.llm.baseUrl = process.env.OPENAI_BASE_URL || '';
  }

  // ── Max global containers ─────────────────────────────────
  // Environment variable takes precedence over config file
  const envMaxContainers = process.env.CTXMILL_MAX_CONTAINERS;
  if (envMaxContainers) {
    const parsed = parseInt(envMaxContainers, 10);
    if (isNaN(parsed) || parsed < 1) {
      throw new Error(
        `Configuration error: invalid CTXMILL_MAX_CONTAINERS "${envMaxContainers}". ` +
        `Must be a positive integer.`,
      );
    }
    base.execution.maxGlobalContainers = parsed;
  }

  // ── Validate required config ────────────────────────────
  // Database URL is always required (PostgreSQL-only)
  if (!base.database.url || base.database.url.startsWith('env:')) {
    throw new Error(
      `Configuration error: database.url is required. ` +
      `Set the DATABASE_URL environment variable or provide database.url in your config.`,
    );
  }

  // LLM API key is optional at the global level.
  // It powers the learning pipeline reflector (OpenAI-compatible).
  // Individual agent harnesses resolve their own keys from the secrets pipeline
  // (env vars + per-agent DB secrets), so the system runs fine without a global key.
  // The learning pipeline will gracefully skip reflection if no key is configured.

  return base;
}
