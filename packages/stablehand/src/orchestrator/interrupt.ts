/**
 * Manages HITL (Human-in-the-Loop) interrupts for agent tool calls
 * that require user approval before proceeding.
 *
 * Supports optional Postgres persistence via DatabaseRepository for
 * durable interrupts that survive server restarts.
 */

import type {
  EventMap,
  EventPersistenceContext,
  TypedEventBus,
} from '../events/bus.js';
import type {
  DatabaseRepository,
  ExpectedSandboxCallbackDelivery,
  InterruptResolutionAudit,
} from '../database/repository.js';
import { randomUUID } from 'node:crypto';

type InterruptStore = Pick<
  DatabaseRepository,
  'cleanupExpiredInterrupts' | 'getAllPendingInterrupts' | 'savePendingInterrupt' | 'resolveInterrupt' | 'markInterruptTimedOut'
> & Partial<Pick<
  DatabaseRepository,
  'installPendingInterruptIfSandboxCallbackCurrent' | 'deletePendingInterruptInstallation'
>>;

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
  toolName: string;
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
  private readonly onTimeout?: (sessionId: string, turnId: string) => Promise<void>;

  constructor(
    eventBus?: TypedEventBus,
    db?: InterruptStore,
    onTimeout?: (sessionId: string, turnId: string) => Promise<void>,
  ) {
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
    persistenceContext?: EventPersistenceContext,
    audit?: InterruptResolutionAudit,
  ): Promise<void> {
    if (!this.eventBus) {
      return;
    }

    const didEmit = await this.eventBus.emitAsync('interrupt.resolved', {
      turnId,
      agentId: agentId ?? turnId,
      conversationId: conversationId ?? turnId,
      ...(sandboxSessionId ? { sandboxSessionId } : {}),
      interruptId,
      action,
      ...(audit?.resolvedBy ? { resolvedBy: audit.resolvedBy } : {}),
      ...(audit?.reason ? { reason: audit.reason } : {}),
      timestamp: Date.now(),
    } as unknown as EventMap['interrupt.resolved'], persistenceContext);
    if (!didEmit) {
      throw new Error(
        `Interrupt resolution event was rejected for stale turn delivery ${turnId}`,
      );
    }
  }

  private async emitRequestedEvent(
    turnId: string,
    agentId: string,
    conversationId: string | undefined,
    sandboxSessionId: string | undefined,
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
    interruptId: string,
    createdAt: number,
    persistenceContext?: EventPersistenceContext,
  ): Promise<void> {
    if (!this.eventBus) {
      return;
    }

    const didEmit = await this.eventBus.emitAsync('interrupt.requested', {
      turnId,
      agentId,
      conversationId: conversationId ?? turnId,
      ...(sandboxSessionId ? { sandboxSessionId } : {}),
      toolCallId,
      toolName,
      args,
      interruptId,
      timestamp: createdAt,
    } as unknown as EventMap['interrupt.requested'], persistenceContext);
    if (!didEmit) {
      throw new Error(
        `Interrupt request event was rejected for stale turn delivery ${turnId}`,
      );
    }
  }

  private createPendingPromise(
    turnId: string,
    interruptId: string,
    agentId: string,
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
    createdAt: number,
    timeoutMs: number,
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
        info: { interruptId, toolCallId, toolName, args, createdAt, sandboxSessionId, conversationId },
        agentId,
        timeoutId,
        hasLiveWaiter,
      });

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
    toolName: string,
    args: Record<string, unknown>,
    timeoutMs: number = 300_000,
    sandboxSessionId?: string,
    conversationId?: string,
    callbackAuthority?: ExpectedSandboxCallbackDelivery,
  ): Promise<InterruptResolution> {
    const install = () => this.installApprovalWaiter(
      turnId,
      agentId,
      toolCallId,
      toolName,
      args,
      timeoutMs,
      sandboxSessionId,
      conversationId,
      callbackAuthority,
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
    toolName: string,
    args: Record<string, unknown>,
    timeoutMs: number,
    sandboxSessionId: string | undefined,
    conversationId: string | undefined,
    callbackAuthority: ExpectedSandboxCallbackDelivery | undefined,
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
    if (
      callbackAuthority
      && (
        callbackAuthority.turnId !== turnId
        || callbackAuthority.agentId !== agentId
        || callbackAuthority.sandboxSessionId !== sandboxSessionId
      )
    ) {
      throw new Error('Sandbox callback authority does not match approval request identity');
    }

    const now = Date.now();
    const expiresAt = now + timeoutMs;
    const interruptId = randomUUID();
    const pendingInterrupt = {
      id: interruptId,
      turnId,
      agentId,
      toolCallId,
      toolName: toolName,
      args,
      timeoutMs,
      createdAt: now,
      expiresAt,
      status: 'pending' as const,
      sandboxSessionId,
    };
    const persistenceContext: EventPersistenceContext | undefined =
      callbackAuthority
        ? {
          deliveryFence: callbackAuthority.expectedDeliveryFence,
          sandboxSessionId: callbackAuthority.sandboxSessionId,
          activeGeneration: callbackAuthority.expectedActiveGeneration,
        }
        : undefined;
    const exactInstaller = callbackAuthority
      ? this.db?.installPendingInterruptIfSandboxCallbackCurrent
      : undefined;
    if (callbackAuthority && (!this.db || !exactInstaller)) {
      throw new Error(
        'Interrupt store does not support fenced sandbox callback installation',
      );
    }

    if (this.db && callbackAuthority && exactInstaller) {
      const installed = await exactInstaller.call(
        this.db,
        pendingInterrupt,
        callbackAuthority,
        existing?.info.interruptId,
      );
      if (!installed) {
        throw new Error(
          `Sandbox callback delivery ownership changed before interrupt persistence for ${turnId}`,
        );
      }
    } else if (existing) {
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
          persistenceContext,
        );
      } catch (error) {
        if (durableResolutionPersisted) {
          settleExisting();
        }
        throw error;
      }
      if (existing.timeoutId) clearTimeout(existing.timeoutId);
    }

    try {
      if (this.db && !callbackAuthority) {
        await this.db.savePendingInterrupt(pendingInterrupt);
      }

      if (existing && callbackAuthority) {
        await this.emitResolvedEvent(
          turnId,
          existing.info.interruptId,
          'reject',
          existing.agentId,
          existing.info.conversationId,
          existing.info.sandboxSessionId,
          persistenceContext,
        );
        if (existing.timeoutId) clearTimeout(existing.timeoutId);
      }

      const replacement = this.createPendingPromise(
        turnId,
        interruptId,
        agentId,
        toolCallId,
        toolName,
        args,
        now,
        timeoutMs,
        sandboxSessionId,
        conversationId,
        true,
      );
      await this.emitRequestedEvent(
        turnId,
        agentId,
        conversationId,
        sandboxSessionId,
        toolCallId,
        toolName,
        args,
        interruptId,
        now,
        persistenceContext,
      );
      settleExisting();
      return { approval: replacement };
    } catch (error) {
      const replacement = this.pending.get(turnId);
      if (replacement?.info.interruptId === interruptId) {
        if (replacement.timeoutId) clearTimeout(replacement.timeoutId);
        this.pending.delete(turnId);
        replacement.resolve({
          action: 'reject',
          data: 'Approval interrupt installation failed',
        });
      }
      if (
        callbackAuthority
        && this.db?.deletePendingInterruptInstallation
      ) {
        try {
          await this.db.deletePendingInterruptInstallation(
            interruptId,
            turnId,
            toolCallId,
          );
        } catch (cleanupError) {
          console.error(
            '[InterruptManager] failed to compensate rejected interrupt installation:',
            cleanupError,
          );
        }
      }
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
    audit?: InterruptResolutionAudit,
  ): Promise<boolean> {
    const entry = this.pending.get(turnId);
    if (!entry) return false;

    if (this.db) {
      const persisted = audit
        ? await this.db.resolveInterrupt(entry.info.interruptId, action, data, audit)
        : await this.db.resolveInterrupt(entry.info.interruptId, action, data);
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
      audit,
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
    audit?: InterruptResolutionAudit,
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
      undefined,
      audit,
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
   * Release this process's in-memory waiters. Call on server shutdown.
   *
   * Shutdown is not a human decision: the durable rows are left pending so
   * the next process reloads them via loadFromDb() and the user's eventual
   * approve/reject resumes the turn through the durable continuation path
   * (ctx-b3ky). In-process waiters are settled as 'suspend' — the same
   * no-decision outcome a HITL timeout produces — so callers never see a
   * rejection that the user did not make. No interrupt.resolved event is
   * emitted because nothing was resolved.
   */
  shutdown(): void {
    for (const entry of this.pending.values()) {
      if (entry.timeoutId) clearTimeout(entry.timeoutId);
      entry.resolve({ action: 'suspend', data: 'Server shutting down' });
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
        await this.onTimeout(sandboxSessionId, turnId);
      }
    } catch (err) {
      console.error('[InterruptManager] failed to handle timeout resolution:', err);
    }
  }
}
