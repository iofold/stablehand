import type { TypedEventBus, EventName, EventMap } from '../events/bus.js';
import type { DatabaseRepository } from '../database/repository.js';
import type { WaitCondition } from '../events/wait-condition.js';
import { matchesSelector } from '../events/wait-condition.js';

/** Event types the matcher subscribes to for resume evaluation. */
const WATCHABLE_EVENTS: EventName[] = [
  'run.started',
  'run.text_chunk',
  'run.tool_started',
  'run.tool_result',
  'run.interrupted',
  'run.interrupt_resolved',
  'run.completed',
  'feedback.received',
  'agent.created',
  'agent.deleted',
  'client.connected',
  'client.disconnected',
  'learning.trace_captured',
  'learning.insight_extracted',
  'learning.knowledge_updated',
];

const RECONCILIATION_INTERVAL_MS = 30_000;

export class SuspendedRunMatcher {
  private eventBus: TypedEventBus;
  private db: DatabaseRepository;
  private onResume: (condition: WaitCondition, triggerEvent: unknown) => Promise<void>;
  private handlers: Map<EventName, (payload: unknown) => void> = new Map();
  private reconciliationTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    eventBus: TypedEventBus,
    db: DatabaseRepository,
    onResume: (condition: WaitCondition, triggerEvent: unknown) => Promise<void>,
  ) {
    this.eventBus = eventBus;
    this.db = db;
    this.onResume = onResume;

    // Subscribe to all watchable event types
    for (const eventType of WATCHABLE_EVENTS) {
      const handler = (payload: unknown) => {
        this.handleEvent(eventType, payload).catch((err) =>
          console.error(`[SuspendedRunMatcher] error handling ${eventType}:`, err),
        );
      };
      this.handlers.set(eventType, handler as any);
      this.eventBus.on(eventType, handler as any);
    }

    // Start reconciliation loop to expire old suspended runs
    this.reconciliationTimer = setInterval(() => {
      this.db.expireOldSuspendedRuns(Date.now()).catch((err) =>
        console.error('[SuspendedRunMatcher] reconciliation error:', err),
      );
    }, RECONCILIATION_INTERVAL_MS);
  }

  private async handleEvent(eventType: string, payload: unknown): Promise<void> {
    let suspendedRuns;
    try {
      suspendedRuns = await this.db.getSuspendedRunsByEventType(eventType);
    } catch (err) {
      console.error(`[SuspendedRunMatcher] DB query error for ${eventType}:`, err);
      return;
    }

    for (const row of suspendedRuns) {
      let selector: Record<string, unknown>;
      try {
        selector = JSON.parse(row.waitSelector);
      } catch {
        console.error(`[SuspendedRunMatcher] invalid selector JSON for suspended run ${row.id}`);
        continue;
      }

      const payloadObj = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;

      if (matchesSelector(payloadObj, selector)) {
        try {
          await this.db.deleteSuspendedRun(row.id);
        } catch (err) {
          console.error(`[SuspendedRunMatcher] failed to delete suspended run ${row.id}:`, err);
          continue;
        }

        const suspendedDurationMs = Date.now() - row.createdAt;

        this.eventBus.emit('run.resumed', {
          runId: row.agentRunId,
          agentId: row.agentId,
          triggeredBy: eventType,
          suspendedDurationMs,
          timestamp: Date.now(),
        });

        // Build WaitCondition from the row
        let snapshotState: WaitCondition['contextSnapshot'];
        try {
          snapshotState = JSON.parse(row.snapshotState);
        } catch {
          snapshotState = { conversationId: '' };
        }

        const condition: WaitCondition = {
          id: row.id,
          runId: row.agentRunId,
          agentId: row.agentId,
          eventType: row.waitEventType,
          selector,
          expiresAt: row.waitExpiresAt ?? undefined,
          contextSnapshot: snapshotState,
          createdAt: row.createdAt,
        };

        try {
          await this.onResume(condition, payload);
        } catch (err) {
          console.error(`[SuspendedRunMatcher] onResume callback error for ${row.id}:`, err);
        }
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
