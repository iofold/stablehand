import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

/**
 * Orchestrator process identity for turn-delivery lease owners (ADR 024).
 *
 * Owner ids read `<instance>/<boot>/<uuid>`. The instance id names a slot
 * that runs at most one orchestrator process at a time: the container or pod
 * hostname by default, or STABLEHAND_INSTANCE_ID. The boot id changes on
 * every process start. A booting process may therefore take over, without
 * waiting for expiry, any lease held by an earlier boot of its own instance:
 * that process is dead. Leases of other instances still expire normally.
 *
 * Two live processes sharing an instance id (for example host networking with
 * identical hostnames) would only lose liveness, not safety: every takeover
 * bumps the fence, so the displaced owner's writes and callbacks are refused.
 */

function sanitizeSegment(value: string): string {
  const cleaned = value.trim().replace(/[^A-Za-z0-9._-]/g, '_');
  return cleaned.length > 0 ? cleaned : 'unknown-instance';
}

export interface OrchestratorInstanceIdentity {
  instanceId: string;
  bootId: string;
}

export function resolveOrchestratorInstanceIdentity(
  env: Readonly<Record<string, string | undefined>> = process.env,
): OrchestratorInstanceIdentity {
  return {
    instanceId: sanitizeSegment(env.STABLEHAND_INSTANCE_ID || hostname()),
    bootId: randomUUID(),
  };
}

let processIdentity: OrchestratorInstanceIdentity | undefined;

export function orchestratorInstanceIdentity(): OrchestratorInstanceIdentity {
  processIdentity ??= resolveOrchestratorInstanceIdentity();
  return processIdentity;
}

export function instanceOwnerPrefix(
  identity: OrchestratorInstanceIdentity = orchestratorInstanceIdentity(),
): string {
  return `${identity.instanceId}/`;
}

export function bootOwnerPrefix(
  identity: OrchestratorInstanceIdentity = orchestratorInstanceIdentity(),
): string {
  return `${identity.instanceId}/${identity.bootId}/`;
}

/** A fresh lease owner id scoped to this process boot. */
export function newDeliveryOwnerId(
  identity: OrchestratorInstanceIdentity = orchestratorInstanceIdentity(),
): string {
  return `${bootOwnerPrefix(identity)}${randomUUID()}`;
}

/** Claim options that let this boot take over its dead predecessor's leases. */
export function previousBootTakeover(
  identity: OrchestratorInstanceIdentity = orchestratorInstanceIdentity(),
): { instancePrefix: string; ownBootPrefix: string } {
  return {
    instancePrefix: instanceOwnerPrefix(identity),
    ownBootPrefix: bootOwnerPrefix(identity),
  };
}
