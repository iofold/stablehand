import { randomUUID } from 'node:crypto';
import type { DatabaseRepository } from '../database/repository.js';
import type { TypedEventBus } from '../events/bus.js';

export type RunStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'suspended'
  | 'checkpointed'
  | 'completed'
  | 'error'
  | 'cancelled';
export type RunMode = 'interactive' | 'background';

/** Default maximum concurrent runs allowed per agent. */
export const MAX_CONCURRENT_RUNS_PER_AGENT = 3;

/** Options for startRun. */
export interface StartRunOptions {
  maxConcurrent?: number;
  sessionId?: string;
}

/** Options for the RunRegistry constructor. */
export interface RunRegistryOptions {
  db?: DatabaseRepository;
  eventBus?: TypedEventBus;
  /** When true, DB persistence failures throw instead of degrading gracefully. */
  strict?: boolean;
  /** Default max concurrent runs per agent. Defaults to MAX_CONCURRENT_RUNS_PER_AGENT (3). */
  defaultMaxConcurrent?: number;
}

export interface AgentRun {
  id: string;
  agentId: string;
  conversationId: string;
  sessionId?: string;
  status: RunStatus;
  mode: RunMode;
  startedAt: number;
  completedAt?: number;
  error?: string;
  taskDescription?: string;
  pausedAt?: number;
  pausedReason?: string;
  resumedAt?: number;
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
  private readonly defaultMaxConcurrent: number;

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
    this.defaultMaxConcurrent = (isOpts ? (dbOrOpts as RunRegistryOptions).defaultMaxConcurrent : undefined) ?? MAX_CONCURRENT_RUNS_PER_AGENT;
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
   *
   * Restart recovery strategy:
   * - `running` runs are marked as `error` — they were interrupted mid-execution
   * - `paused` runs remain `paused` — they are durable and can be resumed
   * - `queued` runs remain `queued` — they can be retried
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
        sessionId: (row as any).sessionId ?? undefined,
        status: row.status as RunStatus,
        mode: (row.mode ?? 'interactive') as RunMode,
        startedAt: row.startedAt,
        completedAt: row.completedAt ?? undefined,
        error: row.error ?? undefined,
        taskDescription: row.taskDescription ?? undefined,
        pausedAt: (row as any).pausedAt ?? undefined,
        pausedReason: (row as any).pausedReason ?? undefined,
        resumedAt: (row as any).resumedAt ?? undefined,
      };

      // Only `running` runs are interrupted by a restart — mark them as error.
      // `paused` and `queued` runs are durable and survive restarts.
      if (run.status === 'running') {
        run.status = 'error';
        run.completedAt = Date.now();
        run.error = 'Server restarted during execution';

        await repo.updateRun(run.id, {
          status: 'error',
          completedAt: run.completedAt,
          error: run.error,
        });
      }
      // `paused` and `suspended` runs stay in their state — they can be resumed later
      // `queued` runs stay queued — they can be picked up again

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
    const limit = options?.maxConcurrent ?? this.defaultMaxConcurrent;
    const activeCount = this.getActiveRuns(agentId).length;
    if (activeCount >= limit) {
      throw new Error(`Concurrent run limit reached for agent ${agentId} (${activeCount}/${limit})`);
    }

    const run: AgentRun = {
      id: randomUUID(),
      agentId,
      conversationId,
      sessionId: options?.sessionId,
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
   * Set the sessionId on an existing run (in-memory only).
   * Called after a sandbox session is created to backfill the session ID.
   */
  setRunSessionId(runId: string, sessionId: string): void {
    const run = this.runs.get(runId);
    if (run) {
      run.sessionId = sessionId;
    }
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
   * Includes queued, running, and paused runs.
   */
  getActiveRuns(agentId?: string): AgentRun[] {
    const activeStatuses: RunStatus[] = ['queued', 'running', 'paused', 'suspended', 'checkpointed'];
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
   * Pause a running run. Records reason and timestamp.
   * Only runs in `running` status can be paused.
   */
  async pauseRun(runId: string, reason: string): Promise<AgentRun | undefined> {
    const run = this.runs.get(runId);
    if (!run) return undefined;

    if (run.status !== 'running') {
      return undefined;
    }

    run.status = 'paused';
    run.pausedAt = Date.now();
    run.pausedReason = reason;

    if (this.db) {
      try {
        await this.db.updateRun(runId, {
          status: 'paused',
          pausedAt: run.pausedAt,
          pausedReason: run.pausedReason,
        } as any);
      } catch (err) {
        this.recordPersistFailure('pauseRun', runId, err);
      }
    }

    if (this.eventBus) {
      this.eventBus.emit('run.paused', {
        runId,
        agentId: run.agentId,
        conversationId: run.conversationId,
        reason,
        timestamp: run.pausedAt ?? Date.now(),
      });
    }

    return run;
  }

  /**
   * Suspend a running run. Sets status to 'suspended' for checkpoint-based
   * suspend/resume. Records reason and timestamp.
   * Only runs in `running` status can be suspended.
   */
  async suspendRun(runId: string, reason: string): Promise<AgentRun | undefined> {
    const run = this.runs.get(runId);
    if (!run) return undefined;

    if (run.status !== 'running') {
      return undefined;
    }

    run.status = 'suspended';
    run.pausedAt = Date.now();
    run.pausedReason = reason;

    if (this.db) {
      try {
        await this.db.updateRun(runId, {
          status: 'suspended',
          pausedAt: run.pausedAt,
          pausedReason: run.pausedReason,
        } as any);
      } catch (err) {
        this.recordPersistFailure('suspendRun', runId, err);
      }
    }

    if (this.eventBus) {
      this.eventBus.emit('run.completed', {
        runId,
        agentId: run.agentId,
        conversationId: run.conversationId,
        status: 'cancelled' as const, // closest available event status for suspended
        durationMs: (run.pausedAt ?? Date.now()) - run.startedAt,
        timestamp: run.pausedAt ?? Date.now(),
      });
    }

    return run;
  }

  /**
   * Resume a paused or suspended run. Sets status back to running and records resume time.
   * Only runs in `paused` or `suspended` status can be resumed.
   */
  async resumeRun(runId: string): Promise<AgentRun | undefined> {
    const run = this.runs.get(runId);
    if (!run) return undefined;

    if (run.status !== 'paused' && run.status !== 'suspended' && run.status !== 'checkpointed') {
      return undefined;
    }

    run.status = 'running';
    run.resumedAt = Date.now();

    // Re-create an AbortController for the resumed run
    this.abortControllers.set(runId, new AbortController());

    if (this.db) {
      try {
        await this.db.updateRun(runId, {
          status: 'running',
          resumedAt: run.resumedAt,
        } as any);
      } catch (err) {
        this.recordPersistFailure('resumeRun', runId, err);
      }
    }

    if (this.eventBus) {
      this.eventBus.emit('run.started', {
        runId,
        agentId: run.agentId,
        conversationId: run.conversationId,
        mode: run.mode,
        taskDescription: run.taskDescription ?? '',
        timestamp: run.resumedAt ?? Date.now(),
      });
    }

    return run;
  }

  /**
   * Get all runs matching a given status, optionally filtered by agent.
   */
  getRunsByStatus(status: RunStatus, agentId?: string): AgentRun[] {
    const results: AgentRun[] = [];
    for (const run of this.runs.values()) {
      if (run.status !== status) continue;
      if (agentId && run.agentId !== agentId) continue;
      results.push(run);
    }
    return results;
  }

  getActiveRunsForAgent(agentId: string): AgentRun[] {
    return this.getActiveRuns(agentId);
  }

  getRunsBySession(sessionId: string): AgentRun[] {
    const results: AgentRun[] = [];
    for (const run of this.runs.values()) {
      if (run.sessionId === sessionId) results.push(run);
    }
    return results;
  }

  getActiveRunForConversation(conversationId: string): AgentRun | undefined {
    const activeStatuses: RunStatus[] = ['queued', 'running', 'paused', 'suspended', 'checkpointed'];
    for (const run of this.runs.values()) {
      if (run.conversationId === conversationId && activeStatuses.includes(run.status)) {
        return run;
      }
    }
    return undefined;
  }
}
