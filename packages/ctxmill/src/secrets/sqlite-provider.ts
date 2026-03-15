import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { SecretProvider } from './types.js';
import { encrypt, decrypt } from './crypto.js';

export class SqliteSecretProvider implements SecretProvider {
  private readonly db: Database.Database;
  private readonly masterKey: Buffer;

  constructor(db: Database.Database, masterKey: Buffer) {
    this.db = db;
    this.masterKey = masterKey;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS secrets (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        tool_id TEXT NOT NULL DEFAULT '',
        key TEXT NOT NULL,
        iv TEXT NOT NULL,
        ciphertext TEXT NOT NULL,
        auth_tag TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(agent_id, tool_id, key)
      )
    `);
  }

  get(agentId: string, key: string, toolId?: string): string | null {
    const row = this.db.prepare(
      `SELECT iv, ciphertext, auth_tag FROM secrets
       WHERE agent_id = ? AND key = ? AND tool_id = ?`,
    ).get(agentId, key, toolId ?? '') as { iv: string; ciphertext: string; auth_tag: string } | undefined;

    if (!row) return null;

    return decrypt(
      { iv: row.iv, ciphertext: row.ciphertext, tag: row.auth_tag },
      this.masterKey,
    );
  }

  set(agentId: string, key: string, value: string, toolId?: string): void {
    const { iv, ciphertext, tag } = encrypt(value, this.masterKey);
    this.db.prepare(
      `INSERT INTO secrets (id, agent_id, tool_id, key, iv, ciphertext, auth_tag, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(agent_id, tool_id, key) DO UPDATE SET
         iv = excluded.iv,
         ciphertext = excluded.ciphertext,
         auth_tag = excluded.auth_tag,
         updated_at = datetime('now')`,
    ).run(randomUUID(), agentId, toolId ?? '', key, iv, ciphertext, tag);
  }

  delete(agentId: string, key: string, toolId?: string): void {
    this.db.prepare(
      `DELETE FROM secrets WHERE agent_id = ? AND key = ? AND tool_id = ?`,
    ).run(agentId, key, toolId ?? '');
  }

  list(agentId: string, toolId?: string): string[] {
    const rows = this.db.prepare(
      `SELECT DISTINCT key FROM secrets
       WHERE agent_id = ? AND tool_id = ?`,
    ).all(agentId, toolId ?? '') as { key: string }[];

    return rows.map((r) => r.key);
  }
}
