import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import type { SecretProvider } from './types.js';
import { encrypt, decrypt } from './crypto.js';

/**
 * Cached PostgreSQL SecretProvider — loads all secrets into memory on init,
 * provides sync get/list for the runtime, and writes through to PostgreSQL on
 * set/delete. This keeps the public SecretProvider contract synchronous at the
 * call sites that need instant lookup (tool resolution, sandbox secret
 * injection) while avoiding impossible sync-over-async database calls.
 */
export class CachedPostgresSecretProvider implements SecretProvider {
  private readonly sql: postgres.Sql;
  private readonly masterKey: Buffer;
  /** Cache: key = `${agentId}:${toolId}:${key}` -> decrypted value */
  private cache = new Map<string, string>();

  private constructor(sql: postgres.Sql, masterKey: Buffer) {
    this.sql = sql;
    this.masterKey = masterKey;
  }

  static async create(sql: postgres.Sql, masterKey: Buffer): Promise<CachedPostgresSecretProvider> {
    const provider = new CachedPostgresSecretProvider(sql, masterKey);
    await provider.loadCache();
    return provider;
  }

  private cacheKey(agentId: string, toolId: string, key: string): string {
    return `${agentId}:${toolId}:${key}`;
  }

  private async loadCache(): Promise<void> {
    const rows = await this.sql`SELECT agent_id, tool_id, key, iv, ciphertext, auth_tag FROM secrets`;
    for (const row of rows) {
      try {
        const plaintext = decrypt(
          { iv: row.iv as string, ciphertext: row.ciphertext as string, tag: row.auth_tag as string },
          this.masterKey,
        );
        this.cache.set(
          this.cacheKey(row.agent_id as string, row.tool_id as string, row.key as string),
          plaintext,
        );
      } catch {
        // Skip secrets that can't be decrypted (e.g. key rotation)
      }
    }
  }

  get(agentId: string, key: string, toolId?: string): string | null {
    return this.cache.get(this.cacheKey(agentId, toolId ?? '', key)) ?? null;
  }

  async set(agentId: string, key: string, value: string, toolId?: string): Promise<void> {
    const tid = toolId ?? '';
    const { iv, ciphertext, tag } = encrypt(value, this.masterKey);
    this.cache.set(this.cacheKey(agentId, tid, key), value);

    const id = randomUUID();
    try {
      await this.sql`
        INSERT INTO secrets (id, agent_id, tool_id, key, iv, ciphertext, auth_tag, created_at, updated_at)
        VALUES (${id}, ${agentId}, ${tid}, ${key}, ${iv}, ${ciphertext}, ${tag}, now(), now())
        ON CONFLICT (agent_id, tool_id, key) DO UPDATE SET
          iv = EXCLUDED.iv,
          ciphertext = EXCLUDED.ciphertext,
          auth_tag = EXCLUDED.auth_tag,
          updated_at = now()
      `;
    } catch (err) {
      console.error('[PostgresSecretProvider] write error:', err);
      throw err;
    }
  }

  async delete(agentId: string, key: string, toolId?: string): Promise<void> {
    const tid = toolId ?? '';
    this.cache.delete(this.cacheKey(agentId, tid, key));

    try {
      await this.sql`
        DELETE FROM secrets WHERE agent_id = ${agentId} AND key = ${key} AND tool_id = ${tid}
      `;
    } catch (err) {
      console.error('[PostgresSecretProvider] delete error:', err);
      throw err;
    }
  }

  async deleteForAgent(agentId: string): Promise<void> {
    const prefix = `${agentId}:`;
    for (const key of Array.from(this.cache.keys())) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }

    try {
      await this.sql`
        DELETE FROM secrets WHERE agent_id = ${agentId}
      `;
    } catch (err) {
      console.error('[PostgresSecretProvider] deleteForAgent error:', err);
      throw err;
    }
  }

  list(agentId: string, toolId?: string): string[] {
    const tid = toolId ?? '';
    const prefix = `${agentId}:${tid}:`;
    const keys: string[] = [];
    for (const k of this.cache.keys()) {
      if (k.startsWith(prefix)) {
        keys.push(k.slice(prefix.length));
      }
    }
    return keys;
  }
}
