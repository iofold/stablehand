/**
 * Manages HITL (Human-in-the-Loop) interrupts for agent tool calls
 * that require user approval before proceeding.
 *
 * Supports optional Postgres persistence via DatabaseRepository for
 * durable interrupts that survive server restarts.
 */

import type { EventMap, TypedEventBus } from '../events/bus.js';
import type { DatabaseRepository } from '../database/repository.js';

type InterruptStore = Pick<
  DatabaseRepository,
  'cleanupExpiredInterrupts' | 'getAllPendingInterrupts' | 'savePendingInterrupt' | 'resolveInterrupt'
>;

interface PendingEntry {
  resolve: (value: InterruptResolution) => void;
  info: PendingInterrupt;
  agentId?: string;
  timeoutId?: ReturnType<typeof setTimeout>;
}

export interface PendingInterrupt {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  createdAt: number;
  sessionId?: string;
}

export interface InterruptResolution {
  action: 'approve' | 'reject' | 'suspend' | 'timeout';
  data?: unknown;
}

export class InterruptManager {
  private pending = new Map<string, PendingEntry>();
  private eventBus?: TypedEventBus;
  private db?: InterruptStore;
  private readonly onTimeout?: (sessionId: string) => Promise<void>;

  constructor(eventBus?: TypedEventBus, db?: InterruptStore, onTimeout?: (sessionId: string) => Promise<void>) {
    this.eventBus = eventBus;
    this.db = db;
    this.onTimeout = onTimeout;
  }

  private createPendingPromise(
    turnId: string,
    agentId: string,
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
    createdAt: number,
    timeoutMs: number,
    emitInterruptedEvent: boolean,
    sessionId?: string,
  ): Promise<InterruptResolution> {
    return new Promise<InterruptResolution>((resolve) => {
      const wrappedResolve = (value: InterruptResolution) => {
        const entry = this.pending.get(turnId);
        if (entry?.timeoutId) clearTimeout(entry.timeoutId);
        resolve(value);
      };

      const timeoutId = timeoutMs > 0
        ? setTimeout(() => {
            const entry = this.pending.get(turnId);
            if (entry) {
              this.pending.delete(turnId);
              resolve({ action: 'suspend', data: 'Session suspended for HITL approval — awaiting human decision' });

              if (this.db) {
                this.db.resolveInterrupt(turnId, 'suspend', 'Session suspended for HITL approval — awaiting human decision').catch((err) => {
                  console.error('[InterruptManager] failed to persist timeout resolution:', err);
                });
              }

              if (this.eventBus) {
                this.eventBus.emit('run.interrupt_resolved', {
                  turnId,
                  agentId,
                  interruptId: turnId,
                  action: 'suspend',
                  timestamp: Date.now(),
                } as unknown as EventMap['run.interrupt_resolved']);
              }

              // Cooperatively checkpoint the session on HITL timeout.
              // The InterruptManager is the sole owner of the HITL deadline —
              // the container lifecycle policy has no knowledge of HITL.
              if (this.onTimeout && entry.info.sessionId) {
                void this.onTimeout(entry.info.sessionId).catch((err) => {
                  console.error('[InterruptManager] onTimeout callback failed:', err);
                });
              }
            }
          }, timeoutMs)
        : undefined;

      this.pending.set(turnId, {
        resolve: wrappedResolve,
        info: { toolCallId, toolName, args, createdAt, sessionId },
        agentId,
        timeoutId,
      });

      if (emitInterruptedEvent && this.eventBus) {
        this.eventBus.emit('run.interrupted', {
          turnId,
          agentId,
          toolCallId,
          toolName,
          args,
          interruptId: turnId,
          timestamp: createdAt,
        } as unknown as EventMap['run.interrupted']);
      }
    });
  }

  /**
   * Load stale pending interrupts from the database on startup.
   * Resolves any that have already expired as 'timeout' and
   * returns info about those still pending (for monitoring).
   */
  async loadFromDb(): Promise<void> {
    if (!this.db) return;

    const now = Date.now();
    try {
      await this.db.cleanupExpiredInterrupts(now);
    } catch (err) {
      console.error('[InterruptManager] failed to cleanup expired interrupts:', err);
    }

    try {
      const records = await this.db.getAllPendingInterrupts();
      let reloadedCount = 0;
      for (const record of records) {
        const remainingMs = record.expiresAt - now;
        if (remainingMs <= 0 || this.pending.has(record.agentSessionId)) {
          continue;
        }

        void this.createPendingPromise(
          record.agentSessionId,
          record.agentId,
          record.toolCallId,
          record.toolName,
          record.args,
          record.createdAt,
          remainingMs,
          false,
        );
        reloadedCount += 1;
      }

      console.info(`[InterruptManager] reloaded ${reloadedCount} pending interrupt(s) from database`);
    } catch (err) {
      console.error('[InterruptManager] failed to reload pending interrupts:', err);
    }
  }

  /**
   * Create a pending interrupt and return a promise that resolves
   * when the user responds via the interrupt endpoint.
   *
   * Keyed by turnId so that concurrent turns of the same agent don't
   * interfere with each other.
   */
  waitForApproval(
    turnId: string,
    agentId: string,
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
    timeoutMs: number = 300_000,
    sessionId?: string,
  ): Promise<InterruptResolution> {
    // If there is already a pending interrupt for this run, reject it
    const existing = this.pending.get(turnId);
    if (existing) {
      if (existing.timeoutId) clearTimeout(existing.timeoutId);
      existing.resolve({ action: 'reject', data: 'Superseded by new interrupt' });
      this.pending.delete(turnId);
    }

    const now = Date.now();
    const expiresAt = now + timeoutMs;

    // Persist to DB (fire-and-forget, don't block the Promise creation)
    if (this.db) {
      this.db.savePendingInterrupt({
        id: turnId,
        agentSessionId: turnId,
        agentId,
        toolCallId,
        toolName,
        args,
        timeoutMs,
        createdAt: now,
        expiresAt,
        status: 'pending',
        sessionId,
      }).catch((err) => {
        console.error('[InterruptManager] failed to persist pending interrupt:', err);
      });
    }

    return this.createPendingPromise(
      turnId,
      agentId,
      toolCallId,
      toolName,
      args,
      now,
      timeoutMs,
      true,
      sessionId,
    );
  }

  /**
   * Resolve a pending interrupt with the user's decision.
   * Returns true if there was a pending interrupt, false otherwise.
   */
  resolve(turnId: string, action: 'approve' | 'reject' | 'suspend' | 'timeout', data?: unknown, agentId?: string): boolean {
    const entry = this.pending.get(turnId);
    if (!entry) return false;
    if (entry.timeoutId) clearTimeout(entry.timeoutId);
    entry.resolve({ action, data });
    this.pending.delete(turnId);

    // Persist resolution to DB
    if (this.db) {
      this.db.resolveInterrupt(turnId, action, data).catch((err) => {
        console.error('[InterruptManager] failed to persist interrupt resolution:', err);
      });
    }

    if (this.eventBus) {
      this.eventBus.emit('run.interrupt_resolved', {
        turnId,
        agentId: agentId ?? turnId,
        interruptId: turnId,
        action,
        timestamp: Date.now(),
      } as unknown as EventMap['run.interrupt_resolved']);
    }

    return true;
  }

  /** Resolve a pending interrupt by sessionId. Returns true if a match was found. */
  resolveForSession(sessionId: string, action: 'approve' | 'reject' | 'suspend' | 'timeout', data?: unknown): boolean {
    for (const [turnId, entry] of this.pending) {
      if (entry.info.sessionId === sessionId) {
        return this.resolve(turnId, action, data, entry.agentId);
      }
    }
    return false;
  }

  /**
   * Check whether a turn has a pending interrupt.
   */
  hasPending(turnId: string): boolean {
    return this.pending.has(turnId);
  }

  /**
   * Check whether any turn for a given agent has a pending interrupt.
   */
  hasPendingForAgent(agentId: string): boolean {
    for (const entry of this.pending.values()) {
      if (entry.agentId === agentId) return true;
    }
    return false;
  }

  /**
   * Get info about the pending interrupt for a turn, if any.
   */
  getPending(turnId: string): PendingInterrupt | undefined {
    return this.pending.get(turnId)?.info;
  }

  /**
   * Get all pending interrupts for a given agent from the in-memory map.
   */
  getPendingForAgent(agentId: string): Array<{ turnId: string; info: PendingInterrupt }> {
    const results: Array<{ turnId: string; info: PendingInterrupt }> = [];
    for (const [turnId, entry] of this.pending) {
      if (entry.agentId === agentId) {
        results.push({ turnId, info: entry.info });
      }
    }
    return results;
  }

  /**
   * Reject all pending interrupts. Call on server shutdown.
   */
  shutdown(): void {
    for (const [turnId, entry] of this.pending) {
      if (entry.timeoutId) clearTimeout(entry.timeoutId);
      entry.resolve({ action: 'reject', data: 'Server shutting down' });

      // Mark as resolved in DB
      if (this.db) {
        this.db.resolveInterrupt(turnId, 'reject', 'Server shutting down').catch((err) => {
          console.error('[InterruptManager] failed to persist shutdown resolution:', err);
        });
      }
    }
    this.pending.clear();
  }
}
