/**
 * SessionTurnService — session-turn executor that delegates to SandboxSessionManager.
 *
 * Flow:
 *  1. ensureSession(conversationId, agentDef) — get or create a persistent session
 *  2. deliverTurn(sessionId, messages, turnId) — stream SessionEvents for this turn
 *  3. For each SessionEvent:
 *     - ag_ui_event      → yield the inner AGUIEvent as-is
 *     - message_committed → yield as a MESSAGE_COMMITTED AGUIEvent
 *  4. On abort: killSession(sessionId) to release resources
 */

import type { MessageCommittedEvent } from '@ctxmill/shared';
import type { AGUIEvent } from '../events/types.js';
import type { SessionEvent } from '@ctxmill/sandbox-daemon';
import type { AgentDefinition, Message } from '../types.js';
import type { TypedEventBus } from '../events/bus.js';

export type { AGUISessionEvent, MessageCommittedSessionEvent, TurnFailedSessionEvent, SessionEvent } from '@ctxmill/sandbox-daemon';

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

// ── SandboxSessionManager interface ─────────────────────────

export interface SandboxSessionManager {
  ensureSession(conversationId: string, agentDef: AgentDefinition, agentId: string): Promise<{ sessionId: string }>;
  deliverTurn(sessionId: string, messages: Message[], turnId: string): AsyncGenerator<SessionEvent>;
  killSession(sessionId: string): Promise<void>;
  suspendSession(sessionId: string, reason: string): Promise<unknown>;
  pauseSession(sessionId: string, reason: 'hitl' | 'idle'): Promise<void>;
  resumeSession(sessionId: string): Promise<void>;
  freezeSession(sessionId: string): Promise<void>;
  unfreezeSession(sessionId: string): Promise<void>;
  resumeWithInterruptResolution?(sessionId: string, agentSessionId: string, agentId: string): Promise<void>;
}

// ── Deps ──────────────────────────────────────────────────────

export interface SessionTurnServiceDeps {
  sessionManager: SandboxSessionManager;
  eventBus: TypedEventBus;
  logger?: Logger;
  onSessionReady?: (agentSessionId: string, sandboxSessionId: string) => void;
}

export class SessionTurnService {
  private readonly logger: Logger;

  constructor(private readonly deps: SessionTurnServiceDeps) {
    this.logger = deps.logger ?? defaultLogger;
  }

  /**
   * Execute one conversation turn inside a persistent sandbox session.
   * Yields AGUIEvents so SSE broadcasters and AgentSessionService can consume them uniformly.
   */
  async *executeSessionTurn(
    agentDef: AgentDefinition,
    conversationId: string,
    messages: Message[],
    turnId: string,
    signal?: AbortSignal,
    agentId?: string,
    existingSessionId?: string,
  ): AsyncGenerator<AGUIEvent> {
    const { sessionManager } = this.deps;

    const sessionId = existingSessionId
      ?? (await sessionManager.ensureSession(conversationId, agentDef, agentId ?? agentDef.name)).sessionId;
    this.deps.onSessionReady?.(turnId, sessionId);
    this.logger.debug(`Session ${sessionId} ready for turn ${turnId} (agent=${agentDef.name})`);

    if (signal?.aborted) {
      this.logger.info(`Turn ${turnId} aborted before delivery`);
      return;
    }

    try {
      const stream = sessionManager.deliverTurn(sessionId, messages, turnId);

      for await (const sessionEvent of stream) {
        if (signal?.aborted) {
          this.logger.info(`Turn ${turnId} aborted during streaming`);
          break;
        }

        const aguiEvent = this.convertSessionEvent(sessionEvent, turnId);
        if (aguiEvent !== null) {
          yield aguiEvent;
        }
      }
    } finally {
      if (signal?.aborted) {
        this.logger.info(`Killing session ${sessionId} due to abort`);
        await sessionManager.killSession(sessionId).catch((e: unknown) => {
          this.logger.warn(`Failed to kill session ${sessionId}:`, e);
        });
      }
    }
  }

  // ── SessionEvent → AGUIEvent conversion ─────────────────────

  private convertSessionEvent(
    sessionEvent: SessionEvent,
    turnId: string,
  ): AGUIEvent | null {
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
        const errorEvent: AGUIEvent = {
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
}
