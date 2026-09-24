import type {
  TurnSecretEnvelopeInsert,
  TurnSecretEnvelopeRow,
} from '../database/types.js';
import { decrypt, encrypt } from '../secrets/crypto.js';
import {
  validateTurnSecrets,
  type TurnSecrets,
} from './session-manager/turn-secrets.js';

interface TurnSecretEnvelopePayload {
  version: 1;
  turnId: string;
  secrets: Record<string, string>;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.values(value).every((entry) => typeof entry === 'string');
}

function parsePayload(plaintext: string): TurnSecretEnvelopePayload {
  const value: unknown = JSON.parse(plaintext);
  if (
    typeof value !== 'object'
    || value === null
    || !('version' in value)
    || value.version !== 1
    || !('turnId' in value)
    || typeof value.turnId !== 'string'
    || !('secrets' in value)
    || !isStringRecord(value.secrets)
  ) {
    throw new Error('Invalid encrypted turn secret envelope payload');
  }
  return {
    version: 1,
    turnId: value.turnId,
    secrets: value.secrets,
  };
}

/**
 * Authenticated encryption for credentials that must survive queued restart or
 * HITL continuation. The authenticated payload includes the turn id so a
 * database row cannot be replayed under another turn.
 */
export class TurnSecretEnvelopeCodec {
  private readonly key: Buffer;

  constructor(key: Buffer) {
    this.key = Buffer.from(key);
  }

  seal(turnId: string, secrets: TurnSecrets): TurnSecretEnvelopeInsert {
    validateTurnSecrets(secrets);
    const payload: TurnSecretEnvelopePayload = {
      version: 1,
      turnId,
      secrets: { ...secrets },
    };
    const encrypted = encrypt(JSON.stringify(payload), this.key);
    return {
      iv: encrypted.iv,
      ciphertext: encrypted.ciphertext,
      authTag: encrypted.tag,
    };
  }

  open(
    turnId: string,
    envelope: TurnSecretEnvelopeInsert | TurnSecretEnvelopeRow,
  ): TurnSecrets {
    const payload = parsePayload(decrypt({
      iv: envelope.iv,
      ciphertext: envelope.ciphertext,
      tag: envelope.authTag,
    }, this.key));
    if (payload.turnId !== turnId) {
      throw new Error(
        `Encrypted turn secret envelope does not belong to turn ${turnId}`,
      );
    }
    validateTurnSecrets(payload.secrets);
    return Object.freeze({ ...payload.secrets });
  }
}
