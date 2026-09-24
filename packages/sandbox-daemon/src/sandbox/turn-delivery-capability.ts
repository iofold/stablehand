import { create } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import {
  type TurnDeliveryCapability,
  TurnDeliveryCapabilitySchema,
} from '@stablehand/proto/sandbox/v1';

export const OPEN_TURN_DELIVERY_CAPABILITY_SIGNATURE =
  'stablehand-open-turn-delivery-capability-v1';

const HMAC_SHA256_BASE64URL = /^[A-Za-z0-9_-]{43}$/;

export interface TurnDeliveryRoute {
  turnId: string;
  sandboxSessionId: string;
  agentId: string;
}

export interface TurnDeliveryIdentity extends TurnDeliveryRoute {
  ownerId: string;
  fenceToken: number;
  restoreFenceToken: number;
  containerId?: string;
}

export interface ParsedTurnDeliveryCapability {
  identity: TurnDeliveryIdentity;
  capability: TurnDeliveryCapability;
  leaseExpiresAtMs: number;
}

function failedPrecondition(message: string): never {
  throw new ConnectError(message, Code.FailedPrecondition);
}

function requireCanonicalId(value: string, field: string): string {
  if (!value || value.trim() !== value) {
    failedPrecondition(`Invalid turn delivery capability ${field}`);
  }
  return value;
}

function bigintToSafeNonNegativeInteger(value: bigint, field: string): number {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    failedPrecondition(`Invalid turn delivery capability ${field}`);
  }
  return numeric;
}

function validateSignatureStructure(signature: string): void {
  if (
    signature !== OPEN_TURN_DELIVERY_CAPABILITY_SIGNATURE
    && !HMAC_SHA256_BASE64URL.test(signature)
  ) {
    failedPrecondition('Invalid turn delivery capability signature');
  }
}

export function parseTurnDeliveryCapability(
  capability: TurnDeliveryCapability | undefined,
  route: TurnDeliveryRoute,
  nowMs = Date.now(),
): ParsedTurnDeliveryCapability {
  if (!capability) {
    failedPrecondition('Turn delivery capability is required');
  }

  requireCanonicalId(route.turnId, 'turn_id');
  requireCanonicalId(route.sandboxSessionId, 'sandbox_session_id');
  requireCanonicalId(route.agentId, 'agent_id');
  requireCanonicalId(capability.ownerId, 'owner_id');
  if (capability.agentId !== route.agentId) {
    failedPrecondition('Turn delivery capability agent mismatch');
  }
  validateSignatureStructure(capability.signature);

  const fenceToken = bigintToSafeNonNegativeInteger(
    capability.fenceToken,
    'fence_token',
  );
  const leaseExpiresAtMs = bigintToSafeNonNegativeInteger(
    capability.leaseExpiresAtMs,
    'lease_expires_at_ms',
  );
  const restoreFenceToken = bigintToSafeNonNegativeInteger(
    capability.restoreFenceToken,
    'restore_fence_token',
  );
  if (capability.containerId !== undefined) {
    requireCanonicalId(capability.containerId, 'container_id');
  }
  if (nowMs >= leaseExpiresAtMs) {
    failedPrecondition('Turn delivery capability has expired');
  }

  return {
    identity: {
      ...route,
      ownerId: capability.ownerId,
      fenceToken,
      restoreFenceToken,
      containerId: capability.containerId,
    },
    capability: create(TurnDeliveryCapabilitySchema, capability),
    leaseExpiresAtMs,
  };
}

export function sameTurnDeliveryIdentity(
  left: TurnDeliveryIdentity,
  right: TurnDeliveryIdentity,
): boolean {
  return left.turnId === right.turnId
    && left.sandboxSessionId === right.sandboxSessionId
    && left.agentId === right.agentId
    && left.ownerId === right.ownerId
    && left.fenceToken === right.fenceToken
    && left.restoreFenceToken === right.restoreFenceToken
    && left.containerId === right.containerId;
}

export function assertMonotonicTurnDelivery(
  previous: TurnDeliveryIdentity | undefined,
  next: TurnDeliveryIdentity,
): void {
  if (!previous) return;
  if (previous.turnId !== next.turnId) {
    failedPrecondition('Cannot compare delivery fences from different turns');
  }
  if (next.fenceToken < previous.fenceToken) {
    failedPrecondition('Stale turn delivery fence');
  }
  if (
    next.fenceToken === previous.fenceToken
    && !sameTurnDeliveryIdentity(previous, next)
  ) {
    failedPrecondition('Conflicting owner or runtime generation for turn delivery fence');
  }
}

export function cloneTurnDeliveryCapability(
  capability: TurnDeliveryCapability,
): TurnDeliveryCapability {
  return create(TurnDeliveryCapabilitySchema, capability);
}
