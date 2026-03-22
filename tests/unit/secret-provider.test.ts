import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { CachedPostgresSecretProvider } from '../../packages/ctxmill/src/secrets/postgres-provider.js';
import { deriveKey } from '../../packages/ctxmill/src/secrets/crypto.js';
import { createTestDb, type TestDb } from '../utils/test-db.js';

describe('CachedPostgresSecretProvider', () => {
  let provider: CachedPostgresSecretProvider;
  let testDb: TestDb;
  const masterKey = deriveKey('test-passphrase');

  beforeAll(async () => {
    testDb = await createTestDb();
    provider = await CachedPostgresSecretProvider.create(testDb.conn.pgClient, masterKey);
  });

  afterAll(async () => {
    await testDb.close();
  });

  it('should set and get a secret', async () => {
    provider.set('agent-1', 'API_KEY', 'sk-secret-123');
    // Allow write-through to complete
    await new Promise((r) => setTimeout(r, 50));
    const value = provider.get('agent-1', 'API_KEY');
    expect(value).toBe('sk-secret-123');
  });

  it('should scope secrets per agent', async () => {
    provider.set('agent-1', 'TOKEN', 'token-for-agent-1');
    provider.set('agent-2', 'TOKEN', 'token-for-agent-2');

    expect(provider.get('agent-1', 'TOKEN')).toBe('token-for-agent-1');
    expect(provider.get('agent-2', 'TOKEN')).toBe('token-for-agent-2');
  });

  it('should scope secrets per tool', async () => {
    provider.set('agent-1', 'API_KEY_TOOL', 'agent-wide-key');
    provider.set('agent-1', 'API_KEY_TOOL', 'tool-specific-key', 'tool-email');

    expect(provider.get('agent-1', 'API_KEY_TOOL')).toBe('agent-wide-key');
    expect(provider.get('agent-1', 'API_KEY_TOOL', 'tool-email')).toBe('tool-specific-key');
  });

  it('should encrypt values at rest', async () => {
    provider.set('agent-1', 'PASSWORD', 'super-secret-password');
    // Allow write-through to complete
    await new Promise((r) => setTimeout(r, 100));

    const rows = await testDb.conn.pgClient`
      SELECT ciphertext FROM secrets WHERE key = 'PASSWORD' AND agent_id = 'agent-1' AND tool_id = ''
    `;
    expect(rows.length).toBe(1);
    expect(rows[0].ciphertext).not.toContain('super-secret-password');
  });

  it('should list secret keys without values', async () => {
    provider.set('agent-list', 'KEY_A', 'value-a');
    provider.set('agent-list', 'KEY_B', 'value-b');
    provider.set('agent-list-2', 'KEY_C', 'value-c');

    const keys = provider.list('agent-list');
    expect(keys).toEqual(expect.arrayContaining(['KEY_A', 'KEY_B']));
    expect(keys).not.toContain('KEY_C');
    expect(keys).toHaveLength(2);
  });

  it('should delete secrets', async () => {
    provider.set('agent-del', 'TEMP_KEY', 'temporary');
    expect(provider.get('agent-del', 'TEMP_KEY')).toBe('temporary');

    provider.delete('agent-del', 'TEMP_KEY');
    expect(provider.get('agent-del', 'TEMP_KEY')).toBeNull();
  });

  it('should return null for non-existent secrets', () => {
    expect(provider.get('agent-1', 'DOES_NOT_EXIST')).toBeNull();
    expect(provider.get('no-agent', 'KEY')).toBeNull();
    expect(provider.get('agent-1', 'KEY', 'no-tool')).toBeNull();
  });
});
