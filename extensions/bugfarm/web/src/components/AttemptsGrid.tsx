import { AlertTriangle, Check, X } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { familyLabel } from '../../../src/shared/board';
import type { Attempt } from '../lib/derive';
import { usd } from '../lib/format';
import { FAMILY_ORDER } from './DifficultyDots';

interface Row {
  id: string;
  harness: string;
  model: string;
  family: string;
  tries: Map<number, Attempt>;
  passes: number;
  cost: number;
}

function rowsFor(attempts: Attempt[]): Row[] {
  const rows = new Map<string, Row>();
  for (const attempt of attempts) {
    const id = `${attempt.harness}:${attempt.model}`;
    let row = rows.get(id);
    if (!row) {
      row = { id, harness: attempt.harness, model: attempt.model, family: attempt.family, tries: new Map(), passes: 0, cost: 0 };
      rows.set(id, row);
    }
    row.tries.set(attempt.try, attempt);
    if (attempt.result === 'pass') row.passes += 1;
    row.cost += attempt.cost_usd ?? 0;
  }
  return [...rows.values()].sort((a, b) => {
    const fa = FAMILY_ORDER.indexOf(a.family);
    const fb = FAMILY_ORDER.indexOf(b.family);
    return (fa === -1 ? 99 : fa) - (fb === -1 ? 99 : fb) || a.model.localeCompare(b.model);
  });
}

const CELL = {
  pass: 'bg-sprout text-ground',
  fail: 'bg-ember/20 text-ember',
  error: 'hatch text-ink-2',
} as const;

function Cell({ attempt }: { attempt: Attempt | undefined }) {
  const reduced = useReducedMotion();
  if (!attempt) return <span className="block aspect-square rounded-[6px] border border-dashed border-line/80" aria-hidden />;
  const Icon = attempt.result === 'pass' ? Check : attempt.result === 'fail' ? X : AlertTriangle;
  return (
    <motion.span
      initial={reduced ? false : { scale: 0.4, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ type: 'spring', stiffness: 500, damping: 22 }}
      className={`grid aspect-square place-items-center rounded-[6px] ${CELL[attempt.result]}`}
      title={`Try ${attempt.try}: ${attempt.result === 'pass' ? 'solved' : attempt.result === 'fail' ? 'not solved' : 'errored'}${attempt.seconds ? ` in ${Math.round(attempt.seconds)}s` : ''}${attempt.cost_usd !== undefined ? `, ${usd(attempt.cost_usd, 3)}` : ''}`}
    >
      <Icon size={14} strokeWidth={3} aria-hidden />
      <span className="sr-only">Try {attempt.try} {attempt.result}</span>
    </motion.span>
  );
}

export function AttemptsGrid({ attempts }: { attempts: Attempt[] }) {
  if (attempts.length === 0) {
    return <p className="text-[0.92rem] text-ink-3">No model has tried this task yet. Attempts show up here as calibration runs.</p>;
  }
  const phases = [...new Set(attempts.map((attempt) => attempt.phase ?? 'calibration'))];
  return (
    <div className="space-y-4">
      {phases.map((phase) => {
        const rows = rowsFor(attempts.filter((attempt) => (attempt.phase ?? 'calibration') === phase));
        const maxTry = Math.max(...rows.flatMap((row) => [...row.tries.keys()]), 1);
        const columns = Math.max(maxTry, 4);
        return (
          <div key={phase}>
            {phases.length > 1 && <h4 className="mb-2 text-[0.85rem] font-semibold capitalize text-ink-2">{phase}</h4>}
            <div className="overflow-x-auto scrollbar-thin">
              <table className="border-separate border-spacing-x-[3px] border-spacing-y-1.5">
                <thead>
                  <tr>
                    <th className="sr-only">Model</th>
                    {Array.from({ length: columns }, (_, index) => (
                      <th key={index} className="w-6 min-w-[1.5rem] text-center text-[0.72rem] font-medium text-ink-3 tnum">{index + 1}</th>
                    ))}
                    <th className="pl-2 text-right text-[0.72rem] font-medium text-ink-3">solved</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <th scope="row" className="w-[8rem] max-w-[8rem] pr-2 text-left align-middle font-normal">
                        <span className="block truncate text-[0.88rem] font-semibold text-ink">{row.model}</span>
                        <span className="block truncate text-[0.75rem] text-ink-3">{familyLabel(row.family)} on {row.harness}</span>
                      </th>
                      {Array.from({ length: columns }, (_, index) => (
                        <td key={index} className="p-0 align-middle"><Cell attempt={row.tries.get(index + 1)} /></td>
                      ))}
                      <td className="whitespace-nowrap pl-2 text-right align-middle text-[0.9rem] font-semibold tnum">
                        {row.passes}/{row.tries.size}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function attemptRows(attempts: Attempt[]) {
  return rowsFor(attempts);
}
