import type { TypedEventBus, EventName, EventMap } from '../events/bus.js';
import type { DatabaseRepository, SuspendedSessionRow } from '../database/repository.js';
import type { WaitCondition } from '../events/wait-condition.js';

export type ResumeMatchResult = void | { outcome: 'retryable-failure'; reason?: string };
import { matchesSelector } from '../events/wait-condition.js';

/** Event types the matcher subscribes to for resume evaluation. */
const WATCHABLE_EVENTS: EventName[] = [
  'turn.started',
  'run.text_chunk',
  'run.tool_started',
  'run.tool_result',
  'run.interrupted',
  'run.interrupt_resolved',
  'turn.completed',
  'feedback.received',
  'agent.created',
  'agent.deleted',
  'client.connected',
  'client.disconnected',
];

const RECONCILIATION_INTERVAL_MS = 30_000;

export class SuspendedSessionMatcher {
  private eventBus: TypedEventBus;
  private db: DatabaseRepository;
  private onResume: (condition: WaitCondition, triggerEvent: unknown) => Promise<ResumeMatchResult>;
  private handlers: Map<EventName, (payload: unknown) => void> = new Map();
  private reconciliationTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    eventBus: TypedEventBus,
    db: DatabaseRepository,
    onResume: (condition: WaitCondition, triggerEvent: unknown) => Promise<ResumeMatchResult>,
  ) {
    this.eventBus = eventBus;
    this.db = db;
    this.onResume = onResume;

    // Subscribe to all watchable event types
    for (const eventType of WATCHABLE_EVENTS) {
      const handler = (payload: unknown) => {
        this.handleEvent(eventType, payload).catch((err) =>
          console.error(`[SuspendedSessionMatcher] error handling ${eventType}:`, err),
        );
      };
      this.handlers.set(eventType, handler as any);
      this.eventBus.on(eventType, handler as any);
    }

    // Start reconciliation loop to expire old suspended runs
    this.reconciliationTimer = setInterval(() => {
      this.db.expireOldSuspendedSessions(Date.now()).catch((err) =>
        console.error('[SuspendedSessionMatcher] reconciliation error:', err),
      );
    }, RECONCILIATION_INTERVAL_MS);
  }

  private async handleEvent(eventType: string, payload: unknown): Promise<void> {
    let suspendedSessions: SuspendedSessionRow[];
    try {
      suspendedSessions = await this.db.getSuspendedSessionsByEventType(eventType);
    } catch (err) {
      console.error(`[SuspendedSessionMatcher] DB query error for ${eventType}:`, err);
      return;
    }

    for (const row of suspendedSessions) {
      let selector: Record<string, unknown>;
      try {
        selector = JSON.parse(row.waitSelector);
      } catch {
        console.error(`[SuspendedSessionMatcher] invalid selector JSON for suspended session ${row.id}`);
        continue;
      }

      const payloadObj = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;

      if (matchesSelector(payloadObj, selector)) {
        const suspendedDurationMs = Date.now() - row.createdAt;
        const sessionId = row.agentSessionId;

        // Build WaitCondition from the row before mutating DB state. The wait
        // row is the durable retry handle; keep it until the resume callback has
        // either completed successfully or explicitly reports a retryable miss.
        let snapshotState: WaitCondition['contextSnapshot'];
        try {
          snapshotState = JSON.parse(row.snapshotState);
        } catch {
          snapshotState = { conversationId: '' };
        }

        const condition = {
          id: row.id,
          sessionId,
          agentId: row.agentId,
          eventType: row.waitEventType,
          selector,
          expiresAt: row.waitExpiresAt ?? undefined,
          contextSnapshot: snapshotState,
          createdAt: row.createdAt,
        } as unknown as WaitCondition;

        try {
          const resumeResult = await this.onResume(condition, payload);
          if (resumeResult?.outcome === 'retryable-failure') {
            console.warn(
              `[SuspendedSessionMatcher] resume for ${row.id} deferred as retryable: ${resumeResult.reason ?? 'no reason provided'}`,
            );
            continue;
          }
        } catch (err) {
          console.error(`[SuspendedSessionMatcher] onResume callback error for ${row.id}; keeping wait row for retry:`, err);
          continue;
        }

        try {
          await this.db.deleteSuspendedSession(row.id);
        } catch (err) {
          console.error(`[SuspendedSessionMatcher] failed to delete suspended session ${row.id}:`, err);
          continue;
        }

        this.eventBus.emit('run.resumed', {
          turnId: sessionId,
          agentId: row.agentId,
          triggeredBy: eventType,
          suspendedDurationMs,
          timestamp: Date.now(),
        } as unknown as EventMap['run.resumed']);
      }
    }
  }

  shutdown(): void {
    // Remove all event listeners
    for (const [eventType, handler] of this.handlers) {
      this.eventBus.off(eventType, handler as any);
    }
    this.handlers.clear();

    // Clear reconciliation interval
    if (this.reconciliationTimer) {
      clearInterval(this.reconciliationTimer);
      this.reconciliationTimer = null;
    }
  }
}
