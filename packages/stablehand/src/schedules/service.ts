import { Cron } from 'croner';
import {
  CustomEventNameSchema,
  CustomEventPayloadSchema,
  ScheduleCreateInputSchema,
  SchedulePatchInputSchema,
  ScheduleSchema,
  type Schedule,
  type ScheduleCreateInput,
  type SchedulePatchInput,
} from '@stablehand/contracts';

import { isUniqueConstraintViolation } from '../database/errors.js';
import type { AgentSelect, ScheduleInsert, ScheduleRow } from '../database/types.js';

const SCHEDULE_NAME_UNIQUE_INDEX = 'idx_schedules_name';

export interface ScheduleJob {
  nextRun(): Date | null;
  stop(): void;
}

export type ScheduleJobFactory = (
  schedule: ScheduleRow,
  callback: () => void | Promise<void>,
) => ScheduleJob;

interface ScheduleRepository {
  listSchedules(): Promise<ScheduleRow[]>;
  getSchedule(id: string): Promise<ScheduleRow | undefined>;
  getAgent(id: string): Promise<AgentSelect | undefined>;
  createSchedule(data: ScheduleInsert): Promise<ScheduleRow>;
  updateSchedule(
    id: string,
    updates: Partial<Omit<
      ScheduleInsert,
      'id' | 'agentId' | 'createdAt' | 'updatedAt' | 'lastFiredAt'
    >>,
  ): Promise<ScheduleRow | undefined>;
  deleteSchedule(id: string): Promise<boolean>;
  claimScheduleFire(id: string, nowMs: number): Promise<
    { claimed: true; previousLastFiredAt: number | null } | { claimed: false }
  >;
  restoreScheduleFireClaim(
    id: string,
    claimStampMs: number,
    previousLastFiredAt: number | null,
  ): Promise<void>;
  recordScheduleMissedFires(id: string, count: number, nowMs: number): Promise<void>;
}

interface CustomEventEmitter {
  emitCustomEventAsync(
    type: string,
    agentId: string | undefined,
    payload: Record<string, unknown>,
  ): Promise<void>;
}

interface Logger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

interface ActiveScheduleFire {
  agentId: string | null;
  scheduleId: string;
}

export interface ScheduleServiceDeps {
  repository: ScheduleRepository;
  triggerManager: CustomEventEmitter;
  jobFactory?: ScheduleJobFactory;
  logger?: Logger;
}

export class ScheduleValidationError extends Error {}
export class ScheduleConflictError extends Error {}
export class ScheduleAgentNotFoundError extends Error {}

/**
 * Validate with Croner itself while excluding its supported one-shot ISO form.
 * STABLEHAND schedules are recurring clocks only.
 */
export function validateRecurringCron(
  cronExpression: string,
  timezone: string,
): void {
  let probe: Cron | undefined;
  try {
    probe = new Cron(cronExpression, { paused: true, timezone });
    if (probe.getPattern() === undefined || probe.getOnce() !== null) {
      throw new ScheduleValidationError('A recurring cron expression is required');
    }
    if (probe.nextRun() === null) {
      throw new ScheduleValidationError('Cron expression has no future run');
    }
  } catch (error) {
    if (error instanceof ScheduleValidationError) throw error;
    throw new ScheduleValidationError(
      error instanceof Error ? error.message : 'Invalid cron expression or timezone',
    );
  } finally {
    probe?.stop();
  }
}

const MISSED_FIRE_AUDIT_CAP = 1_000;

/** Count cron slots strictly inside (fromMs, toMs), capped for hot schedules. */
export function countMissedWindows(
  schedule: Pick<ScheduleRow, 'cronExpression' | 'timezone'>,
  fromMs: number,
  toMs: number,
): number {
  let probe: Cron | undefined;
  try {
    probe = new Cron(schedule.cronExpression, { paused: true, timezone: schedule.timezone });
    let cursor = new Date(fromMs);
    let missed = 0;
    while (missed < MISSED_FIRE_AUDIT_CAP) {
      const next = probe.nextRun(cursor);
      if (!next || next.getTime() >= toMs) break;
      missed++;
      cursor = next;
    }
    return missed;
  } finally {
    probe?.stop();
  }
}

export class ScheduleService {
  private readonly repository: ScheduleRepository;
  private readonly triggerManager: CustomEventEmitter;
  private readonly logger: Logger;
  private readonly jobFactory: ScheduleJobFactory;
  private readonly jobs = new Map<string, ScheduleJob>();
  private readonly jobAgentIds = new Map<string, string | null>();
  private readonly generations = new Map<string, number>();
  private readonly inFlight = new Map<Promise<void>, ActiveScheduleFire>();
  private readonly operationChains = new Map<string, Promise<void>>();
  private readonly retiredAgentIds = new Set<string>();
  private started = false;

  constructor(deps: ScheduleServiceDeps) {
    this.repository = deps.repository;
    this.triggerManager = deps.triggerManager;
    this.logger = deps.logger ?? console;
    this.jobFactory = deps.jobFactory ?? ((schedule, callback) => new Cron(
      schedule.cronExpression,
      {
        timezone: schedule.timezone,
        protect: true,
        unref: true,
        catch: (error) => {
          this.logger.error(
            `[ScheduleService] Croner callback failed for ${schedule.id}`,
            error,
          );
        },
      },
      callback,
    ));
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    try {
      const schedules = await this.repository.listSchedules();
      for (const schedule of schedules) {
        if (schedule.enabled) this.install(schedule);
      }
      this.logger.info(`[ScheduleService] loaded ${this.jobs.size} enabled schedule(s)`);
      await this.auditMissedFires(schedules).catch((error) => {
        this.logger.error('[ScheduleService] missed-fire audit failed', error);
      });
    } catch (error) {
      this.started = false;
      this.stopJobs();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    this.stopJobs();
    await this.drain();
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.inFlight.keys()]);
  }

  /**
   * Permanently fence one agent's clocks before its database rows are removed.
   * Agent identifiers are generated and never reused, so retaining this
   * process-local tombstone also fences reconciliations that were already
   * waiting on the database when deletion began.
   */
  async stopForAgent(agentId: string): Promise<void> {
    this.retiredAgentIds.add(agentId);
    for (const [scheduleId, ownerAgentId] of [...this.jobAgentIds]) {
      if (ownerAgentId === agentId) this.stopJob(scheduleId);
    }
    const active = [...this.inFlight]
      .filter(([, fire]) => fire.agentId === agentId)
      .map(([operation]) => operation);
    await Promise.allSettled(active);
  }

  async list(): Promise<Schedule[]> {
    return Promise.all((await this.repository.listSchedules()).map((row) => this.project(row)));
  }

  async get(id: string): Promise<Schedule | undefined> {
    const row = await this.repository.getSchedule(id);
    return row ? this.project(row) : undefined;
  }

  async create(input: ScheduleCreateInput): Promise<Schedule> {
    const normalized = ScheduleCreateInputSchema.parse(input);
    validateRecurringCron(normalized.cronExpression, normalized.timezone);
    if (normalized.agentId && !await this.repository.getAgent(normalized.agentId)) {
      throw new ScheduleAgentNotFoundError(`Agent ${normalized.agentId} was not found`);
    }

    let row: ScheduleRow;
    try {
      row = await this.repository.createSchedule(normalized);
    } catch (error) {
      if (isUniqueConstraintViolation(error, SCHEDULE_NAME_UNIQUE_INDEX)) {
        throw new ScheduleConflictError(`Schedule name ${normalized.name} already exists`);
      }
      throw error;
    }
    await this.reconcile(row.id);
    return this.project(row);
  }

  async update(id: string, input: SchedulePatchInput): Promise<Schedule | undefined> {
    const patch = SchedulePatchInputSchema.parse(input);
    return this.runSerialized(id, async () => {
      const current = await this.repository.getSchedule(id);
      if (!current) return undefined;
      validateRecurringCron(
        patch.cronExpression ?? current.cronExpression,
        patch.timezone ?? current.timezone,
      );

      let row: ScheduleRow | undefined;
      try {
        row = await this.repository.updateSchedule(id, patch);
      } catch (error) {
        if (isUniqueConstraintViolation(error, SCHEDULE_NAME_UNIQUE_INDEX)) {
          throw new ScheduleConflictError(`Schedule name ${patch.name} already exists`);
        }
        throw error;
      }
      if (!row) return undefined;
      const reconciled = await this.reconcileUnlocked(id);
      return reconciled ? this.project(reconciled) : undefined;
    });
  }

  async delete(id: string): Promise<boolean> {
    return this.runSerialized(id, async () => {
      const deleted = await this.repository.deleteSchedule(id);
      if (!deleted) return false;
      await this.reconcileUnlocked(id);
      return true;
    });
  }

  async reconcile(id: string): Promise<void> {
    await this.runSerialized(id, () => this.reconcileUnlocked(id));
  }

  private async reconcileUnlocked(id: string): Promise<ScheduleRow | undefined> {
    this.stopJob(id);
    await this.drainSchedule(id);
    const schedule = await this.repository.getSchedule(id);
    if (this.started && schedule?.enabled) this.install(schedule);
    return schedule;
  }

  private install(schedule: ScheduleRow): void {
    if (
      !this.started
      || (schedule.agentId !== null && this.retiredAgentIds.has(schedule.agentId))
    ) return;
    CustomEventNameSchema.parse(schedule.eventType);
    CustomEventPayloadSchema.parse(schedule.payload);
    validateRecurringCron(schedule.cronExpression, schedule.timezone);
    // A concurrent reconciliation may have installed a newer DB projection
    // after this caller stopped the prior generation. Stop whatever is live
    // at the final install boundary so no orphan Croner timer survives a map
    // overwrite; the generation check still fences an already-queued callback.
    this.jobs.get(schedule.id)?.stop();
    const generation = (this.generations.get(schedule.id) ?? 0) + 1;
    this.generations.set(schedule.id, generation);
    const callback = () => {
      if (
        !this.started
        || (schedule.agentId !== null && this.retiredAgentIds.has(schedule.agentId))
        || this.generations.get(schedule.id) !== generation
      ) {
        return;
      }
      const operation = this.fire(schedule, generation).catch((error) => {
        this.logger.error(
          `[ScheduleService] failed to emit ${schedule.eventType} for ${schedule.id}`,
          error,
        );
      });
      this.inFlight.set(operation, {
        agentId: schedule.agentId,
        scheduleId: schedule.id,
      });
      void operation.finally(() => this.inFlight.delete(operation));
      return operation;
    };
    this.jobs.set(schedule.id, this.jobFactory(schedule, callback));
    this.jobAgentIds.set(schedule.id, schedule.agentId);
  }

  private async fire(schedule: ScheduleRow, generation: number): Promise<void> {
    if (
      !this.started
      || (schedule.agentId !== null && this.retiredAgentIds.has(schedule.agentId))
      || this.generations.get(schedule.id) !== generation
    ) return;
    // Claim the window BEFORE emitting: the claim is the cross-process
    // dedupe boundary, so a second orchestrator replica firing the same cron
    // slot backs off instead of double-firing (ctx-hljx). A failed emission
    // restores the claim so it is never recorded as fired.
    const nowMs = Date.now();
    const claim = await this.repository.claimScheduleFire(schedule.id, nowMs);
    if (!claim.claimed) {
      this.logger.warn(
        `[ScheduleService] another process already fired this window for ${schedule.id}; skipping`,
      );
      return;
    }
    try {
      await this.triggerManager.emitCustomEventAsync(
        schedule.eventType,
        schedule.agentId ?? undefined,
        schedule.payload,
      );
    } catch (error) {
      await this.repository
        .restoreScheduleFireClaim(schedule.id, nowMs, claim.previousLastFiredAt)
        .catch((restoreError) => {
          this.logger.error(
            `[ScheduleService] failed to roll back unfired claim for ${schedule.id}`,
            restoreError,
          );
        });
      throw error;
    }
  }

  /**
   * Record — never backfill — cron windows that provably did not fire while
   * no service was running (ctx-hljx). Croner only schedules future slots,
   * so anything between the last recorded fire and boot is gone; without
   * this, a stale last_fired_at is the only evidence.
   */
  private async auditMissedFires(schedules: ScheduleRow[]): Promise<void> {
    const nowMs = Date.now();
    for (const schedule of schedules) {
      if (!schedule.enabled || schedule.lastFiredAt === null) continue;
      const missed = countMissedWindows(schedule, schedule.lastFiredAt, nowMs);
      if (missed === 0) continue;
      this.logger.warn(
        `[ScheduleService] schedule ${schedule.name} (${schedule.id}) missed `
        + `${missed}${missed >= MISSED_FIRE_AUDIT_CAP ? '+' : ''} fire window(s) `
        + 'while no scheduler was running; recorded without backfill',
      );
      await this.repository.recordScheduleMissedFires(schedule.id, missed, nowMs);
      await this.triggerManager.emitCustomEventAsync(
        'custom.schedule.missed_fires',
        schedule.agentId ?? undefined,
        {
          scheduleId: schedule.id,
          scheduleName: schedule.name,
          missedFires: missed,
          from: schedule.lastFiredAt,
          to: nowMs,
        },
      ).catch((error) => {
        this.logger.error(
          `[ScheduleService] failed to emit missed-fire event for ${schedule.id}`,
          error,
        );
      });
    }
  }

  private project(row: ScheduleRow): Schedule {
    let nextRunAt: number | null = null;
    if (row.enabled) {
      const active = this.jobs.get(row.id);
      if (active) {
        nextRunAt = active.nextRun()?.getTime() ?? null;
      } else {
        let probe: Cron | undefined;
        try {
          probe = new Cron(row.cronExpression, { paused: true, timezone: row.timezone });
          nextRunAt = probe.nextRun()?.getTime() ?? null;
        } finally {
          probe?.stop();
        }
      }
    }
    return ScheduleSchema.parse({ ...row, nextRunAt });
  }

  private stopJob(id: string): void {
    const current = this.jobs.get(id);
    if (current) {
      current.stop();
      this.jobs.delete(id);
    }
    this.jobAgentIds.delete(id);
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
  }

  private stopJobs(): void {
    for (const id of [...this.jobs.keys()]) this.stopJob(id);
  }

  private async drainSchedule(scheduleId: string): Promise<void> {
    const active = [...this.inFlight]
      .filter(([, fire]) => fire.scheduleId === scheduleId)
      .map(([operation]) => operation);
    await Promise.allSettled(active);
  }

  private async runSerialized<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.operationChains.get(id) ?? Promise.resolve();
    const run = prior.catch(() => undefined).then(operation);
    const tail = run.then(() => undefined, () => undefined);
    this.operationChains.set(id, tail);
    try {
      return await run;
    } finally {
      if (this.operationChains.get(id) === tail) this.operationChains.delete(id);
    }
  }
}
