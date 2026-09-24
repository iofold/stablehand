import { Code, ConnectError } from '@connectrpc/connect';
import { describe, expect, it } from 'vitest';

import {
  OPEN_TURN_DELIVERY_CAPABILITY_SIGNATURE,
  mintTurnDeliveryCapability,
  validateTurnDeliveryCapabilitySignature,
  type TurnDeliveryCapabilityClaims,
} from '../turn-delivery-capability.js';

const CLAIMS: TurnDeliveryCapabilityClaims = {
  turnId: 'turn-1',
  sandboxSessionId: 'session-1',
  agentId: 'agent-1',
  ownerId: 'owner-1',
  fenceToken: 7,
  leaseExpiresAtMs: 2_000,
  restoreFenceToken: 3,
  containerId: 'container-1',
};

describe('turn delivery capability signing', () => {
  it('round-trips the complete delivery and runtime generation tuple', () => {
    const capability = mintTurnDeliveryCapability(CLAIMS, {
      mode: 'enforce',
      secret: 'test-secret',
    });

    expect(validateTurnDeliveryCapabilitySignature(
      capability,
      {
        turnId: CLAIMS.turnId,
        sandboxSessionId: CLAIMS.sandboxSessionId,
        agentId: CLAIMS.agentId,
      },
      { mode: 'enforce', secret: 'test-secret' },
    )).toEqual(CLAIMS);
  });

  it('rejects replay under another turn, session, agent, or signed field', () => {
    const config = { mode: 'enforce' as const, secret: 'test-secret' };
    const capability = mintTurnDeliveryCapability(CLAIMS, config);

    for (const expected of [
      { turnId: 'turn-2', sandboxSessionId: 'session-1', agentId: 'agent-1' },
      { turnId: 'turn-1', sandboxSessionId: 'session-2', agentId: 'agent-1' },
      { turnId: 'turn-1', sandboxSessionId: 'session-1', agentId: 'agent-2' },
    ]) {
      expect(() => validateTurnDeliveryCapabilitySignature(
        capability,
        expected,
        config,
      )).toThrow(ConnectError);
    }

    const tampered = {
      ...capability,
      fenceToken: capability.fenceToken + 1n,
    };
    try {
      validateTurnDeliveryCapabilitySignature(
        tampered,
        {
          turnId: CLAIMS.turnId,
          sandboxSessionId: CLAIMS.sandboxSessionId,
          agentId: CLAIMS.agentId,
        },
        config,
      );
      throw new Error('expected validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectError);
      expect((error as ConnectError).code).toBe(Code.PermissionDenied);
    }
  });

  it('uses an explicit marker in intentionally open callback-auth mode', () => {
    const capability = mintTurnDeliveryCapability(CLAIMS, { mode: 'open' });
    expect(capability.signature).toBe(OPEN_TURN_DELIVERY_CAPABILITY_SIGNATURE);
    expect(validateTurnDeliveryCapabilitySignature(
      capability,
      {
        turnId: CLAIMS.turnId,
        sandboxSessionId: CLAIMS.sandboxSessionId,
        agentId: CLAIMS.agentId,
      },
      { mode: 'open' },
    )).toEqual(CLAIMS);
  });
});
