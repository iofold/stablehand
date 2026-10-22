import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PostgresSecretProvider } from '../../packages/stablehand/src/secrets/postgres-provider.js';
import { deriveKey } from '../../packages/stablehand/src/secrets/crypto.js';
import {
  TOOL_SECRET_SCOPE_ID,
  readAgentToolSecrets,
  readSandboxScopeSecrets,
  readToolSecret,
} from '../../packages/stablehand/src/secrets/scopes.js';
import { createTestDb, type TestDb } from '../utils/test-db.js';

describe('PostgresSecretProvider', () => {
  let provider: PostgresSecretProvider;
  let testDb: TestDb;
  const masterKey = deriveKey('test-passphrase');

  beforeAll(async () => {
    testDb = await createTestDb();
    provider = new PostgresSecretProvider(testDb.conn.pgClient, masterKey);
  });

  afterAll(async () => {
    await testDb.close();
  });

  it('should set and get a secret', async () => {
    await provider.set('agent-1', 'API_KEY', 'sk-secret-123');
    const value = await provider.get('agent-1', 'API_KEY');
    expect(value).toBe('sk-secret-123');
  });

  it('should scope secrets per agent', async () => {
    await provider.set('agent-1', 'TOKEN', 'token-for-agent-1');
    await provider.set('agent-2', 'TOKEN', 'token-for-agent-2');

    await expect(provider.get('agent-1', 'TOKEN')).resolves.toBe('token-for-agent-1');
    await expect(provider.get('agent-2', 'TOKEN')).resolves.toBe('token-for-agent-2');
  });

  it('should scope secrets per tool', async () => {
    await provider.set('agent-1', 'API_KEY_TOOL', 'agent-wide-key');
    await provider.set('agent-1', 'API_KEY_TOOL', 'tool-specific-key', 'tool-email');

    await expect(provider.get('agent-1', 'API_KEY_TOOL')).resolves.toBe('agent-wide-key');
    await expect(provider.get('agent-1', 'API_KEY_TOOL', 'tool-email')).resolves.toBe('tool-specific-key');
  });

  it('should encrypt values at rest', async () => {
    await provider.set('agent-1', 'PASSWORD', 'super-secret-password');

    const rows = await testDb.conn.pgClient`
      SELECT ciphertext FROM secrets WHERE key = 'PASSWORD' AND agent_id = 'agent-1' AND tool_id = ''
    `;
    expect(rows.length).toBe(1);
    expect(rows[0].ciphertext).not.toContain('super-secret-password');
  });

  it('should list secret keys without values', async () => {
    await provider.set('agent-list', 'KEY_A', 'value-a');
    await provider.set('agent-list', 'KEY_B', 'value-b');
    await provider.set('agent-list-2', 'KEY_C', 'value-c');

    const keys = await provider.list('agent-list');
    expect(keys).toEqual(expect.arrayContaining(['KEY_A', 'KEY_B']));
    expect(keys).not.toContain('KEY_C');
    expect(keys).toHaveLength(2);
  });

  it('should delete secrets', async () => {
    await provider.set('agent-del', 'TEMP_KEY', 'temporary');
    await expect(provider.get('agent-del', 'TEMP_KEY')).resolves.toBe('temporary');

    await provider.delete('agent-del', 'TEMP_KEY');
    await expect(provider.get('agent-del', 'TEMP_KEY')).resolves.toBeNull();
  });

  it('should return null for non-existent secrets', async () => {
    await expect(provider.get('agent-1', 'DOES_NOT_EXIST')).resolves.toBeNull();
    await expect(provider.get('no-agent', 'KEY')).resolves.toBeNull();
    await expect(provider.get('agent-1', 'KEY', 'no-tool')).resolves.toBeNull();
  });

  describe('tools scope', () => {
    it('keeps tools-scope secrets out of the sandbox env and out of the runtime revision', async () => {
      await provider.set('agent-scope', 'OPENAI_API_KEY', 'sk-model');
      const before = await provider.revision('agent-scope');

      await provider.set('agent-scope', 'APIFY_TOKEN', 'apify-token-value', TOOL_SECRET_SCOPE_ID);
      await provider.set('agent-scope', 'MCP_OAUTH__granola', '{"tokens":{}}', TOOL_SECRET_SCOPE_ID);

      const sandbox = await readSandboxScopeSecrets(provider, 'agent-scope');
      expect(sandbox).toEqual({ OPENAI_API_KEY: 'sk-model' });
      expect(JSON.stringify(sandbox)).not.toContain('apify-token-value');
      // Rotating a tool token must not restart a warm sandbox.
      expect(await provider.revision('agent-scope')).toBe(before);

      await expect(readToolSecret(provider, 'agent-scope', 'APIFY_TOKEN')).resolves.toBe('apify-token-value');
      // Tool secrets never fall back to the sandbox scope.
      await expect(readToolSecret(provider, 'agent-scope', 'OPENAI_API_KEY')).resolves.toBeNull();
    });

    it('overlays tools-scope secrets on the sandbox scope for HTTP tools', async () => {
      await provider.set('agent-overlay', 'API_KEY', 'sandbox-value');
      await provider.set('agent-overlay', 'API_KEY', 'tools-value', TOOL_SECRET_SCOPE_ID);
      await provider.set('agent-overlay', 'ONLY_TOOLS', 'x', TOOL_SECRET_SCOPE_ID);

      await expect(readAgentToolSecrets(provider, 'agent-overlay')).resolves.toEqual({
        API_KEY: 'tools-value',
        ONLY_TOOLS: 'x',
      });
    });
  });

  it('warns and returns null when the master key cannot decrypt a stored secret', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mismatchedProvider = new PostgresSecretProvider(testDb.conn.pgClient, deriveKey('other-passphrase'));

    await provider.set('agent-mismatch', 'ROTATED_KEY', 'value-under-original-key');
    await expect(mismatchedProvider.get('agent-mismatch', 'ROTATED_KEY')).resolves.toBeNull();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('decrypt failed for agent=agent-mismatch tool= key=ROTATED_KEY'),
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('reencrypt-secrets.mjs'));
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('value-under-original-key'));
    warnSpy.mockRestore();
  });
});
