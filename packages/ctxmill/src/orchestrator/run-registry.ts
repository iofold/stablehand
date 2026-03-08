import { randomUUID } from 'node:crypto';
import type { DatabaseRepository } from '../database/repository.js';

export type RunStatus = 'queued' | 'running' | 'completed' | 'error' | 'cancelled';
export type RunMode = 'interactive' | 'background';

export interface AgentRun {
  id: string;
  agentId: string;
  conversationId: string;
  status: RunStatus;
  mode: RunMode;
  startedAt: number;
  completedAt?: number;
  error?: string;
  taskDescription?: string;
}

/**
 * Registry tracking all agent runs. Optionally backed by a DatabaseRepository
 * so runs survive server restarts.
 */
export class RunRegistry {
  private runs = new Map<string, AgentRun>();
  private db?: DatabaseRepository;

  constructor(db?: DatabaseRepository) {
    this.db = db;
  }

  /**
   * Load all runs from the database into memory.
   * Runs that were active (queued / running) before a restart are marked as
   * errored because they cannot be resumed.
   */
  async loadFromDb(db?: DatabaseRepository): Promise<void> {
    const repo = db ?? this.db;
    if (!repo) return;
    this.db = repo;

    const allRuns = await repo.getAllRuns();

    for (const row of allRuns) {
      const run: AgentRun = {
        id: row.id,
        agentId: row.agentId,
        conversationId: row.conversationId ?? '',
        status: row.status as RunStatus,
        mode: (row.mode ?? 'interactive') as RunMode,
        startedAt: row.startedAt,
        completedAt: row.completedAt ?? undefined,
        error: row.error ?? undefined,
        taskDescription: row.taskDescription ?? undefined,
      };

      // Mark stale active runs as errored
      if (run.status === 'queued' || run.status === 'running') {
        run.status = 'error';
        run.completedAt = Date.now();
        run.error = 'Server restarted during execution';

        await repo.updateRun(run.id, {
          status: 'error',
          completedAt: run.completedAt,
          error: run.error,
        });
      }

      this.runs.set(run.id, run);
    }
  }

  /**
   * Create and register a new run. Persists to DB if available.
   */
  startRun(
    agentId: string,
    conversationId: string,
    mode: RunMode,
    taskDescription?: string,
  ): AgentRun {
    const run: AgentRun = {
      id: randomUUID(),
      agentId,
      conversationId,
      status: 'running',
      mode,
      startedAt: Date.now(),
      taskDescription,
    };
    this.runs.set(run.id, run);

    // Fire-and-forget DB persistence
    if (this.db) {
      void this.db.createRun({
        id: run.id,
        agentId,
        conversationId,
        status: run.status,
        mode,
        startedAt: run.startedAt,
        taskDescription,
      }).catch(() => {
        // DB write is best-effort; in-memory map is the source of truth during runtime
      });
    }

    return run;
  }

  /**
   * Mark a run as completed (or errored if an error string is provided).
   */
  completeRun(runId: string, error?: string): AgentRun | undefined {
    const run = this.runs.get(runId);
    if (!run) return undefined;

    run.status = error ? 'error' : 'completed';
    run.completedAt = Date.now();
    if (error) run.error = error;

    if (this.db) {
      void this.db.updateRun(runId, {
        status: run.status,
        completedAt: run.completedAt,
        error: run.error,
      }).catch(() => {});
    }

    return run;
  }

  /**
   * Mark a run as cancelled.
   */
  cancelRun(runId: string): AgentRun | undefined {
    const run = this.runs.get(runId);
    if (!run) return undefined;

    run.status = 'cancelled';
    run.completedAt = Date.now();

    if (this.db) {
      void this.db.updateRun(runId, {
        status: 'cancelled',
        completedAt: run.completedAt,
      }).catch(() => {});
    }

    return run;
  }

  /**
   * Get all active (non-terminal) runs, optionally filtered by agent.
   */
  getActiveRuns(agentId?: string): AgentRun[] {
    const activeStatuses: RunStatus[] = ['queued', 'running'];
    const results: AgentRun[] = [];
    for (const run of this.runs.values()) {
      if (!activeStatuses.includes(run.status)) continue;
      if (agentId && run.agentId !== agentId) continue;
      results.push(run);
    }
    return results;
  }

  /**
   * Get all runs (including completed), optionally filtered by agent.
   */
  getAllRuns(agentId?: string): AgentRun[] {
    const results: AgentRun[] = [];
    for (const run of this.runs.values()) {
      if (agentId && run.agentId !== agentId) continue;
      results.push(run);
    }
    return results;
  }

  /**
   * Get a single run by ID.
   */
  getRun(runId: string): AgentRun | undefined {
    return this.runs.get(runId);
  }
}
