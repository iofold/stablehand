import { z } from 'zod';

/**
 * Minimal LiteLLM virtual-key administration used for per-session gateway
 * keys. Endpoints and semantics verified against LiteLLM 1.93.0 on dev1
 * (2026-10-22):
 *
 * - `/key/generate` returns the secret `key` and its hash `token`; aliases
 *   are unique across keys.
 * - `/key/update` with `spend` resets the key's spend counter immediately
 *   (database and in-memory counter), and `duration` restarts expiry from now.
 * - `/key/delete` accepts `key_aliases`.
 * - A key over its `max_budget` is refused with 429 `budget_exceeded` on
 *   every inference route; `max_budget: 0` refuses the first call.
 *
 * Error messages never include key material.
 */

const GeneratedKeySchema = z.object({
  key: z.string().min(1),
  token: z.string().min(1).optional(),
  token_id: z.string().min(1).optional(),
}).passthrough();

const KeyInfoSchema = z.object({
  info: z.object({
    models: z.array(z.string()).nullish(),
  }).passthrough(),
}).passthrough();

const KeyListSchema = z.object({
  keys: z.array(z.union([
    z.string(),
    z.object({ token: z.string().nullish(), key_alias: z.string().nullish() }).passthrough(),
  ])),
}).passthrough();

export interface LiteLLMKeyClientOptions {
  baseUrl: string;
  adminKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface GenerateSessionKeyInput {
  keyAlias: string;
  /** Model aliases the key may call; an empty list means LiteLLM's "all models". */
  models: readonly string[];
  /** USD; null for no budget. */
  maxBudgetUsd: number | null;
  /** LiteLLM duration string, e.g. "24h". */
  duration: string;
  metadata: Record<string, string>;
}

export interface UpdateSessionKeyInput {
  /** The key's hash (`token`) or its secret. */
  key: string;
  maxBudgetUsd: number | null;
  /** Reset the spend counter to zero, so the new budget applies to this run only. */
  resetSpend: boolean;
  duration: string;
}

export class LiteLLMKeyAdminError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number | null,
    detail: string,
  ) {
    super(`LiteLLM ${operation} failed${status !== null ? ` (HTTP ${status})` : ''}: ${detail}`);
    this.name = 'LiteLLMKeyAdminError';
  }
}

function errorDetail(body: string): string {
  // LiteLLM errors may echo masked keys ("sk-...abcd") or hashes; keep the
  // human message only and drop anything key-shaped.
  let message = body;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown }; detail?: unknown };
    if (typeof parsed.error?.message === 'string') {
      message = parsed.error.message;
    } else if (typeof parsed.detail === 'string') {
      message = parsed.detail;
    }
  } catch {
    message = body;
  }
  return message
    .replace(/sk-[A-Za-z0-9_.-]+/g, 'sk-<redacted>')
    .replace(/\b[a-f0-9]{48,}\b/g, '<hash>')
    .slice(0, 300);
}

export class LiteLLMKeyClient {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: LiteLLMKeyClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async generateKey(input: GenerateSessionKeyInput): Promise<{ key: string; tokenHash: string | null }> {
    const body = await this.request('key/generate', 'POST', '/key/generate', {
      key_alias: input.keyAlias,
      models: [...input.models],
      max_budget: input.maxBudgetUsd,
      duration: input.duration,
      metadata: input.metadata,
    });
    const parsed = GeneratedKeySchema.safeParse(body);
    if (!parsed.success) {
      throw new LiteLLMKeyAdminError('key/generate', null, 'response did not contain a key');
    }
    return { key: parsed.data.key, tokenHash: parsed.data.token ?? parsed.data.token_id ?? null };
  }

  async updateKey(input: UpdateSessionKeyInput): Promise<void> {
    await this.request('key/update', 'POST', '/key/update', {
      key: input.key,
      max_budget: input.maxBudgetUsd,
      duration: input.duration,
      ...(input.resetSpend ? { spend: 0 } : {}),
    });
  }

  /** Delete keys by alias. Already-deleted keys are not an error. */
  async deleteKeysByAlias(aliases: readonly string[]): Promise<void> {
    if (aliases.length === 0) return;
    try {
      await this.request('key/delete', 'POST', '/key/delete', { key_aliases: [...aliases] });
    } catch (err) {
      if (err instanceof LiteLLMKeyAdminError && (err.status === 404 || /not found/i.test(err.message))) {
        return;
      }
      throw err;
    }
  }

  /** The model allowlist of an existing key (e.g. the shared runtime key). */
  async getKeyModels(key: string): Promise<string[]> {
    const query = new URLSearchParams({ key });
    const body = await this.request('key/info', 'GET', `/key/info?${query}`);
    const parsed = KeyInfoSchema.safeParse(body);
    if (!parsed.success) {
      throw new LiteLLMKeyAdminError('key/info', null, 'response did not contain key info');
    }
    return parsed.data.info.models ?? [];
  }

  /** The hash of the key with this alias, if one exists. */
  async findKeyHashByAlias(alias: string): Promise<string | undefined> {
    const query = new URLSearchParams({ key_alias: alias, return_full_object: 'true', size: '1' });
    const body = await this.request('key/list', 'GET', `/key/list?${query}`);
    const parsed = KeyListSchema.safeParse(body);
    if (!parsed.success) {
      throw new LiteLLMKeyAdminError('key/list', null, 'unexpected response shape');
    }
    for (const entry of parsed.data.keys) {
      if (typeof entry === 'string') return entry;
      if (entry.key_alias === alias && entry.token) return entry.token;
    }
    return undefined;
  }

  private async request(
    operation: string,
    method: 'GET' | 'POST',
    path: string,
    payload?: Record<string, unknown>,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.options.adminKey}`,
          ...(payload ? { 'content-type': 'application/json' } : {}),
        },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new LiteLLMKeyAdminError(operation, null, err instanceof Error ? err.message : String(err));
    }
    const text = await response.text();
    if (!response.ok) {
      throw new LiteLLMKeyAdminError(operation, response.status, errorDetail(text));
    }
    if (!text) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new LiteLLMKeyAdminError(operation, response.status, 'response was not JSON');
    }
  }
}
