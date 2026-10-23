import { STAGES, STAGE_LABELS, rejectReasonLabel, type Stage } from '../../../src/shared/board';
import type { Item } from '../lib/derive';
import { clock, span } from '../lib/format';

const TERMINAL: ReadonlySet<Stage> = new Set(['accepted', 'rejected', 'published']);

function tone(stage: Stage): string {
  if (stage === 'rejected') return 'bg-ember';
  if (stage === 'accepted') return 'bg-sprout';
  if (stage === 'published') return 'bg-pollen';
  return 'bg-ink-2';
}

/** Stages the candidate went through, with the time it spent in each one on the connector. */
export function StageTimeline({ item }: { item: Item }) {
  const times = item.stage_times ?? {};
  const reached = STAGES.filter((stage) => typeof times[stage] === 'number')
    .sort((a, b) => (times[a] ?? 0) - (times[b] ?? 0));
  if (reached.length === 0) return null;
  const inFlight = !TERMINAL.has(item.stage);

  return (
    <ol className="flex flex-col sm:flex-row sm:items-start" aria-label="Stage timeline">
      {reached.map((stage, index) => {
        const at = times[stage] ?? 0;
        const next = reached[index + 1];
        const nextAt = next ? times[next] : undefined;
        const prevAt = index > 0 ? times[reached[index - 1]] : undefined;
        const isLast = index === reached.length - 1;
        return (
          <li key={stage} className={`flex min-w-0 gap-3 sm:flex-col sm:gap-2 ${isLast ? 'sm:flex-none' : 'sm:flex-1'}`}>
            <div className="flex flex-col items-center sm:flex-row">
              <span className="relative flex h-3 w-3 shrink-0">
                {isLast && inFlight && <span className="absolute inset-0 animate-ping rounded-full bg-ink-2 opacity-50 motion-reduce:hidden" />}
                <span className={`relative h-3 w-3 rounded-full ${tone(stage)}`} />
              </span>
              {!isLast && (
                <span className="relative my-1 w-px flex-1 bg-line sm:mx-2 sm:my-0 sm:h-px sm:w-auto" aria-hidden>
                  {nextAt !== undefined && (
                    <span className="absolute -top-[1.15rem] left-1/2 hidden -translate-x-1/2 whitespace-nowrap text-[0.75rem] text-ink-3 tnum sm:block">
                      {span(nextAt - at)}
                    </span>
                  )}
                </span>
              )}
            </div>
            <div className="min-w-0 pb-3 pr-3 sm:pb-0">
              <div className="whitespace-nowrap text-[0.9rem] font-semibold leading-tight">
                {stage === 'rejected' ? `Rejected: ${rejectReasonLabel(item.reject_reason)}` : STAGE_LABELS[stage]}
              </div>
              <div className="text-[0.78rem] text-ink-3 tnum">
                {clock(at)}
                {prevAt !== undefined && <span className="sm:hidden"> (+{span(at - prevAt)})</span>}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
