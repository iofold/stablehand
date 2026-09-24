import { create } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import {
  type TurnDeliveryCapability,
  TurnDeliveryCapabilitySchema,
} from '@stablehand/proto/sandbox/v1';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import type { GrpcCallbackAuthConfig } from './callback-auth.js';

const TURN_DELIVERY_CAPABILITY_CONTEXT = 'stablehand-turn-delivery-capability-v1';

export const OPEN_TURN_DELIVERY_CAPABILITY_SIGNATURE =
  'stablehand-open-turn-delivery-capability-v1';

export interface TurnDeliveryCapabilityClaims {
  turnId: string;
  sandboxSessionId: string;
  agentId: string;
  ownerId: string;
  fenceToken: number;
  leaseExpiresAtMs: number;
  restoreFenceToken: number;
  containerId?: string;
}

export interface TurnDeliveryCapabilityRoute {
  turnId: string;
  sandboxSessionId: string;
  agentId: string;
}

function denied(message: string): never {
  throw new ConnectError(message, Code.PermissionDenied);
}

function requireCanonicalId(value: string, field: string): string {
  if (!value || value.trim() !== value) {
    denied(`Invalid turn delivery capability ${field}`);
  }
  return value;
}

function requireSafeNonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    denied(`Invalid turn delivery capability ${field}`);
  }
  return value;
}

function bigintToSafeNumber(value: bigint, field: string): number {
  const numeric = Number(value);
  return requireSafeNonNegativeInteger(numeric, field);
}

function canonicalPayload(claims: TurnDeliveryCapabilityClaims): string {
  return JSON.stringify([
    TURN_DELIVERY_CAPABILITY_CONTEXT,
    claims.turnId,
    claims.sandboxSessionId,
    claims.agentId,
    claims.ownerId,
    String(claims.fenceToken),
    String(claims.leaseExpiresAtMs),
    String(claims.restoreFenceToken),
    claims.containerId ?? null,
  ]);
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function signaturesEqual(presented: string, expected: string): boolean {
  return timingSafeEqual(digest(presented), digest(expected));
}

function validateClaims(claims: TurnDeliveryCapabilityClaims): TurnDeliveryCapabilityClaims {
  requireCanonicalId(claims.turnId, 'turn_id');
  requireCanonicalId(claims.sandboxSessionId, 'sandbox_session_id');
  requireCanonicalId(claims.agentId, 'agent_id');
  requireCanonicalId(claims.ownerId, 'owner_id');
  requireSafeNonNegativeInteger(claims.fenceToken, 'fence_token');
  requireSafeNonNegativeInteger(claims.leaseExpiresAtMs, 'lease_expires_at_ms');
  requireSafeNonNegativeInteger(claims.restoreFenceToken, 'restore_fence_token');
  if (claims.containerId !== undefined) {
    requireCanonicalId(claims.containerId, 'container_id');
  }
  return claims;
}

function validateRoute(
  route: TurnDeliveryCapabilityRoute,
): TurnDeliveryCapabilityRoute {
  requireCanonicalId(route.turnId, 'turn_id');
  requireCanonicalId(route.sandboxSessionId, 'sandbox_session_id');
  requireCanonicalId(route.agentId, 'agent_id');
  return route;
}

function capabilityToClaims(
  capability: TurnDeliveryCapability,
  route: TurnDeliveryCapabilityRoute,
): TurnDeliveryCapabilityClaims {
  if (capability.agentId !== route.agentId) {
    denied('Turn delivery capability agent mismatch');
  }

  return validateClaims({
    ...route,
    ownerId: capability.ownerId,
    fenceToken: bigintToSafeNumber(capability.fenceToken, 'fence_token'),
    leaseExpiresAtMs: bigintToSafeNumber(
      capability.leaseExpiresAtMs,
      'lease_expires_at_ms',
    ),
    restoreFenceToken: bigintToSafeNumber(
      capability.restoreFenceToken,
      'restore_fence_token',
    ),
    containerId: capability.containerId,
  });
}

export function mintTurnDeliveryCapability(
  claims: TurnDeliveryCapabilityClaims,
  config: GrpcCallbackAuthConfig,
): TurnDeliveryCapability {
  const validated = validateClaims({ ...claims });
  const signature = config.mode === 'open'
    ? OPEN_TURN_DELIVERY_CAPABILITY_SIGNATURE
    : createHmac('sha256', config.secret)
      .update(canonicalPayload(validated))
      .digest('base64url');

  return create(TurnDeliveryCapabilitySchema, {
    ownerId: validated.ownerId,
    fenceToken: BigInt(validated.fenceToken),
    leaseExpiresAtMs: BigInt(validated.leaseExpiresAtMs),
    restoreFenceToken: BigInt(validated.restoreFenceToken),
    containerId: validated.containerId,
    agentId: validated.agentId,
    signature,
  });
}

export function validateTurnDeliveryCapabilitySignature(
  capability: TurnDeliveryCapability | undefined,
  route: TurnDeliveryCapabilityRoute,
  config: GrpcCallbackAuthConfig,
): TurnDeliveryCapabilityClaims {
  if (!capability) {
    denied('Turn delivery capability is required');
  }

  const claims = capabilityToClaims(capability, validateRoute({ ...route }));
  const expectedSignature = config.mode === 'open'
    ? OPEN_TURN_DELIVERY_CAPABILITY_SIGNATURE
    : createHmac('sha256', config.secret)
      .update(canonicalPayload(claims))
      .digest('base64url');

  if (!capability.signature || !signaturesEqual(capability.signature, expectedSignature)) {
    denied('Invalid turn delivery capability signature');
  }

  return claims;
}
