import { ExternalLink, X } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, useRef, type ReactNode } from 'react';
import { STAGE_LABELS, familyLabel, rejectReasonLabel } from '../../../src/shared/board';
import type { Attempt, Item } from '../lib/derive';
import { shortSha, usd } from '../lib/format';
import { useMediaQuery } from '../lib/hooks';
import { AttemptsGrid, attemptRows } from './AttemptsGrid';
import { DiffView } from './DiffView';
import { StageTimeline } from './StageTimeline';

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="min-w-0">
      <div className="mb-2.5 flex items-baseline justify-between gap-3">
        <h3 className="wdth-semi text-[1.05rem] font-bold">{title}</h3>
        {aside && <span className="text-[0.85rem] text-ink-3">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

function StageChip({ item }: { item: Item }) {
  const tone = item.stage === 'accepted'
    ? 'bg-sprout/15 border-sprout/50'
    : item.stage === 'rejected'
      ? 'bg-ember/15 border-ember/50'
      : item.stage === 'published'
        ? 'bg-pollen/15 border-pollen/50'
        : 'bg-well border-line';
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[0.85rem] font-semibold ${tone}`}>
      {item.stage === 'rejected' ? `Rejected: ${rejectReasonLabel(item.reject_reason)}` : STAGE_LABELS[item.stage]}
    </span>
  );
}

function Dollars({ item, attempts }: { item: Item; attempts: Attempt[] }) {
  const rows = attemptRows(attempts).map((row) => ({ label: row.model, detail: `${row.tries.size} ${row.tries.size === 1 ? 'try' : 'tries'}`, value: row.cost }));
  const attemptTotal = rows.reduce((sum, row) => sum + row.value, 0);
  const total = Math.max(item.cost_usd ?? 0, attemptTotal);
  const other = total - attemptTotal;
  if (other > 0.004) rows.unshift({ label: 'Env build and checks', detail: '', value: other });
  const max = Math.max(...rows.map((row) => row.value), 0.0001);
  return (
    <div>
      <div className="wdth-wide text-[2rem] font-semibold leading-none">{usd(total)}</div>
      <p className="mt-1 text-[0.85rem] text-ink-3">spent on this candidate so far</p>
      {rows.length > 0 && (
        <ul className="mt-3 space-y-2">
          {rows.map((row) => (
            <li key={row.label} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1">
              <span className="truncate text-[0.88rem]">
                <span className="font-semibold">{row.label}</span> <span className="text-ink-3">{row.detail}</span>
              </span>
              <span className="text-[0.88rem] font-semibold tnum">{usd(row.value, row.value < 1 ? 3 : 2)}</span>
              <span className="col-span-2 h-1.5 overflow-hidden rounded-full bg-well">
                <span className="block h-full rounded-full bg-ink-2" style={{ width: `${Math.max(2, (row.value / max) * 100)}%` }} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FailingTest({ item }: { item: Item }) {
  const tests = item.failing_tests ?? [];
  if (tests.length === 0 && !item.failing_output) {
    return <p className="text-[0.92rem] text-ink-3">The failing test is recorded once the fail-then-pass check runs.</p>;
  }
  return (
    <div className="space-y-2">
      <ul className="space-y-1">
        {tests.map((test) => (
          <li key={test} className="break-all font-mono text-[0.8rem] font-semibold text-ink">{test}</li>
        ))}
      </ul>
      {item.failing_output && (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-card border-l-[3px] border-ember bg-well px-3 py-2 font-mono text-[0.76rem] leading-relaxed text-ink-2 scrollbar-thin">
          {item.failing_output}
        </pre>
      )}
    </div>
  );
}

interface ReceiptDrawerProps {
  item: Item | null;
  attempts: Attempt[];
  onClose: () => void;
}

export function ReceiptDrawer({ item, attempts, onClose }: ReceiptDrawerProps) {
  const reduced = useReducedMotion();
  const wide = useMediaQuery('(min-width: 768px)');
  const dialogRef = useRef<HTMLElement>(null);
  const opener = useRef<Element | null>(null);

  const openKey = item?.key ?? null;
  useEffect(() => {
    if (!openKey) return undefined;
    opener.current = document.activeElement;
    dialogRef.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
      if (opener.current instanceof HTMLElement) opener.current.focus({ preventScroll: true });
    };
  }, [openKey, onClose]);

  const families = item?.difficulty ? Object.entries(item.difficulty) : [];

  return (
    <AnimatePresence>
      {item && (
        <motion.div key="receipt" className="fixed inset-0 z-50" initial={{ opacity: 1 }} exit={{ opacity: 1 }}>
          <motion.div
            className="absolute inset-0 bg-ground/70 backdrop-blur-[3px]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            aria-hidden
          />
          <motion.aside
            ref={dialogRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-label={`Receipt for ${item.title ?? item.key}`}
            className="absolute inset-y-0 right-0 flex w-full flex-col overflow-hidden border-line bg-ground shadow-2xl outline-none md:w-[min(1320px,94vw)] md:border-l"
            initial={reduced ? { opacity: 0 } : wide ? { x: '100%' } : { y: '100%' }}
            animate={reduced ? { opacity: 1 } : wide ? { x: 0 } : { y: 0 }}
            exit={reduced ? { opacity: 0 } : wide ? { x: '100%' } : { y: '100%' }}
            transition={{ type: 'spring', stiffness: 380, damping: 40 }}
          >
            <header className="border-b border-line px-5 pb-4 pt-4 sm:px-7">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <span className="font-mono text-[0.85rem] text-ink-2">
                      {item.repo ?? item.key.split('@')[0]}@{shortSha(item.sha, 10)}
                    </span>
                    <StageChip item={item} />
                    {item.batch !== undefined && <span className="text-[0.85rem] text-ink-3">Batch {item.batch}</span>}
                  </div>
                  <h2 className="wdth-semi mt-2 text-[1.6rem] font-bold leading-tight sm:text-[1.9rem]">{item.title ?? item.key}</h2>
                  {item.reject_detail && item.stage === 'rejected' && (
                    <p className="mt-1.5 text-[0.95rem] text-ink-2">{item.reject_detail}</p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {item.url && (
                    <a href={item.url} target="_blank" rel="noreferrer noopener" className="grid h-10 w-10 place-items-center rounded-full text-ink-2 hover:bg-well hover:text-ink" aria-label="Open the commit">
                      <ExternalLink size={18} />
                    </a>
                  )}
                  <button type="button" onClick={onClose} className="grid h-10 w-10 place-items-center rounded-full text-ink-2 hover:bg-well hover:text-ink" aria-label="Close the receipt">
                    <X size={22} />
                  </button>
                </div>
              </div>
              <div className="mt-1 overflow-x-auto pt-5 scrollbar-none">
                <StageTimeline item={item} />
              </div>
            </header>

            <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto scrollbar-thin xl:grid-cols-[minmax(0,1fr)_500px] xl:overflow-hidden">
              <div className="min-w-0 space-y-6 px-5 py-5 sm:px-7 xl:overflow-y-auto xl:scrollbar-thin">
                <Section
                  title="The fix"
                  aside={item.diff_stats ? `${item.diff_stats.files} ${item.diff_stats.files === 1 ? 'file' : 'files'}, +${item.diff_stats.additions} −${item.diff_stats.deletions}` : undefined}
                >
                  {item.diff ? <DiffView diff={item.diff} /> : <p className="text-ink-3">No diff was recorded for this candidate.</p>}
                </Section>
              </div>
              <div className="min-w-0 space-y-7 border-line px-5 py-5 sm:px-7 xl:overflow-y-auto xl:border-l xl:px-6 xl:scrollbar-thin">
                <Section title="Failing test">
                  <FailingTest item={item} />
                </Section>
                <Section
                  title="Attempts"
                  aside={families.length > 0 ? families.map(([family, count]) => `${familyLabel(family)} ${count.passes}/${count.attempts}`).join(', ') : undefined}
                >
                  <AttemptsGrid attempts={attempts} />
                </Section>
                <Section title="Dollars">
                  <Dollars item={item} attempts={attempts} />
                </Section>
              </div>
            </div>
          </motion.aside>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
