/**
 * Manages HITL (Human-in-the-Loop) interrupts for agent tool calls
 * that require user approval before proceeding.
 */

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
      timeoutId?: ReturnType<typeof setTimeout>;
    }
  >();

  /**
   * Create a pending interrupt and return a promise that resolves
   * when the user responds via the interrupt endpoint.
   */
  waitForApproval(
    agentId: string,
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
    timeoutMs: number = 300_000,
  ): Promise<InterruptResolution> {
    // If there is already a pending interrupt for this agent, reject it
    const existing = this.pending.get(agentId);
    if (existing) {
      if (existing.timeoutId) clearTimeout(existing.timeoutId);
      existing.resolve({ action: 'reject', data: 'Superseded by new interrupt' });
      this.pending.delete(agentId);
    }

    return new Promise<InterruptResolution>((resolve) => {
      const wrappedResolve = (value: InterruptResolution) => {
        const entry = this.pending.get(agentId);
        if (entry?.timeoutId) clearTimeout(entry.timeoutId);
        resolve(value);
      };

      const timeoutId = timeoutMs > 0
        ? setTimeout(() => {
            const entry = this.pending.get(agentId);
            if (entry) {
              this.pending.delete(agentId);
              resolve({ action: 'timeout', data: `Approval timed out after ${Math.round(timeoutMs / 60_000)} minutes` });
            }
          }, timeoutMs)
        : undefined;

      this.pending.set(agentId, {
        resolve: wrappedResolve,
        info: { toolCallId, toolName, args, createdAt: Date.now() },
        timeoutId,
      });
    });
  }

  /**
   * Resolve a pending interrupt with the user's decision.
   * Returns true if there was a pending interrupt, false otherwise.
   */
  resolve(agentId: string, action: 'approve' | 'reject' | 'timeout', data?: unknown): boolean {
    const entry = this.pending.get(agentId);
    if (!entry) return false;
    if (entry.timeoutId) clearTimeout(entry.timeoutId);
    entry.resolve({ action, data });
    this.pending.delete(agentId);
    return true;
  }

  /**
   * Check whether an agent has a pending interrupt.
   */
  hasPending(agentId: string): boolean {
    return this.pending.has(agentId);
  }

  /**
   * Get info about the pending interrupt for an agent, if any.
   */
  getPending(agentId: string): PendingInterrupt | undefined {
    return this.pending.get(agentId)?.info;
  }

  /**
   * Reject all pending interrupts. Call on server shutdown.
   */
  shutdown(): void {
    for (const [, entry] of this.pending) {
      if (entry.timeoutId) clearTimeout(entry.timeoutId);
      entry.resolve({ action: 'reject', data: 'Server shutting down' });
    }
    this.pending.clear();
  }
}
