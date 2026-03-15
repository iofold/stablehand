import { describe, it, expect, beforeEach } from 'vitest';
import { createSqliteDatabase } from '../../packages/ctxmill/src/database/connection.js';
import { SqliteSecretProvider } from '../../packages/ctxmill/src/secrets/sqlite-provider.js';
import { deriveKey } from '../../packages/ctxmill/src/secrets/crypto.js';

describe('SqliteSecretProvider', () => {
  let provider: SqliteSecretProvider;
  let sqliteDb: import('better-sqlite3').Database;
  const masterKey = deriveKey('test-passphrase');

  beforeEach(() => {
    const { sqlite } = createSqliteDatabase(':memory:');
    sqliteDb = sqlite;
    provider = new SqliteSecretProvider(sqlite, masterKey);
  });

  it('should set and get a secret', () => {
    provider.set('agent-1', 'API_KEY', 'sk-secret-123');
    const value = provider.get('agent-1', 'API_KEY');
    expect(value).toBe('sk-secret-123');
  });

  it('should scope secrets per agent', () => {
    provider.set('agent-1', 'TOKEN', 'token-for-agent-1');
    provider.set('agent-2', 'TOKEN', 'token-for-agent-2');

    expect(provider.get('agent-1', 'TOKEN')).toBe('token-for-agent-1');
    expect(provider.get('agent-2', 'TOKEN')).toBe('token-for-agent-2');
  });

  it('should scope secrets per tool', () => {
    provider.set('agent-1', 'API_KEY', 'agent-wide-key');
    provider.set('agent-1', 'API_KEY', 'tool-specific-key', 'tool-email');

    expect(provider.get('agent-1', 'API_KEY')).toBe('agent-wide-key');
    expect(provider.get('agent-1', 'API_KEY', 'tool-email')).toBe('tool-specific-key');
  });

  it('should encrypt values at rest', () => {
    provider.set('agent-1', 'PASSWORD', 'super-secret-password');

    const row = sqliteDb.prepare('SELECT ciphertext FROM secrets WHERE key = ?').get('PASSWORD') as {
      ciphertext: string;
    };
    expect(row.ciphertext).not.toContain('super-secret-password');

    // Also verify the raw row does not contain plaintext in any column
    const fullRow = sqliteDb.prepare('SELECT * FROM secrets WHERE key = ?').get('PASSWORD') as Record<
      string,
      string
    >;
    const allValues = Object.values(fullRow).join(' ');
    expect(allValues).not.toContain('super-secret-password');
  });

  it('should list secret keys without values', () => {
    provider.set('agent-1', 'KEY_A', 'value-a');
    provider.set('agent-1', 'KEY_B', 'value-b');
    provider.set('agent-2', 'KEY_C', 'value-c');

    const keys = provider.list('agent-1');
    expect(keys).toEqual(expect.arrayContaining(['KEY_A', 'KEY_B']));
    expect(keys).not.toContain('KEY_C');
    expect(keys).toHaveLength(2);
  });

  it('should delete secrets', () => {
    provider.set('agent-1', 'TEMP_KEY', 'temporary');
    expect(provider.get('agent-1', 'TEMP_KEY')).toBe('temporary');

    provider.delete('agent-1', 'TEMP_KEY');
    expect(provider.get('agent-1', 'TEMP_KEY')).toBeNull();
  });

  it('should return null for non-existent secrets', () => {
    expect(provider.get('agent-1', 'DOES_NOT_EXIST')).toBeNull();
    expect(provider.get('no-agent', 'KEY')).toBeNull();
    expect(provider.get('agent-1', 'KEY', 'no-tool')).toBeNull();
  });
});
