import { describe, expect, it } from 'vitest';

import { TurnSecretEnvelopeCodec } from '../turn-secret-envelope.js';

describe('TurnSecretEnvelopeCodec', () => {
  const codec = new TurnSecretEnvelopeCodec(Buffer.alloc(32, 7));

  it('round-trips a turn-bound secret map without plaintext in the envelope', () => {
    const secrets = {
      PILOT_TURN_OWNERSHIP_TOKEN: 'rotating-token-a',
      PILOT_LOGICAL_AGENT_ID: 'logical-agent-a',
    };

    const envelope = codec.seal('turn-a', secrets);

    expect(envelope.ciphertext).not.toContain('rotating-token-a');
    expect(codec.open('turn-a', envelope)).toEqual(secrets);
  });

  it('rejects moving an authenticated envelope to a different turn', () => {
    const envelope = codec.seal('turn-a', {
      PILOT_TURN_OWNERSHIP_TOKEN: 'rotating-token-a',
    });

    expect(() => codec.open('turn-b', envelope)).toThrow(
      'does not belong to turn turn-b',
    );
  });

  it('rejects a wrong key or tampered ciphertext', () => {
    const envelope = codec.seal('turn-a', {
      PILOT_TURN_OWNERSHIP_TOKEN: 'rotating-token-a',
    });
    const wrongCodec = new TurnSecretEnvelopeCodec(Buffer.alloc(32, 8));
    const tampered = {
      ...envelope,
      ciphertext: `${envelope.ciphertext.slice(0, -2)}AA`,
    };

    expect(() => wrongCodec.open('turn-a', envelope)).toThrow();
    expect(() => codec.open('turn-a', tampered)).toThrow();
  });

  it('rejects runtime control keys and values that cannot round-trip through env', () => {
    expect(() => codec.seal('turn-a', {
      CTXMILL_CALLBACK_TOKEN: 'forged-token',
    })).toThrow('reserved by the sandbox runtime');
    expect(() => codec.seal('turn-a', {
      PILOT_TURN_OWNERSHIP_TOKEN: 'token\0suffix',
    })).toThrow('cannot contain a NUL byte');
  });
});
