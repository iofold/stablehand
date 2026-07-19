/**
 * Manages HITL (Human-in-the-Loop) interrupts for agent tool calls
 * that require user approval before proceeding.
 *
 * Supports optional Postgres persistence via DatabaseRepository for
 * durable interrupts that survive server restarts.
 */

import type { EventMap, TypedEventBus } from '../events/bus.js';
import type { DatabaseRepository } from '../database/repository.js';
import { randomUUID } from 'node:crypto';

type InterruptStore = Pick<
  DatabaseRepository,
  'cleanupExpiredInterrupts' | 'getAllPendingInterrupts' | 'savePendingInterrupt' | 'resolveInterrupt' | 'markInterruptTimedOut'
>;

interface PendingEntry {
  resolve: (value: InterruptResolution) => void;
  info: PendingInterrupt;
  agentId?: string;
  timeoutId?: ReturnType<typeof setTimeout>;
  /**
   * True when an in-process generator is awaiting this entry's promise.
   * Entries rehydrated from the database after a restart have no live
   * waiter — resolving them must fall through to the durable resume path
   * (ctx-8nnu) instead of resolving an orphan promise into the void.
   */
  hasLiveWaiter: boolean;
}

export interface PendingInterrupt {
  interruptId: string;
  toolCallId: string;
  toolCallName: string;
  args: Record<string, unknown>;
  createdAt: number;
  sandboxSessionId?: string;
  conversationId?: string;
}

export interface InterruptResolution {
  action: 'approve' | 'reject' | 'suspend' | 'timeout';
  data?: unknown;
}

export class InterruptManager {
  private pending = new Map<string, PendingEntry>();
  private pendingInstallations = new Map<string, Promise<void>>();
  private eventBus?: TypedEventBus;
  private db?: InterruptStore;
  private readonly onTimeout?: (sessionId: string) => Promise<void>;

  constructor(eventBus?: TypedEventBus, db?: InterruptStore, onTimeout?: (sessionId: string) => Promise<void>) {
    this.eventBus = eventBus;
    this.db = db;
    this.onTimeout = onTimeout;
  }

  private async emitResolvedEvent(
    turnId: string,
    interruptId: string,
    action: 'approve' | 'reject' | 'suspend' | 'timeout',
    agentId?: string,
    conversationId?: string,
    sandboxSessionId?: string,
  ): Promise<void> {
    if (!this.eventBus) {
      return;
    }

    await this.eventBus.emitAsync('interrupt.resolved', {
      turnId,
      agentId: agentId ?? turnId,
      conversationId: conversationId ?? turnId,
      ...(sandboxSessionId ? { sandboxSessionId } : {}),
      interruptId,
      action,
      timestamp: Date.now(),
    } as unknown as EventMap['interrupt.resolved']);
  }

  private createPendingPromise(
    turnId: string,
    interruptId: string,
    agentId: string,
    toolCallId: string,
    toolCallName: string,
    args: Record<string, unknown>,
    createdAt: number,
    timeoutMs: number,
    emitInterruptedEvent: boolean,
    sandboxSessionId: string | undefined,
    conversationId: string | undefined,
    hasLiveWaiter: boolean,
  ): Promise<InterruptResolution> {
    return new Promise<InterruptResolution>((resolve) => {
      const timeoutId = timeoutMs > 0
        ? setTimeout(() => {
          const entry = this.pending.get(turnId);
          if (entry) {
            void this.handleTimeout(
              turnId,
              agentId,
              entry.info.sandboxSessionId,
              'Session suspended for HITL approval — awaiting human decision',
            );
          }
        }, timeoutMs)
        : undefined;
      const wrappedResolve = (value: InterruptResolution) => {
        if (timeoutId) clearTimeout(timeoutId);
        resolve(value);
      };

      this.pending.set(turnId, {
        resolve: wrappedResolve,
        info: { interruptId, toolCallId, toolCallName, args, createdAt, sandboxSessionId, conversationId },
        agentId,
        timeoutId,
        hasLiveWaiter,
      });

      if (emitInterruptedEvent && this.eventBus) {
        this.eventBus.emit('interrupt.requested', {
          turnId,
          agentId,
          conversationId: conversationId ?? turnId,
          ...(sandboxSessionId ? { sandboxSessionId } : {}),
          toolCallId,
          toolCallName,
          args,
          interruptId,
          timestamp: createdAt,
        } as unknown as EventMap['interrupt.requested']);
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
        if (remainingMs <= 0 || this.pending.has(record.turnId)) {
          continue;
        }

        void this.createPendingPromise(
          record.turnId,
          record.id,
          record.agentId,
          record.toolCallId,
          record.toolName,
          record.args,
          record.createdAt,
          remainingMs,
          false,
          record.sandboxSessionId ?? undefined,
          undefined,
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
  async waitForApproval(
    turnId: string,
    agentId: string,
    toolCallId: string,
    toolCallName: string,
    args: Record<string, unknown>,
    timeoutMs: number = 300_000,
    sandboxSessionId?: string,
    conversationId?: string,
  ): Promise<InterruptResolution> {
    const install = () => this.installApprovalWaiter(
      turnId,
      agentId,
      toolCallId,
      toolCallName,
      args,
      timeoutMs,
      sandboxSessionId,
      conversationId,
    );
    const previousInstallation = this.pendingInstallations.get(turnId);
    let settleInstallationTail!: () => void;
    const installationTail = new Promise<void>((resolve) => {
      settleInstallationTail = resolve;
    });
    this.pendingInstallations.set(turnId, installationTail);
    const installation = previousInstallation
      ? previousInstallation.then(install)
      : install();
    void installation.then(
      settleInstallationTail,
      settleInstallationTail,
    );
    void installationTail.then(() => {
      if (this.pendingInstallations.get(turnId) === installationTail) {
        this.pendingInstallations.delete(turnId);
      }
    });

    const { approval } = await installation;
    return approval;
  }

  private async installApprovalWaiter(
    turnId: string,
    agentId: string,
    toolCallId: string,
    toolCallName: string,
    args: Record<string, unknown>,
    timeoutMs: number,
    sandboxSessionId: string | undefined,
    conversationId: string | undefined,
  ): Promise<{ approval: Promise<InterruptResolution> }> {
    // If there is already a pending interrupt for this run, reject it
    const existing = this.pending.get(turnId);
    const supersededResolution: InterruptResolution = {
      action: 'reject',
      data: 'Superseded by new interrupt',
    };
    const settleExisting = () => {
      if (!existing) return;
      if (this.pending.get(turnId) === existing) {
        this.pending.delete(turnId);
      }
      existing.resolve(supersededResolution);
    };
    if (existing) {
      let durableResolutionPersisted = false;
      if (this.db) {
        const persisted = await this.db.resolveInterrupt(
          existing.info.interruptId,
          'reject',
          'Superseded by new interrupt',
        );
        if (!persisted) {
          throw new Error(`Failed to supersede pending interrupt ${turnId}`);
        }
        durableResolutionPersisted = true;
      }
      try {
        await this.emitResolvedEvent(
          turnId,
          existing.info.interruptId,
          'reject',
          existing.agentId,
          existing.info.conversationId,
          existing.info.sandboxSessionId,
        );
      } catch (error) {
        if (durableResolutionPersisted) {
          settleExisting();
        }
        throw error;
      }
      if (existing.timeoutId) clearTimeout(existing.timeoutId);
    }

    const now = Date.now();
    const expiresAt = now + timeoutMs;
    const interruptId = randomUUID();

    try {
      if (this.db) {
        await this.db.savePendingInterrupt({
          id: interruptId,
          turnId,
          agentId,
          toolCallId,
          toolName: toolCallName,
          args,
          timeoutMs,
          createdAt: now,
          expiresAt,
          status: 'pending',
          sandboxSessionId,
        });
      }

      const replacement = this.createPendingPromise(
        turnId,
        interruptId,
        agentId,
        toolCallId,
        toolCallName,
        args,
        now,
        timeoutMs,
        true,
        sandboxSessionId,
        conversationId,
        true,
      );
      settleExisting();
      return { approval: replacement };
    } catch (error) {
      settleExisting();
      throw error;
    }
  }

  /**
   * Resolve a pending interrupt with the user's decision.
   * Returns true if there was a pending interrupt, false otherwise.
   */
  async resolveForTurn(
    turnId: string,
    action: 'approve' | 'reject' | 'suspend' | 'timeout',
    data?: unknown,
    agentId?: string,
    conversationId?: string,
  ): Promise<boolean> {
    const entry = this.pending.get(turnId);
    if (!entry) return false;

    if (this.db) {
      const persisted = await this.db.resolveInterrupt(entry.info.interruptId, action, data);
      if (!persisted) {
        return false;
      }
    }

    return this.settlePersistedResolutionForTurn(
      turnId,
      entry.info.interruptId,
      action,
      data,
      agentId,
      conversationId,
    );
  }

  /**
   * Settle the in-memory projection after another transaction has already
   * persisted the resolution. This is used for rehydrated entries whose
   * durable continuation attempt must be created atomically with resolution.
   */
  async settlePersistedResolutionForTurn(
    turnId: string,
    interruptId: string,
    action: 'approve' | 'reject' | 'suspend' | 'timeout',
    data?: unknown,
    agentId?: string,
    conversationId?: string,
  ): Promise<boolean> {
    const entry = this.pending.get(turnId);
    if (!entry || entry.info.interruptId !== interruptId) {
      return false;
    }

    if (entry.timeoutId) clearTimeout(entry.timeoutId);
    await this.emitResolvedEvent(
      turnId,
      interruptId,
      action,
      agentId ?? entry.agentId,
      conversationId ?? entry.info.conversationId,
      entry.info.sandboxSessionId,
    );
    entry.resolve({ action, data });
    if (this.pending.get(turnId) === entry) {
      this.pending.delete(turnId);
    }

    return true;
  }

  /**
   * Check whether a turn has a pending interrupt.
   */
  hasPendingForTurn(turnId: string): boolean {
    return this.pending.has(turnId);
  }

  /** Whether an in-process generator is awaiting this interrupt (false for rehydrated entries). */
  hasLiveWaiterForTurn(turnId: string): boolean {
    return this.pending.get(turnId)?.hasLiveWaiter ?? false;
  }

  /** Whether the pending in-memory interrupt belongs to the given agent (ctx-aac). */
  ownsPendingForTurn(turnId: string, agentId: string): boolean {
    const entry = this.pending.get(turnId);
    return entry ? entry.agentId === agentId : false;
  }

  /** Find the execution turn that owns an in-memory interrupt. */
  findTurnIdByInterruptId(interruptId: string): string | undefined {
    for (const [turnId, entry] of this.pending) {
      if (entry.info.interruptId === interruptId) return turnId;
    }
    return undefined;
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
    for (const entry of this.pending.values()) {
      if (entry.timeoutId) clearTimeout(entry.timeoutId);
      entry.resolve({ action: 'reject', data: 'Server shutting down' });

      // Mark as resolved in DB
      if (this.db) {
        this.db.resolveInterrupt(entry.info.interruptId, 'reject', 'Server shutting down').catch((err) => {
          console.error('[InterruptManager] failed to persist shutdown resolution:', err);
        });
      }
    }
    this.pending.clear();
  }

  private async handleTimeout(
    turnId: string,
    agentId: string,
    sandboxSessionId: string | undefined,
    message: string,
  ): Promise<void> {
    try {
      const entry = this.pending.get(turnId);
      if (!entry) {
        return;
      }

      if (this.db) {
        const timedOut = await this.db.markInterruptTimedOut(entry.info.interruptId, message);
        if (!timedOut) {
          return;
        }
      }

      if (entry.timeoutId) clearTimeout(entry.timeoutId);
      await this.emitResolvedEvent(
        turnId,
        entry.info.interruptId,
        'timeout',
        agentId ?? entry.agentId,
        entry.info.conversationId,
        entry.info.sandboxSessionId,
      );
      entry.resolve({ action: 'suspend', data: message });
      if (this.pending.get(turnId) === entry) {
        this.pending.delete(turnId);
      }

      if (this.onTimeout && sandboxSessionId) {
        await this.onTimeout(sandboxSessionId);
      }
    } catch (err) {
      console.error('[InterruptManager] failed to handle timeout resolution:', err);
    }
  }
}
