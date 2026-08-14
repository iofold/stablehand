export type HarnessObservationBoundary =
  | 'before_and_after'
  | 'after_only'
  | 'turn_only';

export interface HarnessEnforcementCapabilities {
  observationBoundary: HarnessObservationBoundary;
  activeCallCancellation: boolean;
  softStop: boolean;
}

export const TURN_ONLY_ENFORCEMENT_CAPABILITIES =
  Object.freeze<HarnessEnforcementCapabilities>({
    observationBoundary: 'turn_only',
    activeCallCancellation: false,
    softStop: false,
  });

export interface ModelCallAttempt {
  turnId: string;
  provider: string;
  model: string;
}

export interface ModelCallObservation extends ModelCallAttempt {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

export interface ToolBoundary {
  turnId: string;
  toolName: string;
  /** True when this tool call spawns a subagent branch (Task/task/Agent). */
  subagent?: boolean;
}

export type TurnEnforcementReason =
  | 'model_call_limit'
  | 'tool_call_limit'
  | 'subagent_limit'
  | 'token_limit'
  | 'cost_limit'
  | 'turn_cancelled';

export type ModelCallDecision =
  | { action: 'continue' }
  | {
      action: 'deny_next_call';
      reason: TurnEnforcementReason;
    }
  | {
      action: 'cancel_turn';
      reason: TurnEnforcementReason;
    };

/**
 * Internal harness boundary for future bounded turn allowances.
 *
 * It intentionally has no policy, credential, database, or orchestrator
 * dependency. The initial implementation always continues.
 */
export interface HarnessTurnEnforcer {
  readonly capabilities: HarnessEnforcementCapabilities;
  beforeModelCall(
    context: ModelCallAttempt,
  ): Promise<ModelCallDecision>;
  afterModelCall(
    result: ModelCallObservation,
  ): Promise<ModelCallDecision>;
  onToolBoundary?(
    context: ToolBoundary,
  ): Promise<ModelCallDecision>;
}
