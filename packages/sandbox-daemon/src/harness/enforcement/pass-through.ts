import type {
  HarnessEnforcementCapabilities,
  HarnessTurnEnforcer,
  ModelCallAttempt,
  ModelCallDecision,
  ModelCallObservation,
  ToolBoundary,
} from './types.js';

const CONTINUE = Object.freeze({
  action: 'continue',
} as const);

export class PassThroughHarnessTurnEnforcer
implements HarnessTurnEnforcer {
  readonly capabilities: HarnessEnforcementCapabilities;

  constructor(capabilities: HarnessEnforcementCapabilities) {
    this.capabilities = Object.freeze({ ...capabilities });
  }

  async beforeModelCall(
    _context: ModelCallAttempt,
  ): Promise<ModelCallDecision> {
    return CONTINUE;
  }

  async afterModelCall(
    _result: ModelCallObservation,
  ): Promise<ModelCallDecision> {
    return CONTINUE;
  }

  async onToolBoundary(
    _context: ToolBoundary,
  ): Promise<ModelCallDecision> {
    return CONTINUE;
  }
}
