#!/usr/bin/env node
// Offline master-key rotation for the secrets table.
//
// Usage:
//   DATABASE_URL=postgres://... \
//   OLD_SECRET_MASTER_KEY=... \
//   NEW_SECRET_MASTER_KEY=... \
//   node scripts/reencrypt-secrets.mjs
//
// Decrypts every secrets row with the old passphrase and re-encrypts it with
// the new one inside a single transaction. Fail-closed: if any row does not
// decrypt with the old passphrase, the whole run rolls back and the offending
// row ids are reported — a partial rotation is never committed.
//
// Deployments that started without SECRET_MASTER_KEY wrote rows under the
// development fallback passphrase 'ctxmill-dev-key-change-in-prod'; pass that
// as OLD_SECRET_MASTER_KEY to migrate them onto a real key.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { createRequire } from 'node:module';

// Crypto parameters must match packages/ctxmill/src/secrets/crypto.ts.
const ALGO = 'aes-256-gcm';
const SALT = 'ctxmill-salt-v1';

function deriveKey(passphrase) {
  return scryptSync(passphrase, SALT, 32);
}

function encrypt(plaintext, key) {
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    ciphertext: encrypted.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

function decrypt(data, key) {
  const decipher = createDecipheriv(ALGO, key, Buffer.from(data.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(data.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(data.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function fail(message) {
  console.error(`reencrypt-secrets: ${message}`);
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;
const oldPassphrase = process.env.OLD_SECRET_MASTER_KEY;
const newPassphrase = process.env.NEW_SECRET_MASTER_KEY;

if (!databaseUrl) fail('DATABASE_URL must be set');
if (!oldPassphrase) fail('OLD_SECRET_MASTER_KEY must be set');
if (!newPassphrase) fail('NEW_SECRET_MASTER_KEY must be set');
if (oldPassphrase === newPassphrase) fail('OLD_ and NEW_SECRET_MASTER_KEY are identical — nothing to rotate');

// postgres is a dependency of packages/ctxmill, not the workspace root.
const require = createRequire(new URL('../packages/ctxmill/package.json', import.meta.url));
const postgres = require('postgres');

const oldKey = deriveKey(oldPassphrase);
const newKey = deriveKey(newPassphrase);
const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });

try {
  const rotated = await sql.begin(async (tx) => {
    const rows = await tx`SELECT id, iv, ciphertext, auth_tag FROM secrets ORDER BY id`;
    const undecryptable = [];
    const reencrypted = [];

    for (const row of rows) {
      try {
        const plaintext = decrypt({ iv: row.iv, ciphertext: row.ciphertext, tag: row.auth_tag }, oldKey);
        reencrypted.push({ id: row.id, ...encrypt(plaintext, newKey) });
      } catch {
        undecryptable.push(row.id);
      }
    }

    if (undecryptable.length > 0) {
      throw new Error(
        `${undecryptable.length}/${rows.length} rows did not decrypt with OLD_SECRET_MASTER_KEY; ` +
          `rolling back. Row ids: ${undecryptable.join(', ')}`,
      );
    }

    for (const row of reencrypted) {
      await tx`
        UPDATE secrets
        SET iv = ${row.iv}, ciphertext = ${row.ciphertext}, auth_tag = ${row.tag}, updated_at = now()
        WHERE id = ${row.id}
      `;
    }

    return reencrypted.length;
  });

  console.log(`reencrypt-secrets: rotated ${rotated} secret(s) to the new master key`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  await sql.end();
}
