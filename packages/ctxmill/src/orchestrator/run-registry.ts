import { randomUUID } from 'node:crypto';
import type { DatabaseRepository } from '../database/repository.js';
import type { TypedEventBus } from '../events/bus.js';

export type RunStatus = 'queued' | 'running' | 'completed' | 'error' | 'cancelled';
export type RunMode = 'interactive' | 'background';

/** Default maximum concurrent runs allowed per agent. */
export const MAX_CONCURRENT_RUNS_PER_AGENT = 3;

/** Options for startRun. */
export interface StartRunOptions {
  /** Override the default max concurrent runs per agent. */
  maxConcurrent?: number;
}

/** Options for the RunRegistry constructor. */
export interface RunRegistryOptions {
  db?: DatabaseRepository;
  eventBus?: TypedEventBus;
  /** When true, DB persistence failures throw instead of degrading gracefully. */
  strict?: boolean;
}

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
  /** Path to this run's session overlay directory. */
  sessionDir?: string;
}

/**
 * Registry tracking all agent runs. Optionally backed by a DatabaseRepository
 * so runs survive server restarts.
 */
export class RunRegistry {
  private runs = new Map<string, AgentRun>();
  private abortControllers = new Map<string, AbortController>();
  private db?: DatabaseRepository;
  private eventBus?: TypedEventBus;
  private readonly strict: boolean;

  /** Count of DB persist operations that failed (for health checks). */
  failedPersists = 0;

  constructor(dbOrOpts?: DatabaseRepository | RunRegistryOptions, eventBus?: TypedEventBus) {
    // Distinguish plain-options objects from DatabaseRepository instances.
    // DatabaseRepository has a TS `private db` field that compiles to a
    // regular JS property, so `'db' in repo` returns true — we therefore
    // also check for the presence of `getAllRuns` which only exists on the
    // repository, not on RunRegistryOptions.
    const isOpts =
      dbOrOpts != null &&
      typeof dbOrOpts === 'object' &&
      !('getAllRuns' in dbOrOpts) &&
      ('strict' in dbOrOpts || 'db' in dbOrOpts || 'eventBus' in dbOrOpts);

    if (isOpts) {
      const opts = dbOrOpts as RunRegistryOptions;
      this.db = opts.db;
      this.eventBus = opts.eventBus;
      this.strict = opts.strict ?? process.env.CTXMILL_STRICT_TESTS === '1';
    } else {
      this.db = dbOrOpts as DatabaseRepository | undefined;
      this.eventBus = eventBus;
      this.strict = process.env.CTXMILL_STRICT_TESTS === '1';
    }
  }

  /**
   * Record a DB persistence failure: increment counter, log with severity,
   * and emit a system error event if the eventBus is available.
   */
  private recordPersistFailure(operation: string, runId: string, err: unknown): void {
    this.failedPersists++;
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    console.error(
      `[RunRegistry] CRITICAL: DB persistence failed for run ${runId} during ${operation}: ${message}`,
      stack ? `\n${stack}` : '',
    );
    if (this.eventBus) {
      this.eventBus.emit('system.error' as any, {
        source: 'RunRegistry',
        operation,
        runId,
        error: message,
        timestamp: Date.now(),
      });
    }

    if (this.strict) {
      throw err instanceof Error ? err : new Error(String(err));
    }
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
        sessionDir: row.sessionDir ?? undefined,
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
   * In-memory state is updated first for graceful degradation if DB fails.
   *
   * Throws if the agent already has `maxConcurrent` active runs
   * (defaults to `MAX_CONCURRENT_RUNS_PER_AGENT`).
   */
  async startRun(
    agentId: string,
    conversationId: string,
    mode: RunMode,
    taskDescription?: string,
    options?: StartRunOptions,
  ): Promise<AgentRun> {
    // --- Concurrent run limit ---
    const limit = options?.maxConcurrent ?? MAX_CONCURRENT_RUNS_PER_AGENT;
    const activeCount = this.getActiveRuns(agentId).length;
    if (activeCount >= limit) {
      throw new Error(`Concurrent run limit reached for agent ${agentId} (${activeCount}/${limit})`);
    }

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
    this.abortControllers.set(run.id, new AbortController());

    if (this.db) {
      try {
        await this.db.createRun({
          id: run.id,
          agentId,
          conversationId,
          status: run.status,
          mode,
          startedAt: run.startedAt,
          taskDescription,
        });
      } catch (err) {
        this.recordPersistFailure('createRun', run.id, err);
      }
    }

    if (this.eventBus) {
      this.eventBus.emit('run.started', {
        runId: run.id,
        agentId,
        conversationId,
        mode,
        taskDescription: taskDescription ?? '',
        timestamp: run.startedAt,
      });
    }

    return run;
  }

  /**
   * Mark a run as completed (or errored if an error string is provided).
   * In-memory state is updated first for graceful degradation if DB fails.
   */
  async completeRun(runId: string, error?: string): Promise<AgentRun | undefined> {
    const run = this.runs.get(runId);
    if (!run) return undefined;

    // Don't overwrite terminal states — e.g. if cancelled while executor was finishing
    if (run.status === 'cancelled' || run.status === 'completed' || run.status === 'error') {
      return run;
    }

    run.status = error ? 'error' : 'completed';
    run.completedAt = Date.now();
    if (error) run.error = error;
    this.abortControllers.delete(runId);

    if (this.db) {
      try {
        await this.db.updateRun(runId, {
          status: run.status,
          completedAt: run.completedAt,
          error: run.error,
        });
      } catch (err) {
        this.recordPersistFailure('completeRun', runId, err);
      }
    }

    if (this.eventBus) {
      this.eventBus.emit('run.completed', {
        runId,
        agentId: run.agentId,
        conversationId: run.conversationId,
        status: run.status as 'completed' | 'error',
        error: run.error,
        durationMs: (run.completedAt ?? Date.now()) - run.startedAt,
        timestamp: run.completedAt ?? Date.now(),
      });
    }

    return run;
  }

  /**
   * Mark a run as cancelled.
   * In-memory state is updated first for graceful degradation if DB fails.
   */
  async cancelRun(runId: string): Promise<AgentRun | undefined> {
    const run = this.runs.get(runId);
    if (!run) return undefined;

    run.status = 'cancelled';
    run.completedAt = Date.now();

    // Signal the active executor loop to stop
    const controller = this.abortControllers.get(runId);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(runId);
    }

    if (this.db) {
      try {
        await this.db.updateRun(runId, {
          status: 'cancelled',
          completedAt: run.completedAt,
        });
      } catch (err) {
        this.recordPersistFailure('cancelRun', runId, err);
      }
    }

    if (this.eventBus) {
      this.eventBus.emit('run.completed', {
        runId,
        agentId: run.agentId,
        conversationId: run.conversationId,
        status: 'cancelled',
        durationMs: (run.completedAt ?? Date.now()) - run.startedAt,
        timestamp: run.completedAt ?? Date.now(),
      });
    }

    return run;
  }

  /**
   * Get the AbortSignal for a given run, used by the executor loop to
   * detect cancellation.
   */
  getAbortSignal(runId: string): AbortSignal | undefined {
    return this.abortControllers.get(runId)?.signal;
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

  /**
   * Update the sessionDir for a run (after environment is set up).
   */
  async updateSessionDir(runId: string, sessionDir: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;
    run.sessionDir = sessionDir;

    if (this.db) {
      try {
        await this.db.updateRun(runId, { sessionDir });
      } catch (err) {
        this.recordPersistFailure('updateSessionDir', runId, err);
      }
    }
  }
}
