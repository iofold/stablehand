#!/usr/bin/env node
// Offline master-key rotation for stable secrets and open-turn envelopes.
//
// Usage:
//   DATABASE_URL=postgres://... \
//   OLD_SECRET_MASTER_KEY=... \
//   NEW_SECRET_MASTER_KEY=... \
//   node scripts/reencrypt-secrets.mjs
//
// Decrypts every encrypted row with the old passphrase and re-encrypts it with
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
    const secretRows = await tx`SELECT id, iv, ciphertext, auth_tag FROM secrets ORDER BY id`;
    const turnRows = await tx`
      SELECT turn_id, iv, ciphertext, auth_tag
      FROM turn_secret_envelopes
      ORDER BY turn_id
    `;
    const undecryptable = [];
    const reencryptedSecrets = [];
    const reencryptedTurns = [];

    for (const row of secretRows) {
      try {
        const plaintext = decrypt({ iv: row.iv, ciphertext: row.ciphertext, tag: row.auth_tag }, oldKey);
        reencryptedSecrets.push({ id: row.id, ...encrypt(plaintext, newKey) });
      } catch {
        undecryptable.push(`secret:${row.id}`);
      }
    }

    for (const row of turnRows) {
      try {
        const plaintext = decrypt({ iv: row.iv, ciphertext: row.ciphertext, tag: row.auth_tag }, oldKey);
        reencryptedTurns.push({ turnId: row.turn_id, ...encrypt(plaintext, newKey) });
      } catch {
        undecryptable.push(`turn:${row.turn_id}`);
      }
    }

    if (undecryptable.length > 0) {
      throw new Error(
        `${undecryptable.length}/${secretRows.length + turnRows.length} rows did not decrypt with OLD_SECRET_MASTER_KEY; ` +
          `rolling back. Row ids: ${undecryptable.join(', ')}`,
      );
    }

    for (const row of reencryptedSecrets) {
      await tx`
        UPDATE secrets
        SET iv = ${row.iv}, ciphertext = ${row.ciphertext}, auth_tag = ${row.tag}, updated_at = now()
        WHERE id = ${row.id}
      `;
    }

    for (const row of reencryptedTurns) {
      await tx`
        UPDATE turn_secret_envelopes
        SET iv = ${row.iv}, ciphertext = ${row.ciphertext}, auth_tag = ${row.tag}
        WHERE turn_id = ${row.turnId}
      `;
    }

    return {
      secrets: reencryptedSecrets.length,
      turns: reencryptedTurns.length,
    };
  });

  console.log(
    `reencrypt-secrets: rotated ${rotated.secrets} stable secret(s) and `
    + `${rotated.turns} open-turn envelope(s) to the new master key`,
  );
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  await sql.end();
}
