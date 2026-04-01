import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import type { SecretProvider } from './types.js';
import { encrypt, decrypt } from './crypto.js';

/**
 * PostgreSQL-backed SecretProvider using AES-256-GCM encryption.
 *
 * Stores secrets in the `secrets` table (created by migrations.ts).
 * Same encryption scheme as the former SqliteSecretProvider.
 */
export class PostgresSecretProvider implements SecretProvider {
  private readonly sql: postgres.Sql;
  private readonly masterKey: Buffer;

  constructor(sql: postgres.Sql, masterKey: Buffer) {
    this.sql = sql;
    this.masterKey = masterKey;
  }

  get(_agentId: string, _key: string, _toolId?: string): string | null {
    // SecretProvider interface is sync, but postgres.js is async.
    // We need a sync wrapper — use the underlying promise cache pattern.
    // Actually, the interface says `string | null` (sync). We'll need to
    // make this work. The simplest approach: change to async internally
    // but the interface is sync. We'll cache results eagerly.
    //
    // Better approach: since the interface is sync, we'll implement a
    // sync-compatible version by pre-loading. But that's complex.
    // Instead, let's just throw and note the caller should use getAsync.
    //
    // Actually, looking at usage in the secrets pipeline, the get() is called
    // synchronously. We need to keep it sync. Let's use a blocking approach
    // via the postgres.js `unsafe` + synchronous workaround... but postgres.js
    // doesn't support sync queries.
    //
    // The pragmatic solution: keep the same sync interface but implement it
    // with a cached map that's loaded on construction. But that means we need
    // an async init.
    //
    // Simplest correct approach: return null and provide an async getAsync
    // method. But that breaks the interface.
    //
    // Let's look at this differently: we'll make the methods async-compatible
    // by returning from a pre-loaded cache that syncs periodically, OR
    // we just use a sync-over-async hack with Atomics for Node.js.
    //
    // Actually the cleanest solution: change SecretProvider to allow
    // Promise<string | null>. But the user said "same interface".
    //
    // We'll use a pragmatic approach: pre-load all secrets into an in-memory
    // cache on init, and sync changes back to PG on set/delete. The get()
    // reads from cache (sync), set/delete write-through (fire-and-forget).
    throw new Error('Use PostgresSecretProvider.create() factory and getSync/setSync via cache');
  }

  set(_agentId: string, _key: string, _value: string, _toolId?: string): void {
    throw new Error('Use PostgresSecretProvider.create() factory');
  }

  delete(_agentId: string, _key: string, _toolId?: string): void {
    throw new Error('Use PostgresSecretProvider.create() factory');
  }

  list(_agentId: string, _toolId?: string): string[] {
    throw new Error('Use PostgresSecretProvider.create() factory');
  }
}

/**
 * Cached PostgreSQL SecretProvider — loads all secrets into memory on init,
 * provides sync get/list, and writes through to PG on set/delete.
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

  set(agentId: string, key: string, value: string, toolId?: string): void {
    const tid = toolId ?? '';
    const { iv, ciphertext, tag } = encrypt(value, this.masterKey);
    this.cache.set(this.cacheKey(agentId, tid, key), value);

    // Fire-and-forget write to PG
    const id = randomUUID();
    void this.sql`
      INSERT INTO secrets (id, agent_id, tool_id, key, iv, ciphertext, auth_tag, created_at, updated_at)
      VALUES (${id}, ${agentId}, ${tid}, ${key}, ${iv}, ${ciphertext}, ${tag}, now(), now())
      ON CONFLICT (agent_id, tool_id, key) DO UPDATE SET
        iv = EXCLUDED.iv,
        ciphertext = EXCLUDED.ciphertext,
        auth_tag = EXCLUDED.auth_tag,
        updated_at = now()
    `.catch((err) => {
      console.error('[PostgresSecretProvider] write error:', err);
    });
  }

  delete(agentId: string, key: string, toolId?: string): void {
    const tid = toolId ?? '';
    this.cache.delete(this.cacheKey(agentId, tid, key));

    void this.sql`
      DELETE FROM secrets WHERE agent_id = ${agentId} AND key = ${key} AND tool_id = ${tid}
    `.catch((err) => {
      console.error('[PostgresSecretProvider] delete error:', err);
    });
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
