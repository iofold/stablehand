import type { AgentSessionEvent } from '@ctxmill/shared';
import type {
  HarnessEnforcementCapabilities,
  HarnessTurnEnforcer,
  ModelCallAttempt,
  ModelCallDecision,
  ModelCallObservation,
  ToolBoundary,
  TurnEnforcementReason,
} from './types.js';

/**
 * Per-turn fan-out caps. Admission counts sandbox containers, but one sandbox
 * can multiply provider and tool concurrency without bound (parallel Task
 * subagents, parallel tool batches, unbounded agentic loops). These defaults
 * apply to every turn; an agent's harnessConfig `limits` can raise them but
 * never remove them.
 */
export interface ResolvedTurnFanoutLimits {
  maxModelCalls: number;
  maxToolCalls: number;
  maxSubagents: number;
}

export const DEFAULT_TURN_FANOUT_LIMITS: ResolvedTurnFanoutLimits = Object.freeze({
  maxModelCalls: 200,
  maxToolCalls: 500,
  maxSubagents: 16,
});

function capOverride(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

/**
 * Read `limits` out of an agent's opaque harnessConfig JSON without the
 * harness-specific schema. Contract validation happens at agent save; here a
 * malformed document just falls back to the defaults.
 */
export function resolveTurnFanoutLimits(
  harnessConfigJson: string | undefined,
): ResolvedTurnFanoutLimits {
  let limits: Record<string, unknown> = {};
  if (harnessConfigJson) {
    try {
      const parsed = JSON.parse(harnessConfigJson) as { limits?: unknown };
      if (typeof parsed.limits === 'object' && parsed.limits !== null) {
        limits = parsed.limits as Record<string, unknown>;
      }
    } catch { /* malformed config already fails validation elsewhere */ }
  }
  return {
    maxModelCalls: capOverride(limits.maxModelCalls, DEFAULT_TURN_FANOUT_LIMITS.maxModelCalls),
    maxToolCalls: capOverride(limits.maxToolCalls, DEFAULT_TURN_FANOUT_LIMITS.maxToolCalls),
    maxSubagents: capOverride(limits.maxSubagents, DEFAULT_TURN_FANOUT_LIMITS.maxSubagents),
  };
}

export interface TurnFanoutSnapshot {
  turnId: string;
  modelCalls: number;
  toolCalls: number;
  subagents: number;
  limits: ResolvedTurnFanoutLimits;
  tripped: TurnEnforcementReason[];
}

const CONTINUE = Object.freeze({ action: 'continue' } as const);

/**
 * First real {@link HarnessTurnEnforcer}: counts model calls, tool executions,
 * and subagent spawns per turn and trips when a cap is exceeded.
 *
 * - The model-call cap always cancels the turn: it is the universal backstop,
 *   because even soft-denied tool calls consume a model call, so a capped turn
 *   is guaranteed to terminate.
 * - Tool and subagent caps soft-deny (`deny_next_call`) when the harness
 *   declares soft-stop support, letting the model wrap up; otherwise they
 *   cancel.
 * - Counters reset lazily when a new turnId is observed — the enforcer is
 *   session-scoped but the caps are per-turn.
 *
 * Counting boundary follows the declared capability: `after_only` harnesses
 * count in afterModelCall, everyone else in beforeModelCall, so a harness
 * reporting both boundaries never double-counts.
 */
export class FanoutLimitHarnessTurnEnforcer implements HarnessTurnEnforcer {
  readonly capabilities: HarnessEnforcementCapabilities;
  readonly limits: ResolvedTurnFanoutLimits;

  private turnId = '';
  private modelCalls = 0;
  private toolCalls = 0;
  private subagents = 0;
  private tripped: TurnEnforcementReason[] = [];
  private reported = new Set<TurnEnforcementReason>();

  constructor(
    capabilities: HarnessEnforcementCapabilities,
    limits: ResolvedTurnFanoutLimits = DEFAULT_TURN_FANOUT_LIMITS,
  ) {
    this.capabilities = Object.freeze({ ...capabilities });
    this.limits = Object.freeze({ ...limits });
  }

  async beforeModelCall(context: ModelCallAttempt): Promise<ModelCallDecision> {
    this.resetIfNewTurn(context.turnId);
    if (this.capabilities.observationBoundary === 'after_only') {
      return CONTINUE;
    }
    return this.noteModelCall();
  }

  async afterModelCall(result: ModelCallObservation): Promise<ModelCallDecision> {
    this.resetIfNewTurn(result.turnId);
    if (this.capabilities.observationBoundary !== 'after_only') {
      return CONTINUE;
    }
    return this.noteModelCall();
  }

  async onToolBoundary(context: ToolBoundary): Promise<ModelCallDecision> {
    this.resetIfNewTurn(context.turnId);
    this.toolCalls += 1;
    if (context.subagent) {
      this.subagents += 1;
      if (this.subagents > this.limits.maxSubagents) {
        return this.trip('subagent_limit');
      }
    }
    if (this.toolCalls > this.limits.maxToolCalls) {
      return this.trip('tool_call_limit');
    }
    return CONTINUE;
  }

  snapshot(): TurnFanoutSnapshot {
    return {
      turnId: this.turnId,
      modelCalls: this.modelCalls,
      toolCalls: this.toolCalls,
      subagents: this.subagents,
      limits: this.limits,
      tripped: [...this.tripped],
    };
  }

  /**
   * True exactly once per (turn, reason) — bounds telemetry to one event per
   * tripped cap regardless of how often the harness keeps hitting it.
   */
  takeFirstTrip(reason: TurnEnforcementReason): boolean {
    if (this.reported.has(reason)) return false;
    this.reported.add(reason);
    return true;
  }

  private noteModelCall(): ModelCallDecision {
    this.modelCalls += 1;
    if (this.modelCalls > this.limits.maxModelCalls) {
      return this.trip('model_call_limit', { hard: true });
    }
    return CONTINUE;
  }

  private trip(
    reason: TurnEnforcementReason,
    opts?: { hard?: boolean },
  ): ModelCallDecision {
    if (!this.tripped.includes(reason)) this.tripped.push(reason);
    if (opts?.hard || !this.capabilities.softStop) {
      return { action: 'cancel_turn', reason };
    }
    return { action: 'deny_next_call', reason };
  }

  private resetIfNewTurn(turnId: string): void {
    if (turnId === this.turnId) return;
    this.turnId = turnId;
    this.modelCalls = 0;
    this.toolCalls = 0;
    this.subagents = 0;
    this.tripped = [];
    this.reported = new Set();
  }
}

const REASON_DESCRIPTIONS: Partial<Record<TurnEnforcementReason, (l: ResolvedTurnFanoutLimits) => string>> = {
  model_call_limit: (l) => `made ${l.maxModelCalls} model calls`,
  tool_call_limit: (l) => `ran ${l.maxToolCalls} tools`,
  subagent_limit: (l) => `spawned ${l.maxSubagents} subagents`,
};

const REASON_CONFIG_KEYS: Partial<Record<TurnEnforcementReason, string>> = {
  model_call_limit: 'maxModelCalls',
  tool_call_limit: 'maxToolCalls',
  subagent_limit: 'maxSubagents',
};

/**
 * Plain-language message shown in chat when a cap trips: what happened and
 * how to raise the cap, not the enforcement mechanics.
 */
export function fanoutLimitMessage(
  reason: TurnEnforcementReason,
  limits: ResolvedTurnFanoutLimits,
): string {
  const describe = REASON_DESCRIPTIONS[reason];
  const configKey = REASON_CONFIG_KEYS[reason];
  if (!describe || !configKey) {
    return `Turn stopped: the ${reason} safety cap was reached.`;
  }
  return `Turn stopped: it ${describe(limits)}, the safety cap for a single turn. `
    + `If this workload is legitimate, raise limits.${configKey} in the agent's harness config.`;
}

/**
 * Model-facing text for a soft-denied tool call: tells the model to wrap up
 * instead of retrying, without exposing enforcement internals.
 */
export function fanoutDenialMessage(
  reason: TurnEnforcementReason,
  limits: ResolvedTurnFanoutLimits,
): string {
  const describe = REASON_DESCRIPTIONS[reason];
  if (!describe) {
    return `Tool call denied: this turn's ${reason} safety cap was reached. Do not retry; wrap up with what you have.`;
  }
  return `Tool call denied: this turn already ${describe(limits)}, its safety cap. `
    + 'Do not retry tools or spawn more subagents; wrap up now with the results you already have.';
}

/** One bounded telemetry event per tripped cap, emitted as a custom AG-UI event. */
export function fanoutTelemetryEvent(
  source: string,
  reason: TurnEnforcementReason,
  action: 'deny_next_call' | 'cancel_turn',
  snapshot: TurnFanoutSnapshot,
): AgentSessionEvent {
  return {
    type: 'CUSTOM',
    timestamp: Date.now(),
    runId: '',
    name: 'ctxmill.fanout.limit',
    subtype: 'turn_fanout_limit',
    source,
    reason,
    action,
    turnId: snapshot.turnId,
    modelCalls: snapshot.modelCalls,
    toolCalls: snapshot.toolCalls,
    subagents: snapshot.subagents,
    limits: snapshot.limits,
  };
}
