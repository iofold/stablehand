import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const ALGO = 'aes-256-gcm';

export function deriveKey(passphrase: string): Buffer {
  return scryptSync(passphrase, 'stablehand-salt-v1', 32);
}

export function encrypt(plaintext: string, key: Buffer): { iv: string; ciphertext: string; tag: string } {
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    ciphertext: encrypted.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

export function decrypt(data: { iv: string; ciphertext: string; tag: string }, key: Buffer): string {
  const decipher = createDecipheriv(ALGO, key, Buffer.from(data.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(data.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(data.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
