import { createHash, randomBytes } from 'node:crypto';

import { API_KEY_TOKEN_PATTERN, API_KEY_TOKEN_PREFIX } from '@stablehand/contracts';

const BASE62_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const TOKEN_BODY_LENGTH = 43; // 62^43 > 2^256 — encodes 32 random bytes

function encodeBase62(bytes: Buffer): string {
  let value = BigInt(`0x${bytes.toString('hex')}`);
  const sixtyTwo = 62n;
  let out = '';
  while (value > 0n) {
    out = BASE62_ALPHABET[Number(value % sixtyTwo)] + out;
    value /= sixtyTwo;
  }
  return out.padStart(TOKEN_BODY_LENGTH, BASE62_ALPHABET[0]);
}

/** `cmk_` + 43 base62 chars (256 bits of entropy). Shown once at creation. */
export function generateApiKeyToken(): string {
  const token = `${API_KEY_TOKEN_PREFIX}${encodeBase62(randomBytes(32))}`;
  if (!API_KEY_TOKEN_PATTERN.test(token)) {
    throw new Error('generated api key token failed self-check');
  }
  return token;
}

export function apiKeyTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
