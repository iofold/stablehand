import { useState } from 'react';
import type { AttemptResult } from '../../../src/shared/board';
import type { Attempt, BoardView } from '../lib/derive';
import { clockSeconds, shortSha, usd } from '../lib/format';

type Filter = 'all' | AttemptResult;

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'pass', label: 'Solved' },
  { value: 'fail', label: 'Not solved' },
  { value: 'error', label: 'Errored' },
];

const RESULT: Record<AttemptResult, { label: string; dot: string }> = {
  pass: { label: 'Solved', dot: 'bg-sprout' },
  fail: { label: 'Not solved', dot: 'bg-ember' },
  error: { label: 'Errored', dot: 'hatch bg-transparent ring-1 ring-ink-3' },
};

function Result({ result }: { result: AttemptResult }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span className={`h-2.5 w-2.5 rounded-full ${RESULT[result].dot}`} aria-hidden />
      {RESULT[result].label}
    </span>
  );
}

const PAGE = 150;

export function Ledger({ view, onOpen }: { view: BoardView; onOpen: (key: string) => void }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [limit, setLimit] = useState(PAGE);
  const titles = new Map(view.items.map((item) => [item.key, item]));
  const rows = filter === 'all' ? view.attempts : view.attempts.filter((attempt) => attempt.result === filter);
  const shown = rows.slice(0, limit);
  const total = view.attempts.reduce((sum, attempt) => sum + (attempt.cost_usd ?? 0), 0);

  const task = (attempt: Attempt) => {
    const item = titles.get(attempt.item);
    return {
      label: item ? `${item.repo?.split('/').pop() ?? ''}@${shortSha(item.sha)}` : attempt.item,
      title: item?.title ?? '',
    };
  };

  return (
    <div className="mx-4 mt-6 pb-10 sm:mx-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-3xl">
          <h2 className="wdth-semi text-[1.9rem] font-bold leading-tight sm:text-[2.3rem]">Every attempt, with its cost</h2>
          <p className="mt-2 text-ink-2">
            {view.attempts.length.toLocaleString('en-US')} attempts so far, {usd(total)} in model calls. Errors count as attempts.
          </p>
        </div>
        <div role="radiogroup" aria-label="Filter attempts" className="flex rounded-full bg-well p-1 text-[0.88rem] font-semibold">
          {FILTERS.map((entry) => (
            <button
              key={entry.value}
              type="button"
              role="radio"
              aria-checked={filter === entry.value}
              onClick={() => {
                setFilter(entry.value);
                setLimit(PAGE);
              }}
              className={`rounded-full px-3 py-1 ${filter === entry.value ? 'bg-card text-ink shadow-sm' : 'text-ink-2 hover:text-ink'}`}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="mt-6 rounded-well bg-well p-8 text-ink-2">No attempts match. Attempts are logged as models try each candidate.</div>
      ) : (
        <>
          <div className="mt-5 hidden overflow-hidden rounded-well bg-well md:block">
            <table className="w-full text-left text-[0.93rem]">
              <thead className="text-[0.8rem] text-ink-3">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Time</th>
                  <th className="px-4 py-2.5 font-medium">Task</th>
                  <th className="px-4 py-2.5 font-medium">Agent</th>
                  <th className="px-4 py-2.5 font-medium">Model</th>
                  <th className="px-4 py-2.5 text-right font-medium">Try</th>
                  <th className="px-4 py-2.5 font-medium">Result</th>
                  <th className="px-4 py-2.5 text-right font-medium">Seconds</th>
                  <th className="px-4 py-2.5 text-right font-medium">Cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line tnum">
                {shown.map((attempt) => {
                  const info = task(attempt);
                  return (
                    <tr key={attempt.key} className="hover:bg-card">
                      <td className="whitespace-nowrap px-4 py-2 text-ink-3">{clockSeconds(attempt.at)}</td>
                      <td className="max-w-[22rem] px-4 py-2">
                        <button type="button" onClick={() => onOpen(attempt.item)} className="block max-w-full truncate text-left hover:underline">
                          <span className="font-mono text-[0.8rem] text-ink-2">{info.label}</span>
                          {info.title && <span className="ml-2 text-ink">{info.title}</span>}
                        </button>
                      </td>
                      <td className="whitespace-nowrap px-4 py-2 text-ink-2">{attempt.harness}</td>
                      <td className="whitespace-nowrap px-4 py-2 font-semibold">{attempt.model}</td>
                      <td className="px-4 py-2 text-right">{attempt.try}</td>
                      <td className="px-4 py-2"><Result result={attempt.result} /></td>
                      <td className="px-4 py-2 text-right text-ink-2">{attempt.seconds !== undefined ? Math.round(attempt.seconds) : '—'}</td>
                      <td className="px-4 py-2 text-right font-semibold">{usd(attempt.cost_usd ?? null, 3)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <ul className="mt-5 divide-y divide-line overflow-hidden rounded-well bg-well md:hidden">
            {shown.map((attempt) => {
              const info = task(attempt);
              return (
                <li key={attempt.key}>
                  <button type="button" onClick={() => onOpen(attempt.item)} className="block w-full px-4 py-3 text-left">
                    <span className="flex items-baseline justify-between gap-3">
                      <span className="truncate font-semibold">{attempt.model}</span>
                      <span className="shrink-0 font-semibold tnum">{usd(attempt.cost_usd ?? null, 3)}</span>
                    </span>
                    <span className="mt-0.5 flex items-center justify-between gap-3 text-[0.85rem] text-ink-2">
                      <span className="truncate"><span className="font-mono text-[0.78rem]">{info.label}</span>, try {attempt.try}</span>
                      <Result result={attempt.result} />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          {rows.length > limit && (
            <div className="mt-4 flex justify-center">
              <button type="button" onClick={() => setLimit(limit + PAGE)} className="rounded-full border border-line bg-card px-4 py-2 text-[0.9rem] font-semibold hover:bg-raised">
                Show {Math.min(PAGE, rows.length - limit)} more of {(rows.length - limit).toLocaleString('en-US')}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
