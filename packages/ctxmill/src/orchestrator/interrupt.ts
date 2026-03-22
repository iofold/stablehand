/**
 * Manages HITL (Human-in-the-Loop) interrupts for agent tool calls
 * that require user approval before proceeding.
 *
 * Supports optional Postgres persistence via DatabaseRepository for
 * durable interrupts that survive server restarts.
 */

import type { TypedEventBus } from '../events/bus.js';
import type { DatabaseRepository } from '../database/repository.js';

export interface PendingInterrupt {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  createdAt: number;
}

export interface InterruptResolution {
  action: 'approve' | 'reject' | 'timeout';
  data?: unknown;
}

export class InterruptManager {
  private pending = new Map<
    string,
    {
      resolve: (value: InterruptResolution) => void;
      info: PendingInterrupt;
      agentId?: string;
      timeoutId?: ReturnType<typeof setTimeout>;
    }
  >();
  private eventBus?: TypedEventBus;
  private db?: DatabaseRepository;

  constructor(eventBus?: TypedEventBus, db?: DatabaseRepository) {
    this.eventBus = eventBus;
    this.db = db;
  }

  /**
   * Load stale pending interrupts from the database on startup.
   * Resolves any that have already expired as 'timeout' and
   * returns info about those still pending (for monitoring).
   */
  async loadFromDb(): Promise<void> {
    if (!this.db) return;

    // Clean up expired interrupts
    const now = Date.now();
    try {
      await this.db.cleanupExpiredInterrupts(now);
    } catch (err) {
      console.error('[InterruptManager] failed to cleanup expired interrupts:', err);
    }
  }

  /**
   * Create a pending interrupt and return a promise that resolves
   * when the user responds via the interrupt endpoint.
   *
   * Keyed by runId so that concurrent runs of the same agent don't
   * interfere with each other.
   */
  waitForApproval(
    runId: string,
    agentId: string,
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
    timeoutMs: number = 300_000,
  ): Promise<InterruptResolution> {
    // If there is already a pending interrupt for this run, reject it
    const existing = this.pending.get(runId);
    if (existing) {
      if (existing.timeoutId) clearTimeout(existing.timeoutId);
      existing.resolve({ action: 'reject', data: 'Superseded by new interrupt' });
      this.pending.delete(runId);
    }

    const now = Date.now();
    const expiresAt = now + timeoutMs;

    // Persist to DB (fire-and-forget, don't block the Promise creation)
    if (this.db) {
      this.db.savePendingInterrupt({
        id: runId,
        runId,
        agentId,
        toolCallId,
        toolName,
        args,
        timeoutMs,
        createdAt: now,
        expiresAt,
        status: 'pending',
      }).catch((err) => {
        console.error('[InterruptManager] failed to persist pending interrupt:', err);
      });
    }

    return new Promise<InterruptResolution>((resolve) => {
      const wrappedResolve = (value: InterruptResolution) => {
        const entry = this.pending.get(runId);
        if (entry?.timeoutId) clearTimeout(entry.timeoutId);
        resolve(value);
      };

      const timeoutId = timeoutMs > 0
        ? setTimeout(() => {
            const entry = this.pending.get(runId);
            if (entry) {
              this.pending.delete(runId);
              resolve({ action: 'timeout', data: `Approval timed out after ${Math.round(timeoutMs / 60_000)} minutes` });

              // Update DB status
              if (this.db) {
                this.db.resolveInterrupt(runId, 'timeout', `Approval timed out after ${Math.round(timeoutMs / 60_000)} minutes`).catch((err) => {
                  console.error('[InterruptManager] failed to persist timeout resolution:', err);
                });
              }

              if (this.eventBus) {
                this.eventBus.emit('run.interrupt_resolved', {
                  runId,
                  agentId,
                  interruptId: runId,
                  action: 'timeout',
                  timestamp: Date.now(),
                });
              }
            }
          }, timeoutMs)
        : undefined;

      this.pending.set(runId, {
        resolve: wrappedResolve,
        info: { toolCallId, toolName, args, createdAt: now },
        agentId,
        timeoutId,
      });

      // Emit interrupt event
      if (this.eventBus) {
        this.eventBus.emit('run.interrupted', {
          runId,
          agentId,
          toolCallId,
          toolName,
          args,
          interruptId: runId,
          timestamp: now,
        });
      }
    });
  }

  /**
   * Resolve a pending interrupt with the user's decision.
   * Returns true if there was a pending interrupt, false otherwise.
   */
  resolve(runId: string, action: 'approve' | 'reject' | 'timeout', data?: unknown, agentId?: string): boolean {
    const entry = this.pending.get(runId);
    if (!entry) return false;
    if (entry.timeoutId) clearTimeout(entry.timeoutId);
    entry.resolve({ action, data });
    this.pending.delete(runId);

    // Persist resolution to DB
    if (this.db) {
      this.db.resolveInterrupt(runId, action, data).catch((err) => {
        console.error('[InterruptManager] failed to persist interrupt resolution:', err);
      });
    }

    if (this.eventBus) {
      this.eventBus.emit('run.interrupt_resolved', {
        runId,
        agentId: agentId ?? runId,
        interruptId: runId,
        action,
        timestamp: Date.now(),
      });
    }

    return true;
  }

  /**
   * Check whether a run has a pending interrupt.
   */
  hasPending(runId: string): boolean {
    return this.pending.has(runId);
  }

  /**
   * Check whether any run for a given agent has a pending interrupt.
   */
  hasPendingForAgent(agentId: string): boolean {
    for (const entry of this.pending.values()) {
      if (entry.agentId === agentId) return true;
    }
    return false;
  }

  /**
   * Get info about the pending interrupt for a run, if any.
   */
  getPending(runId: string): PendingInterrupt | undefined {
    return this.pending.get(runId)?.info;
  }

  /**
   * Get all pending interrupts for a given agent from the in-memory map.
   */
  getPendingForAgent(agentId: string): Array<{ runId: string; info: PendingInterrupt }> {
    const results: Array<{ runId: string; info: PendingInterrupt }> = [];
    for (const [runId, entry] of this.pending) {
      if (entry.agentId === agentId) {
        results.push({ runId, info: entry.info });
      }
    }
    return results;
  }

  /**
   * Reject all pending interrupts. Call on server shutdown.
   */
  shutdown(): void {
    for (const [runId, entry] of this.pending) {
      if (entry.timeoutId) clearTimeout(entry.timeoutId);
      entry.resolve({ action: 'reject', data: 'Server shutting down' });

      // Mark as resolved in DB
      if (this.db) {
        this.db.resolveInterrupt(runId, 'reject', 'Server shutting down').catch((err) => {
          console.error('[InterruptManager] failed to persist shutdown resolution:', err);
        });
      }
    }
    this.pending.clear();
  }
}
