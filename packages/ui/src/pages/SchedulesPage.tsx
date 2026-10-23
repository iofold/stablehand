import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarClock, Loader2, Play } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAgentsStore } from '@/stores/agents';
import {
  fetchSchedules,
  fetchTriggers,
  fireSchedule,
  setScheduleEnabled,
  type Schedule,
  type Trigger,
} from '@/lib/api';
import { formatRelativeTime, formatTimestamp, formatTimeUntil } from '@/lib/format';
import { AlertBanner } from '@/components/ui/AlertBanner';
import { PageShell } from '@/components/ui/PageShell';

interface RowNotice {
  tone: 'ok' | 'error';
  text: string;
}

function agentsPhrase(count: number): string {
  if (count === 0) return 'No agent listens for this event, so nothing starts.';
  return count === 1 ? '1 agent starts a run.' : `${count} agents start a run.`;
}

export function SchedulesPage() {
  const agents = useAgentsStore((s) => s.agents);
  const fetchAgents = useAgentsStore((s) => s.fetchAgents);

  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [triggers, setTriggers] = useState<Trigger[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, 'toggle' | 'fire'>>({});
  const [notices, setNotices] = useState<Record<string, RowNotice>>({});

  const agentNames = useMemo(() => new Map<string, string>(agents.map((agent) => [agent.id, agent.name])), [agents]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [scheduleList, triggerList] = await Promise.all([fetchSchedules(), fetchTriggers()]);
      setSchedules(scheduleList);
      setTriggers(triggerList);
    } catch (err) {
      setError('Schedules could not be loaded.');
      console.debug('[Schedules] Load failed:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (agents.length === 0) void fetchAgents();
  }, [agents.length, fetchAgents]);

  useEffect(() => {
    void load();
  }, [load]);

  const listenersFor = useCallback(
    (eventType: string) => triggers.filter((trigger) => trigger.eventType === eventType),
    [triggers],
  );

  const replace = (updated: Schedule) => {
    setSchedules((current) => current.map((entry) => (entry.id === updated.id ? updated : entry)));
  };

  const setRowBusy = (id: string, action: 'toggle' | 'fire' | null) => {
    setBusy((current) => {
      const next = { ...current };
      if (action) next[id] = action;
      else delete next[id];
      return next;
    });
  };

  const handleToggle = async (schedule: Schedule) => {
    setRowBusy(schedule.id, 'toggle');
    setNotices((current) => {
      const next = { ...current };
      delete next[schedule.id];
      return next;
    });
    try {
      replace(await setScheduleEnabled(schedule.id, !schedule.enabled));
    } catch (err) {
      setNotices((current) => ({
        ...current,
        [schedule.id]: { tone: 'error', text: `Could not turn ${schedule.enabled ? 'off' : 'on'} this schedule.` },
      }));
      console.debug('[Schedules] Toggle failed:', err);
    } finally {
      setRowBusy(schedule.id, null);
    }
  };

  const handleFire = async (schedule: Schedule) => {
    setRowBusy(schedule.id, 'fire');
    try {
      replace(await fireSchedule(schedule.id));
      const starting = listenersFor(schedule.eventType).filter((trigger) => trigger.enabled).length;
      setNotices((current) => ({
        ...current,
        [schedule.id]: { tone: 'ok', text: `Sent ${schedule.eventType}. ${agentsPhrase(starting)}` },
      }));
    } catch (err) {
      setNotices((current) => ({
        ...current,
        [schedule.id]: { tone: 'error', text: 'Could not run this schedule now.' },
      }));
      console.debug('[Schedules] Run now failed:', err);
    } finally {
      setRowBusy(schedule.id, null);
    }
  };

  const onCount = schedules.filter((schedule) => schedule.enabled).length;

  return (
    <div className="flex min-h-screen flex-col bg-surface-950">
      <main className="mx-auto w-full max-w-7xl flex-1 space-y-6 px-6 py-5">
        <PageShell
          title="Schedules"
          description="Each schedule sends an event at set times. Agents with a trigger for that event start a run."
          actions={!loading && schedules.length > 0 ? (
            <span className="text-sm text-surface-400" data-testid="schedules-count">
              {onCount} of {schedules.length} on
            </span>
          ) : undefined}
        />

        {error && schedules.length > 0 && (
          <AlertBanner tone="error" message={error} actionLabel="Retry" onAction={() => void load()} />
        )}

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-6 w-6 animate-spin text-accent-400" />
          </div>
        ) : error && schedules.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-4 py-20 text-center">
            <CalendarClock className="h-8 w-8 text-red-300" />
            <p className="text-sm text-red-200">{error}</p>
            <button type="button" className="btn-secondary" onClick={() => void load()}>
              Retry
            </button>
          </div>
        ) : schedules.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center" data-testid="schedules-empty">
            <CalendarClock className="mb-3 h-8 w-8 text-surface-400" />
            <p className="text-sm text-surface-400">No schedules yet</p>
            <p className="mt-1 max-w-sm text-xs text-surface-400">
              Create one with <span className="font-mono">POST /api/schedules</span> or an example&apos;s seed script.
            </p>
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {schedules.map((schedule) => {
              const listeners = listenersFor(schedule.eventType);
              const rowBusy = busy[schedule.id];
              const notice = notices[schedule.id];
              return (
                <section
                  key={schedule.id}
                  data-testid="schedule-card"
                  data-schedule-id={schedule.id}
                  className="card space-y-3 p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="truncate text-sm font-semibold text-surface-100" title={schedule.name}>
                        {schedule.name}
                      </h3>
                      <p className="mt-0.5 text-xs text-surface-400">
                        <span className="font-mono text-surface-300">{schedule.cronExpression}</span>
                        {' '}({schedule.timezone})
                      </p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={schedule.enabled}
                      aria-label={`${schedule.enabled ? 'Turn off' : 'Turn on'} ${schedule.name}`}
                      disabled={Boolean(rowBusy)}
                      onClick={() => void handleToggle(schedule)}
                      className={cn(
                        'relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors disabled:cursor-wait disabled:opacity-60',
                        schedule.enabled ? 'bg-accent-600' : 'bg-surface-600',
                      )}
                    >
                      <span
                        className={cn(
                          'pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transition-transform',
                          schedule.enabled ? 'translate-x-4' : 'translate-x-0',
                        )}
                      />
                    </button>
                  </div>

                  <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1.5 text-xs">
                    <dt className="text-surface-400">Next run</dt>
                    <dd className="text-surface-200" data-testid="schedule-next">
                      {schedule.enabled && schedule.nextRunAt
                        ? `${formatTimestamp(schedule.nextRunAt)} (${formatTimeUntil(schedule.nextRunAt)})`
                        : 'Off, so it will not run'}
                    </dd>
                    <dt className="text-surface-400">Last run</dt>
                    <dd className="text-surface-200" data-testid="schedule-last">
                      {schedule.lastFiredAt
                        ? `${formatTimestamp(schedule.lastFiredAt)} (${formatRelativeTime(schedule.lastFiredAt)})`
                        : 'Never'}
                    </dd>
                    <dt className="text-surface-400">Sends</dt>
                    <dd className="break-all font-mono text-surface-300">{schedule.eventType}</dd>
                    <dt className="text-surface-400">Starts</dt>
                    <dd data-testid="schedule-agents">
                      {listeners.length === 0 ? (
                        <span className="text-surface-400">
                          No agent yet. <Link to="/triggers" className="text-accent-400 hover:text-accent-300">Add a trigger</Link>
                        </span>
                      ) : (
                        <ul className="space-y-0.5">
                          {listeners.map((trigger) => (
                            <li key={trigger.id}>
                              <Link
                                to={`/agents/${trigger.agentId}`}
                                className={cn(
                                  'hover:text-accent-300',
                                  trigger.enabled ? 'text-accent-400' : 'text-surface-400 line-through',
                                )}
                              >
                                {agentNames.get(trigger.agentId) ?? trigger.agentId.slice(0, 8)}
                              </Link>
                              {!trigger.enabled && <span className="text-surface-400"> (trigger off)</span>}
                            </li>
                          ))}
                        </ul>
                      )}
                    </dd>
                  </dl>

                  {schedule.missedFireCount > 0 && (
                    <p className="text-[11px] text-amber-200" data-testid="schedule-missed">
                      Missed {schedule.missedFireCount} {schedule.missedFireCount === 1 ? 'run' : 'runs'} while Stablehand was down.
                    </p>
                  )}

                  {notice && (
                    <p
                      role={notice.tone === 'error' ? 'alert' : 'status'}
                      data-testid="schedule-notice"
                      className={cn('text-[11px]', notice.tone === 'error' ? 'text-red-300' : 'text-teal-300')}
                    >
                      {notice.text}
                    </p>
                  )}

                  <div className="flex justify-end">
                    <button
                      type="button"
                      className="btn-secondary text-xs"
                      disabled={Boolean(rowBusy)}
                      onClick={() => void handleFire(schedule)}
                    >
                      {rowBusy === 'fire' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                      Run now
                    </button>
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
