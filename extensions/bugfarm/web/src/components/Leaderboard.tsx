import { LayoutGroup, motion } from 'motion/react';
import type { BoardView, Cell } from '../lib/derive';
import { pct, repoName, usd } from '../lib/format';
import { AnimatedNumber } from './AnimatedNumber';

const TICKS = [0, 0.25, 0.5, 0.75, 1];

function Interval({ cell, top }: { cell: Cell; top: boolean }) {
  const low = cell.ci_low ?? cell.pass_at_1;
  const high = cell.ci_high ?? cell.pass_at_1;
  return (
    <div
      className="relative h-8"
      title={`pass@1 ${pct(cell.pass_at_1)}; 95% interval ${pct(low)} to ${pct(high)}`}
    >
      {TICKS.map((tick) => (
        <span key={tick} className="absolute inset-y-0 w-px bg-line" style={{ left: `${tick * 100}%` }} aria-hidden />
      ))}
      <motion.span
        className={`absolute top-1/2 h-2 -translate-y-1/2 rounded-full ${top ? 'bg-chart/45' : 'bg-chart/30'}`}
        initial={false}
        animate={{ left: `${low * 100}%`, width: `${Math.max(0.5, (high - low) * 100)}%` }}
        transition={{ type: 'spring', stiffness: 120, damping: 20 }}
      />
      <motion.span
        className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-well bg-chart"
        initial={false}
        animate={{ left: `${cell.pass_at_1 * 100}%` }}
        transition={{ type: 'spring', stiffness: 120, damping: 20 }}
      />
    </div>
  );
}

export function Leaderboard({ view }: { view: BoardView }) {
  const cells = view.cells;
  const repo = repoName(view.campaign?.repo) || 'this codebase';
  const tasks = Math.max(0, ...cells.map((cell) => cell.tasks ?? 0));

  return (
    <div className="mx-4 mt-6 pb-10 sm:mx-6">
      <div className="max-w-3xl">
        <h2 className="wdth-semi text-[1.9rem] font-bold leading-tight sm:text-[2.3rem]">Which coding agent is best on {repo}?</h2>
        <p className="mt-2 text-[1rem] text-ink-2">
          Each agent and model pair works the accepted tasks{tasks > 0 ? ` (${tasks} so far)` : ''} in a separate run that was never used to pick them. Bars show the 95% interval around the pass rate.
        </p>
      </div>

      {cells.length === 0 ? (
        <div className="mt-6 rounded-well bg-well p-8 text-ink-2">The benchmark runs once a batch of tasks is accepted. Results land here, ranked by pass rate.</div>
      ) : (
        <div className="mt-6 rounded-well bg-well p-2 sm:p-3">
          <div className="hidden grid-cols-[3rem_minmax(12rem,1.1fr)_minmax(14rem,2fr)_6rem_6.5rem_7rem] items-end gap-x-5 px-3 pb-2 pt-1 text-[0.8rem] font-medium text-ink-3 lg:grid">
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
          </div>
          <LayoutGroup id="leaderboard">
            <ol className="space-y-1.5">
              {cells.map((cell, index) => (
                <motion.li
                  key={cell.key}
                  layout
                  transition={{ type: 'spring', stiffness: 300, damping: 32 }}
                  className={`grid grid-cols-[2.5rem_minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 rounded-card px-3 py-3 lg:grid-cols-[3rem_minmax(12rem,1.1fr)_minmax(14rem,2fr)_6rem_6.5rem_7rem] lg:gap-x-5 ${index === 0 ? 'bg-raised' : 'bg-card'}`}
                >
                  <span className={`wdth-wide text-[1.5rem] font-bold leading-none tnum ${index === 0 ? 'text-pollen' : 'text-ink-3'}`}>{index + 1}</span>
                  <span className="min-w-0">
                    <span className="block truncate text-[1.05rem] font-semibold">{cell.model}</span>
                    <span className="block truncate text-[0.85rem] text-ink-3">on {cell.harness}</span>
                  </span>
                  <span className="col-span-3 row-start-2 lg:col-span-1 lg:row-start-auto">
                    <Interval cell={cell} top={index === 0} />
                  </span>
                  <span className="text-right lg:order-none">
                    <AnimatedNumber value={cell.pass_at_1} format={(v) => pct(v)} className="wdth-wide text-[1.45rem] font-semibold leading-none" />
                  </span>
                  <span className="hidden text-right text-[0.95rem] text-ink-2 tnum lg:block">{cell.solved}/{cell.attempts}</span>
                  <span className="hidden text-right text-[1.05rem] font-semibold tnum lg:block">{usd(cell.usd_per_solve ?? null)}</span>
                  <span className="col-span-3 flex justify-between text-[0.85rem] text-ink-2 tnum lg:hidden">
                    <span>solved {cell.solved} of {cell.attempts}</span>
                    <span>{usd(cell.usd_per_solve ?? null)} per solve</span>
                  </span>
                </motion.li>
              ))}
            </ol>
          </LayoutGroup>
        </div>
      )}
    </div>
  );
}
