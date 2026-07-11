import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import type { SecretProvider } from './types.js';
import { encrypt, decrypt } from './crypto.js';

/**
 * PostgreSQL-backed SecretProvider — every read goes to the database; every
 * write is single-pass. No in-process cache, no boot-time hydration. Master
 * key rotation is handled offline by scripts/reencrypt-secrets.mjs, not at
 * runtime.
 */
export class PostgresSecretProvider implements SecretProvider {
  private readonly sql: postgres.Sql;
  private readonly masterKey: Buffer;

  constructor(sql: postgres.Sql, masterKey: Buffer) {
    this.sql = sql;
    this.masterKey = masterKey;
  }

  async get(agentId: string, key: string, toolId?: string): Promise<string | null> {
    const tid = toolId ?? '';
    const rows = await this.sql`
      SELECT iv, ciphertext, auth_tag FROM secrets
      WHERE agent_id = ${agentId} AND tool_id = ${tid} AND key = ${key}
    `;
    if (rows.length === 0) return null;
    const row = rows[0]!;
    try {
      return decrypt(
        { iv: row.iv as string, ciphertext: row.ciphertext as string, tag: row.auth_tag as string },
        this.masterKey,
      );
    } catch {
      console.warn(
        `[secrets] decrypt failed for agent=${agentId} tool=${tid} key=${key} — ` +
          'likely SECRET_MASTER_KEY mismatch; run scripts/reencrypt-secrets.mjs to rotate stored secrets',
      );
      return null;
    }
  }

  async set(agentId: string, key: string, value: string, toolId?: string): Promise<void> {
    const tid = toolId ?? '';
    const { iv, ciphertext, tag } = encrypt(value, this.masterKey);
    const id = randomUUID();
    await this.sql`
      INSERT INTO secrets (id, agent_id, tool_id, key, iv, ciphertext, auth_tag, created_at, updated_at)
      VALUES (${id}, ${agentId}, ${tid}, ${key}, ${iv}, ${ciphertext}, ${tag}, now(), now())
      ON CONFLICT (agent_id, tool_id, key) DO UPDATE SET
        iv = EXCLUDED.iv,
        ciphertext = EXCLUDED.ciphertext,
        auth_tag = EXCLUDED.auth_tag,
        updated_at = now()
    `;
  }

  async delete(agentId: string, key: string, toolId?: string): Promise<void> {
    const tid = toolId ?? '';
    await this.sql`
      DELETE FROM secrets WHERE agent_id = ${agentId} AND key = ${key} AND tool_id = ${tid}
    `;
  }

  async deleteForAgent(agentId: string): Promise<void> {
    await this.sql`DELETE FROM secrets WHERE agent_id = ${agentId}`;
  }

  async list(agentId: string, toolId?: string): Promise<string[]> {
    const tid = toolId ?? '';
    const rows = await this.sql`
      SELECT key FROM secrets WHERE agent_id = ${agentId} AND tool_id = ${tid}
    `;
    return rows.map((r) => r.key as string);
  }
}
