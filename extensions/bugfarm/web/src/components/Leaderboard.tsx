import { FlaskConical, Info, Timer } from 'lucide-react';
import { LayoutGroup, motion } from 'motion/react';
import { useMemo, useState } from 'react';
import type { BoardView, Cell } from '../lib/derive';
import { pct, repoName, usd } from '../lib/format';
import { AnimatedNumber } from './AnimatedNumber';

const TICKS = [0, 0.25, 0.5, 0.75, 1];

/** "48s", "6m 12s", "1h 04m". */
function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

function runnerOf(cell: Cell): { kind: string; harness: string } {
  const runner = typeof cell.runner === 'string' ? cell.runner : '';
  const [kind, ...rest] = runner.split(' ');
  if (kind && rest.length) return { kind, harness: rest.join(' ') };
  return { kind: '', harness: cell.harness };
}

interface BenchGroup {
  id: string;
  cells: Cell[];
  latest: number;
}

/** Cells grouped by benchmark run, newest run first. Rows without a run (the simulator) form one group. */
function groupByBench(cells: Cell[]): BenchGroup[] {
  const groups = new Map<string, BenchGroup>();
  for (const cell of cells) {
    const id = typeof cell.bench === 'string' ? cell.bench : '';
    const group = groups.get(id) ?? { id, cells: [], latest: 0 };
    group.cells.push(cell);
    group.latest = Math.max(group.latest, cell.rowId);
    groups.set(id, group);
  }
  return [...groups.values()].sort((a, b) => b.latest - a.latest);
}

/**
 * Notes every cell of one runner shares ("each try stops at $1.50") go under the table once, per
 * runner; the rest stay on their row.
 */
function splitNotes(cells: Cell[]): { shared: Array<{ runner: string; note: string }>; own: Map<string, string[]> } {
  const kindOf = (cell: Cell) => (typeof cell.runner === 'string' ? cell.runner.split(' ')[0] : cell.harness);
  const kinds = new Map<string, Cell[]>();
  for (const cell of cells) kinds.set(kindOf(cell), [...(kinds.get(kindOf(cell)) ?? []), cell]);
  const shared: Array<{ runner: string; note: string }> = [];
  const sharedSet = new Set<string>();
  for (const [kind, group] of kinds) {
    if (group.length < 2) continue;
    const first = group[0].notes ?? [];
    for (const note of first) {
      if (group.every((cell) => (cell.notes ?? []).includes(note))) {
        shared.push({ runner: kind, note });
        sharedSet.add(`${kind}\u0000${note}`);
      }
    }
  }
  const own = new Map<string, string[]>();
  for (const cell of cells) own.set(cell.key, (cell.notes ?? []).filter((note) => !sharedSet.has(`${kindOf(cell)}\u0000${note}`)));
  return { shared, own };
}

function Interval({ cell, top }: { cell: Cell; top: boolean }) {
  const measured = cell.attempts > 0;
  const low = cell.ci_low ?? cell.pass_at_1;
  const high = cell.ci_high ?? cell.pass_at_1;
  return (
    <div
      className="relative h-8"
      title={measured ? `pass@1 ${pct(cell.pass_at_1)}; 95% interval ${pct(low)} to ${pct(high)}` : 'Not measured yet'}
    >
      {TICKS.map((tick) => (
        <span key={tick} className="absolute inset-y-0 w-px bg-line" style={{ left: `${tick * 100}%` }} aria-hidden />
      ))}
      {measured && (
        <>
          <motion.span
            className={`absolute top-1/2 h-2.5 -translate-y-1/2 rounded-full ${top ? 'bg-chart/50' : 'bg-chart/30'}`}
            initial={false}
            animate={{ left: `${low * 100}%`, width: `${Math.max(0.6, (high - low) * 100)}%` }}
            transition={{ type: 'spring', stiffness: 120, damping: 20 }}
          />
          <motion.span
            className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-well bg-chart"
            initial={false}
            animate={{ left: `${cell.pass_at_1 * 100}%` }}
            transition={{ type: 'spring', stiffness: 120, damping: 20 }}
          />
        </>
      )}
    </div>
  );
}

function RunnerLine({ cell }: { cell: Cell }) {
  const { kind, harness } = runnerOf(cell);
  return (
    <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[0.85rem] text-ink-3">
      {kind && <span className="shrink-0 rounded-full border border-line px-1.5 py-px text-[0.75rem] font-semibold uppercase tracking-wide text-ink-2">{kind}</span>}
      <span className="truncate">{harness}</span>
    </span>
  );
}

function Notes({ notes }: { notes: string[] }) {
  if (!notes.length) return null;
  return (
    <ul className="mt-1.5 space-y-0.5 text-[0.82rem] leading-snug text-ink-3">
      {notes.map((note) => (
        <li key={note} className="flex gap-1.5">
          <Info size={13} className="mt-[0.2rem] shrink-0" aria-hidden />
          <span>{note}</span>
        </li>
      ))}
    </ul>
  );
}

function Tile({ value, label, detail }: { value: string; label: string; detail?: string }) {
  return (
    <div className="min-w-0 rounded-card bg-card px-3 py-2.5 sm:px-4 sm:py-3">
      <div className="wdth-wide truncate text-[1.2rem] font-semibold leading-tight tnum sm:text-[1.7rem]">{value}</div>
      <div className="mt-1 text-[0.8rem] leading-snug text-ink-2 sm:text-[0.88rem]">{label}</div>
      {detail && <div className="mt-0.5 hidden truncate text-[0.82rem] text-ink-3 sm:block">{detail}</div>}
    </div>
  );
}

export function Leaderboard({ view }: { view: BoardView }) {
  const groups = useMemo(() => groupByBench(view.cells), [view.cells]);
  const [chosen, setChosen] = useState<string | null>(null);
  const group = groups.find((entry) => entry.id === chosen) ?? groups[0] ?? null;
  const all = group?.cells ?? [];
  const measured = all.filter((cell) => cell.attempts > 0);
  const waiting = all.filter((cell) => cell.attempts === 0);
  const cells = [...measured, ...waiting];
  const { shared, own } = useMemo(() => splitNotes(cells), [cells]);

  const first = all[0];
  const repo = repoName((typeof first?.repo === 'string' ? first.repo : undefined) ?? view.campaign?.repo) || 'this codebase';
  const tasks = Math.max(0, ...all.map((cell) => cell.tasks_planned ?? cell.tasks ?? 0));
  const k = Math.max(0, ...all.map((cell) => cell.k ?? 0));
  const taskSet = first?.task_set;
  const spend = all.reduce((sum, cell) => sum + (cell.cost_usd ?? 0), 0);
  const tries = all.reduce((sum, cell) => sum + cell.attempts, 0);
  const running = all.reduce((sum, cell) => sum + (cell.running ?? 0), 0);
  const best = measured[0];
  const cheapest = [...measured].filter((cell) => typeof cell.usd_per_solve === 'number').sort((a, b) => (a.usd_per_solve as number) - (b.usd_per_solve as number))[0];

  return (
    <div className="mx-4 mt-6 pb-10 sm:mx-6">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="max-w-4xl">
          <h2 className="wdth-semi text-[1.75rem] font-bold leading-tight sm:text-[2.3rem]">
            Which coding agent is best on {repo}, and what does a solved bug cost?
          </h2>
          <p className="mt-2 text-[1rem] text-ink-2">
            {tasks > 0 && k > 0 ? `Every agent and model pair gets ${k} ${k === 1 ? 'try' : 'tries'} at each of ${tasks} tasks` : 'Each agent and model pair works the accepted tasks'}, in a separate run that was never used to pick them. Ranked by pass rate; bars show the 95% interval.
          </p>
        </div>
        {groups.length > 1 && (
          <label className="flex items-center gap-2 text-[0.9rem] text-ink-2">
            Run
            <select
              className="rounded-card border border-line bg-card px-2 py-1.5 text-ink"
              value={group?.id ?? ''}
              onChange={(event) => setChosen(event.target.value)}
            >
              {groups.map((entry) => (
                <option key={entry.id} value={entry.id}>{entry.id || 'simulated'}</option>
              ))}
            </select>
          </label>
        )}
      </div>

      {taskSet && (
        <div
          role="note"
          className={`mt-4 flex max-w-4xl items-start gap-2.5 rounded-card border px-4 py-2.5 text-[0.92rem] ${taskSet.kind === 'dev_standin' ? 'border-pollen/50 bg-pollen/10' : 'border-line bg-well'}`}
        >
          {taskSet.kind === 'dev_standin' && <FlaskConical size={16} className="mt-0.5 shrink-0 text-pollen" aria-hidden />}
          <span>
            <strong className="font-semibold">{taskSet.label}.</strong>
            {taskSet.note ? <span className="text-ink-2"> {taskSet.note}</span> : null}
          </span>
        </div>
      )}

      {cells.length === 0 ? (
        <div className="mt-6 rounded-well bg-well p-8 text-ink-2">The benchmark runs once a batch of tasks is accepted. Results land here, ranked by pass rate.</div>
      ) : (
        <>
          <div className="mt-5 grid grid-cols-3 gap-2">
            <Tile
              value={best ? pct(best.pass_at_1) : '—'}
              label="best pass rate"
              detail={best ? `${best.model} on ${runnerOf(best).harness}` : undefined}
            />
            <Tile
              value={cheapest ? usd(cheapest.usd_per_solve ?? null) : '—'}
              label="cheapest solved bug"
              detail={cheapest ? `${cheapest.model} on ${runnerOf(cheapest).harness}` : 'nothing solved yet'}
            />
            <Tile
              value={usd(spend)}
              label={`spent on ${tries} ${tries === 1 ? 'try' : 'tries'}`}
              detail={running > 0 ? `${running} running now` : 'gateway-priced'}
            />
          </div>

          <div className="mt-4 rounded-well bg-well p-2 sm:p-3">
            <div className="hidden grid-cols-[3rem_minmax(14rem,1.2fr)_minmax(16rem,2fr)_6rem_6.5rem_7rem_7rem] items-end gap-x-5 px-3 pb-2 pt-1 text-[0.8rem] font-medium text-ink-3 lg:grid">
              <span>Rank</span>
              <span>Agent and model</span>
              <span className="relative h-4">
                {TICKS.map((tick) => (
                  <span key={tick} className="absolute -translate-x-1/2 tnum" style={{ left: `${tick * 100}%` }}>{Math.round(tick * 100)}%</span>
                ))}
              </span>
              <span className="text-right">Pass rate</span>
              <span className="text-right">Solved</span>
              <span className="text-right">Per solve</span>
              <span className="text-right">Median time</span>
            </div>
            <LayoutGroup id="leaderboard">
              <ol className="space-y-1.5">
                {cells.map((cell, index) => {
                  const isMeasured = cell.attempts > 0;
                  const notes = own.get(cell.key) ?? [];
                  const top = index === 0 && isMeasured;
                  return (
                    <motion.li
                      key={cell.key}
                      layout
                      transition={{ type: 'spring', stiffness: 300, damping: 32 }}
                      className={`grid grid-cols-[2.25rem_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2 rounded-card px-3 py-3 lg:grid-cols-[3rem_minmax(14rem,1.2fr)_minmax(16rem,2fr)_6rem_6.5rem_7rem_7rem] lg:items-center lg:gap-x-5 ${top ? 'bg-raised' : 'bg-card'} ${isMeasured ? '' : 'opacity-70'}`}
                    >
                      <span className={`wdth-wide text-[1.5rem] font-bold leading-none tnum ${top ? 'text-pollen' : 'text-ink-3'}`}>{isMeasured ? index + 1 : '–'}</span>
                      <span className="min-w-0">
                        <span className="block truncate text-[1.05rem] font-semibold">{cell.model}</span>
                        <RunnerLine cell={cell} />
                        <span className="hidden lg:block"><Notes notes={notes} /></span>
                      </span>
                      <span className="text-right lg:col-start-4 lg:row-start-1">
                        {isMeasured ? (
                          <AnimatedNumber value={cell.pass_at_1} format={(v) => pct(v)} className="wdth-wide text-[1.45rem] font-semibold leading-none" />
                        ) : (
                          <span className="text-[0.95rem] text-ink-3">{cell.running ? 'running' : 'waiting'}</span>
                        )}
                      </span>
                      <span className="col-span-3 lg:col-span-1 lg:col-start-3 lg:row-start-1">
                        <Interval cell={cell} top={top} />
                      </span>
                      <span className="hidden text-right text-[0.95rem] text-ink-2 tnum lg:block">
                        {cell.solved}/{cell.attempts}
                        {typeof cell.planned_attempts === 'number' && cell.attempts < cell.planned_attempts ? <span className="text-ink-3"> of {cell.planned_attempts}</span> : null}
                      </span>
                      <span className="hidden text-right text-[1.05rem] font-semibold tnum lg:block">{usd(cell.usd_per_solve ?? null)}</span>
                      <span className="hidden items-center justify-end gap-1 text-right text-[0.95rem] text-ink-2 tnum lg:flex">
                        <Timer size={14} className="text-ink-3" aria-hidden />
                        {duration(cell.median_seconds)}
                      </span>
                      <span className="col-span-3 flex flex-wrap justify-between gap-x-4 gap-y-1 text-[0.88rem] text-ink-2 tnum lg:hidden">
                        {isMeasured ? (
                          <>
                            <span>solved {cell.solved} of {cell.attempts}{typeof cell.planned_attempts === 'number' && cell.attempts < cell.planned_attempts ? ` (${cell.planned_attempts} planned)` : ''}</span>
                            <span><strong className="font-semibold text-ink">{usd(cell.usd_per_solve ?? null)}</strong> per solve</span>
                            <span>{duration(cell.median_seconds)} median</span>
                          </>
                        ) : (
                          <span>{cell.running ? `${cell.running} running` : 'not started'}{typeof cell.planned_attempts === 'number' ? `, ${cell.planned_attempts} tries planned` : ''}</span>
                        )}
                      </span>
                      {notes.length > 0 && (
                        <span className="col-span-3 lg:hidden"><Notes notes={notes} /></span>
                      )}
                    </motion.li>
                  );
                })}
              </ol>
            </LayoutGroup>
          </div>

          <div className="mt-4 max-w-4xl space-y-1.5 text-[0.85rem] leading-snug text-ink-3">
            <p>
              Pass rate is pass@1: for each task, the share of tries that passed its hidden tests, averaged over tasks. The interval resamples tasks
              (10,000 bootstrap draws), so with few tasks it is wide on purpose. A try that errors counts as unsolved. Per solve is the pair&apos;s whole
              spend, priced by the model gateway, divided by its passing tries. Median time is the agent&apos;s own time per try.
            </p>
            {shared.map(({ runner, note }) => (
              <p key={`${runner}:${note}`}>
                <span className="font-semibold text-ink-2">{runner}:</span> {note}
              </p>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
