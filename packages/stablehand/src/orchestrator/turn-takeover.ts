import type { AgentDefinition } from '@stablehand/sandbox-daemon';

import type { DatabaseRepository, SandboxSessionRow } from '../database/repository.js';
import type { TurnSelect } from '../database/types.js';
import { buildAgentDefinition } from './agent-definition.js';
import type { ExecuteTurnParams } from './agent-turn-service.js';
import type { SessionRecord } from './session-manager/types.js';
import { TurnAttachUnavailableError } from './turn-attach-error.js';
import type { TurnDeliveryFence } from './turn-delivery-fence.js';

interface Logger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
}

export interface TurnTakeoverDeps {
  db: Pick<DatabaseRepository, 'getSandboxSession' | 'getAgent'>;
  sessionManager: {
    findSessionById(sessionId: string): SessionRecord | undefined;
    reconnectActiveSession(
      session: SandboxSessionRow,
      agentDef: AgentDefinition,
    ): Promise<SessionRecord>;
  };
  executeTurn(params: ExecuteTurnParams): Promise<void>;
  logger: Logger;
}

export type TurnTakeoverResult =
  | { outcome: 'adopted' }
  | { outcome: 'unavailable'; reason: string };

const TAG = '[TurnTakeover]';

/**
 * Re-adopt a turn that was running when its orchestrator died (ADR 024).
 *
 * The caller already holds the turn's delivery lease with a fresh fence.
 * This reconnects to the sandbox that is still running the turn, re-attaches
 * to its delivery journal, and lets AgentTurnService finish the turn exactly
 * as the dead owner would have. When the sandbox cannot be re-attached the
 * turn is left open and the reason returned, so the caller picks a fallback.
 */
export class TurnTakeoverService {
  constructor(private readonly deps: TurnTakeoverDeps) {}

  async adopt(
    turn: TurnSelect,
    lease: { fence: TurnDeliveryFence; signal: AbortSignal },
  ): Promise<TurnTakeoverResult> {
    if (!turn.sandboxSessionId || !turn.conversationId) {
      return unavailable('the turn never reached a sandbox');
    }
    const session = await this.deps.db.getSandboxSession(turn.sandboxSessionId);
    if (!session || session.status !== 'ACTIVE' || !session.containerId) {
      return unavailable(`its sandbox session is ${session?.status?.toLowerCase() ?? 'gone'}`);
    }
    const agent = await this.deps.db.getAgent(turn.agentId);
    if (!agent) {
      return unavailable('its agent no longer exists');
    }
    const agentDef = buildAgentDefinition(agent);
    lease.signal.throwIfAborted();

    let record = this.deps.sessionManager.findSessionById(session.id);
    if (!record?.grpcClient) {
      try {
        record = await this.deps.sessionManager.reconnectActiveSession(session, agentDef);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return unavailable(`its sandbox did not answer: ${message}`);
      }
    }
    lease.signal.throwIfAborted();

    this.deps.logger.info(
      `${TAG} re-attaching turn ${turn.id} to sandbox session ${session.id} `
      + `(fence ${lease.fence.fenceToken})`,
    );
    try {
      await this.deps.executeTurn({
        agentDef,
        messages: [],
        agentId: turn.agentId,
        conversationId: turn.conversationId,
        turnId: turn.id,
        mode: turn.mode === 'background' ? 'background' : 'interactive',
        taskDescription: turn.taskDescription ?? '',
        deliveryContext: { fence: lease.fence },
        sandboxSessionId: session.id,
        signal: lease.signal,
        takeover: true,
      });
    } catch (error) {
      if (error instanceof TurnAttachUnavailableError) {
        this.deps.logger.warn(`${TAG} ${error.message}`);
        return unavailable('the sandbox no longer had the turn running');
      }
      throw error;
    }
    return { outcome: 'adopted' };
  }
}

function unavailable(reason: string): TurnTakeoverResult {
  return { outcome: 'unavailable', reason };
}
