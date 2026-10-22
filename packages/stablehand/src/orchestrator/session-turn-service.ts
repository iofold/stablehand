/**
 * Session-turn executor that delegates to SandboxSessionManager.
 *
 * Flow:
 *  1. ensureSession(conversationId, agentDef) — get or create a persistent session
 *  2. deliverTurn(sessionId, messages, turnId) — stream SessionEvents for this turn
 *  3. For each SessionEvent:
 *     - agent_event      → yield the inner agent event as-is
 *     - message_committed → yield as a MESSAGE_COMMITTED AgentSessionEvent
 *  4. On abort: stop consuming the turn stream and preserve the persistent session
 */

import type { MessageCommittedEvent } from '@stablehand/shared';
import type { AgentSessionEvent } from '../events/types.js';
import type { SessionEvent } from '@stablehand/sandbox-daemon';
import type { AgentDefinition, Message } from '@stablehand/sandbox-daemon';
import type { SandboxSessionManager } from './sandbox-session-manager.js';
import type { TurnSecrets } from './session-manager/turn-secrets.js';
import { stampDelivery } from './delivery-stamp.js';

export type { AGUISessionEvent, MessageCommittedSessionEvent, TurnFailedSessionEvent, SessionEvent } from '@stablehand/sandbox-daemon';

// ── Logger interface ─────────────────────────────────────────

export interface Logger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
}

const TAG = '[SessionTurnService]';

const defaultLogger: Logger = {
  info: (msg, ...args) => console.log(`${TAG} ${msg}`, ...args),
  warn: (msg, ...args) => console.warn(`${TAG} ${msg}`, ...args),
  error: (msg, ...args) => console.error(`${TAG} ${msg}`, ...args),
  debug: (msg, ...args) => console.debug(`${TAG} ${msg}`, ...args),
};

export type SessionTurnSessionManager = {
  ensureSession: (
    ...args: Parameters<SandboxSessionManager['ensureSession']>
  ) => Promise<Pick<Awaited<ReturnType<SandboxSessionManager['ensureSession']>>, 'sessionId'>>;
  deliverTurn: SandboxSessionManager['deliverTurn'];
};

export interface SessionTurnExecutorDeps {
  sessionManager: SessionTurnSessionManager;
  logger?: Logger;
}

export interface SessionTurnExecutionOptions {
  signal?: AbortSignal;
  agentId?: string;
  existingSessionId?: string;
  turnSecrets?: TurnSecrets;
  /**
   * Re-attach to a delivery that is already running in the sandbox instead
   * of delivering the turn (crash takeover, ADR 025).
   */
  attach?: { afterDeliverySeq: number };
}

export interface SessionTurnExecutor {
  executeSessionTurn(
    agentDef: AgentDefinition,
    conversationId: string,
    messages: Message[],
    turnId: string,
    options?: SessionTurnExecutionOptions,
  ): AsyncGenerator<AgentSessionEvent>;
}

export function createSessionTurnExecutor(deps: SessionTurnExecutorDeps): SessionTurnExecutor {
  const logger = deps.logger ?? defaultLogger;

  return {
    executeSessionTurn: (
      agentDef,
      conversationId,
      messages,
      turnId,
      options,
    ) => executeSessionTurn(
      deps,
      logger,
      agentDef,
      conversationId,
      messages,
      turnId,
      options,
    ),
  };
}

/** Execute one conversation turn inside a persistent sandbox session. */
async function* executeSessionTurn(
  deps: SessionTurnExecutorDeps,
  logger: Logger,
  agentDef: AgentDefinition,
  conversationId: string,
  messages: Message[],
  turnId: string,
  options?: SessionTurnExecutionOptions,
): AsyncGenerator<AgentSessionEvent> {
  const { sessionManager } = deps;
  const {
    signal,
    agentId,
    existingSessionId,
    turnSecrets,
    attach,
  } = options ?? {};

  const sessionId = existingSessionId
    ?? (await sessionManager.ensureSession(conversationId, agentDef, agentId ?? agentDef.name)).sessionId;
  logger.debug(`Session ${sessionId} ready for turn ${turnId} (agent=${agentDef.name})`);

  if (signal?.aborted) {
    logger.info(`Turn ${turnId} aborted before delivery`);
    return;
  }

  try {
    const deliveryOptions = {
      ...(signal ? { signal } : {}),
      ...(turnSecrets ? { turnSecrets: { ...turnSecrets } } : {}),
      ...(attach ? { attach } : {}),
    };
    const stream = sessionManager.deliverTurn(
      sessionId,
      messages,
      turnId,
      Object.keys(deliveryOptions).length > 0 ? deliveryOptions : undefined,
    );

    for await (const sessionEvent of stream) {
      if (signal?.aborted) {
        logger.info(`Turn ${turnId} aborted during streaming`);
        break;
      }

      const aguiEvent = convertSessionEvent(sessionEvent, turnId);
      if (aguiEvent !== null) {
        yield stampDelivery(aguiEvent, sessionEvent.delivery);
      }
    }
  } finally {
    if (signal?.aborted) {
      logger.info(`Turn ${turnId} aborted; preserving session ${sessionId}`);
    }
  }
}

function convertSessionEvent(
  sessionEvent: SessionEvent,
  turnId: string,
): AgentSessionEvent | null {
  switch (sessionEvent.type) {
    case 'ag_ui_event':
      return sessionEvent.event;

    case 'message_committed': {
      const event: MessageCommittedEvent = {
        type: 'MESSAGE_COMMITTED',
        timestamp: Date.now(),
        // turnId serves as the agent session id in the session-turn model
        runId: turnId,
        role: sessionEvent.role,
        content: sessionEvent.content,
        toolCalls: sessionEvent.toolCalls,
        toolCallId: sessionEvent.toolCallId,
        turnId: sessionEvent.turnId,
        messageSeq: sessionEvent.messageSeq,
      };
      return event;
    }

    case 'turn_failed': {
      const errorEvent: AgentSessionEvent = {
        type: 'RUN_ERROR',
        timestamp: Date.now(),
        runId: turnId,
        error: sessionEvent.errorMessage,
      };
      return errorEvent;
    }

    default:
      return null;
  }
}
