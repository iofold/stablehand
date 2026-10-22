import {
  BUDGET_REACHED_CODE,
  MODEL_GATEWAY_BUDGET_EXCEEDED_CODE,
  type TurnSpendCapSource,
  type TurnStopReason,
} from '@stablehand/contracts';

import type { PolicyCostHeadroom } from '../orchestrator/budget-enforcer.js';
import type { LiteLLMKeyClient } from './litellm-key-client.js';

interface Logger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

/** The spend cap applied to one run through its session's gateway key. */
export interface TurnSpendCap {
  capUsd: number;
  source: TurnSpendCapSource;
  policyId?: string;
  policyName?: string;
  bucket?: string;
}

/** What the sandbox reported when the gateway refused a call for budget. */
export interface GatewayBudgetRefusalReport {
  spentUsd: number | null;
  capUsd: number | null;
}

export const SESSION_KEY_ALIAS_PREFIX = 'stablehand-session-';
const DEFAULT_KEY_LIFETIME = '24h';
// Runs that never reach finalization (crashes, lost delivery) leave a cap
// record behind; bound the map rather than grow it for the process lifetime.
const MAX_TRACKED_TURN_CAPS = 2_000;
const TAG = '[SessionGatewayKeys]';

export function sessionKeyAlias(sessionId: string): string {
  return `${SESSION_KEY_ALIAS_PREFIX}${sessionId}`;
}

/** harnessConfig.limits.maxCostUsd, the agent's per-run spend cap, if set. */
export function readRunSpendCapUsd(harnessConfig: Record<string, unknown> | undefined): number | null {
  const limits = harnessConfig?.limits;
  if (typeof limits !== 'object' || limits === null || Array.isArray(limits)) return null;
  const value = (limits as Record<string, unknown>).maxCostUsd;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * The typed stop for a gateway budget refusal. A refusal under a cap
 * Stablehand set for this run is `budget_reached`; any other gateway budget
 * refusal (e.g. an operations ceiling on the shared key) is reported as the
 * gateway's own and never attributed to a Stablehand policy.
 */
export function budgetStopReason(
  cap: TurnSpendCap | null | undefined,
  report: GatewayBudgetRefusalReport,
): TurnStopReason {
  if (cap) {
    return {
      code: BUDGET_REACHED_CODE,
      source: cap.source,
      capUsd: cap.capUsd,
      spentUsd: report.spentUsd,
      ...(cap.policyId ? { policyId: cap.policyId } : {}),
      ...(cap.policyName ? { policyName: cap.policyName } : {}),
      ...(cap.bucket ? { bucket: cap.bucket } : {}),
    };
  }
  return {
    code: MODEL_GATEWAY_BUDGET_EXCEEDED_CODE,
    spentUsd: report.spentUsd,
    limitUsd: report.capUsd,
  };
}

export interface SessionGatewayKeyManagerDeps {
  client: Pick<
    LiteLLMKeyClient,
    'generateKey' | 'updateKey' | 'deleteKeysByAlias' | 'getKeyModels' | 'findKeyHashByAlias'
  >;
  /** The shared runtime key; session keys inherit its model allowlist. */
  runtimeKey: string;
  getTurnTags: (turnId: string) => Promise<Record<string, string>>;
  /** Remaining headroom of matching blocking cost policies (BudgetEnforcer.costHeadroom). */
  resolvePolicyHeadroom?: (tags: Record<string, string>) => Promise<PolicyCostHeadroom | null>;
  logger: Logger;
  /** Backstop expiry for a key whose revocation was missed; refreshed every run. */
  keyLifetime?: string;
}

/**
 * Per-sandbox-session LiteLLM virtual keys (ctx-p1ui, ctx-ycek).
 *
 * - Minted at session open/restore — the slow path — and placed in the
 *   sandbox as its gateway runtime key. Same model allowlist as the shared
 *   runtime key, alias `stablehand-session-<sessionId>`, no budget yet.
 * - At each run start the key's spend counter is reset and its `max_budget`
 *   set to the run's cap: the agent's `limits.maxCostUsd` or the remaining
 *   headroom of the tightest matching blocking cost policy, whichever is
 *   lower. The gateway then refuses the first call past the cap, mid-run.
 * - Revoked when the session's runtime goes away (checkpoint, termination,
 *   failed start or restore).
 *
 * Only the key's hash is kept here; the secret goes straight into the
 * sandbox environment and is never logged or persisted. Every failure falls
 * back to the previous behaviour (shared key, admission-only budgets) rather
 * than failing the run.
 */
export class SessionGatewayKeyManager {
  private readonly keyHashes = new Map<string, string>();
  private readonly sessionsWithoutKey = new Set<string>();
  private readonly turnCaps = new Map<string, { sessionId: string; cap: TurnSpendCap | null }>();
  private modelScope: Promise<string[]> | undefined;
  private readonly keyLifetime: string;

  constructor(private readonly deps: SessionGatewayKeyManagerDeps) {
    this.keyLifetime = deps.keyLifetime ?? DEFAULT_KEY_LIFETIME;
  }

  /**
   * Mint the session's key and return its secret for the sandbox, or null to
   * keep the shared runtime key (logged; mid-run caps are then unavailable
   * for this session).
   */
  async mintSessionKey(params: { sessionId: string; agentId: string }): Promise<string | null> {
    const alias = sessionKeyAlias(params.sessionId);
    try {
      const models = await this.inheritedModelScope();
      // A restore or a retried start reuses the session id; aliases are unique.
      await this.deps.client.deleteKeysByAlias([alias]);
      const minted = await this.deps.client.generateKey({
        keyAlias: alias,
        models,
        maxBudgetUsd: null,
        duration: this.keyLifetime,
        metadata: {
          stablehand_session_id: params.sessionId,
          stablehand_agent_id: params.agentId,
        },
      });
      if (minted.tokenHash) {
        this.keyHashes.set(params.sessionId, minted.tokenHash);
      } else {
        this.keyHashes.delete(params.sessionId);
      }
      this.sessionsWithoutKey.delete(params.sessionId);
      this.deps.logger.info(`${TAG} minted gateway key ${alias}`);
      return minted.key;
    } catch (err) {
      this.sessionsWithoutKey.add(params.sessionId);
      this.deps.logger.warn(
        `${TAG} could not mint a gateway key for session ${params.sessionId}; it uses the shared runtime key, so runs in it are budget-checked at admission only:`,
        err instanceof Error ? err.message : String(err),
      );
      return null;
    }
  }

  /**
   * Set this run's spend cap on the session key (resetting its spend). A
   * continuation of a paused run keeps the cap and spend it already has.
   */
  async prepareTurn(params: {
    sessionId: string;
    turnId: string;
    harnessConfig: Record<string, unknown> | undefined;
    continuation?: boolean;
  }): Promise<TurnSpendCap | null> {
    const existing = this.turnCaps.get(params.turnId);
    if (params.continuation && existing?.sessionId === params.sessionId) {
      return existing.cap;
    }
    const keyHash = await this.resolveKeyHash(params.sessionId);
    if (!keyHash) return null;

    const cap = await this.computeCap(params.turnId, params.harnessConfig);
    try {
      await this.deps.client.updateKey({
        key: keyHash,
        maxBudgetUsd: cap ? cap.capUsd : null,
        resetSpend: true,
        duration: this.keyLifetime,
      });
      this.rememberTurnCap(params.turnId, params.sessionId, cap);
      return cap;
    } catch (err) {
      this.rememberTurnCap(params.turnId, params.sessionId, null);
      this.deps.logger.error(
        `${TAG} could not set the spend cap for turn ${params.turnId}; the session key keeps its previous budget:`,
        err instanceof Error ? err.message : String(err),
      );
      return null;
    }
  }

  /** The cap this run was given, if any. */
  capForTurn(turnId: string): TurnSpendCap | null {
    return this.turnCaps.get(turnId)?.cap ?? null;
  }

  /** Forget a finished run's cap. */
  settleTurn(turnId: string): void {
    this.turnCaps.delete(turnId);
  }

  /** Delete the session's key; idempotent and safe for sessions that never had one. */
  async revokeSessionKey(sessionId: string): Promise<void> {
    this.keyHashes.delete(sessionId);
    this.sessionsWithoutKey.delete(sessionId);
    for (const [turnId, record] of this.turnCaps) {
      if (record.sessionId === sessionId) this.turnCaps.delete(turnId);
    }
    try {
      await this.deps.client.deleteKeysByAlias([sessionKeyAlias(sessionId)]);
    } catch (err) {
      this.deps.logger.warn(
        `${TAG} could not revoke the gateway key for session ${sessionId}; it expires within ${this.keyLifetime}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private rememberTurnCap(turnId: string, sessionId: string, cap: TurnSpendCap | null): void {
    this.turnCaps.delete(turnId);
    this.turnCaps.set(turnId, { sessionId, cap });
    while (this.turnCaps.size > MAX_TRACKED_TURN_CAPS) {
      const oldest = this.turnCaps.keys().next().value;
      if (oldest === undefined) break;
      this.turnCaps.delete(oldest);
    }
  }

  private inheritedModelScope(): Promise<string[]> {
    if (!this.modelScope) {
      this.modelScope = this.deps.client.getKeyModels(this.deps.runtimeKey).catch((err: unknown) => {
        this.modelScope = undefined;
        throw err;
      });
    }
    return this.modelScope;
  }

  private async resolveKeyHash(sessionId: string): Promise<string | null> {
    const known = this.keyHashes.get(sessionId);
    if (known) return known;
    if (this.sessionsWithoutKey.has(sessionId)) return null;
    // Sessions opened before an orchestrator restart: find the key by alias.
    try {
      const found = await this.deps.client.findKeyHashByAlias(sessionKeyAlias(sessionId));
      if (found) {
        this.keyHashes.set(sessionId, found);
        return found;
      }
      this.sessionsWithoutKey.add(sessionId);
      return null;
    } catch (err) {
      this.deps.logger.warn(
        `${TAG} could not look up the gateway key for session ${sessionId}; this run is budget-checked at admission only:`,
        err instanceof Error ? err.message : String(err),
      );
      return null;
    }
  }

  private async computeCap(
    turnId: string,
    harnessConfig: Record<string, unknown> | undefined,
  ): Promise<TurnSpendCap | null> {
    const runLimit = readRunSpendCapUsd(harnessConfig);
    let headroom: PolicyCostHeadroom | null = null;
    if (this.deps.resolvePolicyHeadroom) {
      try {
        headroom = await this.deps.resolvePolicyHeadroom(await this.deps.getTurnTags(turnId));
      } catch (err) {
        this.deps.logger.error(
          `${TAG} budget headroom lookup failed for turn ${turnId}; no policy cap this run (fail-open):`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    if (runLimit !== null && (headroom === null || runLimit <= headroom.remainingUsd)) {
      return { capUsd: runLimit, source: 'run_limit' };
    }
    if (headroom) {
      return {
        capUsd: headroom.remainingUsd,
        source: 'budget_policy',
        policyId: headroom.policyId,
        policyName: headroom.policyName,
        ...(headroom.bucket ? { bucket: headroom.bucket } : {}),
      };
    }
    return null;
  }
}
