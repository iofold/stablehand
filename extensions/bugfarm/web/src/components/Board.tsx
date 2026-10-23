import { LayoutGroup, motion, useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type RefObject } from 'react';
import { STAGES, STAGE_HINTS, STAGE_LABELS, familyLabel, type Stage } from '../../../src/shared/board';
import type { BoardView, Item } from '../lib/derive';
import { useMediaQuery } from '../lib/hooks';
import { useDisplayStages, type Shown } from '../lib/useDisplayStages';
import { AnimatedNumber } from './AnimatedNumber';
import { FAMILY_ORDER, PassPie } from './DifficultyDots';
import { ItemCard } from './ItemCard';

const NEW_WINDOW_MS = 1400;

const STAGE_WELL: Partial<Record<Stage, string>> = {
  accepted: 'well-accepted',
  rejected: 'well-rejected',
  published: 'well-published',
};

const STAGE_DOT: Partial<Record<Stage, string>> = {
  accepted: 'bg-sprout',
  rejected: 'bg-ember',
  published: 'bg-pollen',
};

type Scope = 'all' | 'batch';

function entryTime(item: Item, stage: Stage): number {
  return item.stage_times?.[stage] ?? item.updatedAt;
}

interface ColumnProps {
  stage: Stage;
  cards: { item: Item; shown: Shown; isNew: boolean }[];
  onOpen: (key: string) => void;
  mobile: boolean;
  columnRef?: (node: HTMLElement | null) => void;
}

/**
 * Columns never scroll on their own: a scrolling column would clip cards
 * flying in from a neighbour. Long columns show their newest cards and fold
 * the rest behind a button.
 */
const COMPACT: ReadonlySet<Stage> = new Set(['rejected', 'published']);
const MOBILE_CAP = 8;

/**
 * How many cards fit between the top of this column and the bottom of the
 * window (desktop), so the board reads as one screen at 1920×1080.
 */
function useFit(list: RefObject<HTMLOListElement | null>, compact: boolean, enabled: boolean): number {
  const [fit, setFit] = useState(compact ? 6 : 5);
  const [, onResize] = useReducer((n: number) => n + 1, 0);
  // Measured after every render: the banner, the header strip and the fonts
  // all move the column's top edge after mount. Setting an equal value is a no-op.
  useLayoutEffect(() => {
    const node = list.current;
    if (!enabled || !node) return;
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const top = node.getBoundingClientRect().top + window.scrollY;
    const available = window.innerHeight - top - 1.5 * rem - 2.75 * rem;
    const perCard = (compact ? 8 : 9.6) * rem;
    setFit(Math.max(3, Math.floor(available / perCard)));
  });
  useEffect(() => {
    if (!enabled) return undefined;
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [enabled]);
  return fit;
}

function Column({ stage, cards, onOpen, mobile, columnRef }: ColumnProps) {
  const [expanded, setExpanded] = useState(false);
  const list = useRef<HTMLOListElement>(null);
  const fit = useFit(list, COMPACT.has(stage), !mobile);
  const dot = STAGE_DOT[stage];
  const cap = mobile ? MOBILE_CAP : fit;
  const visible = expanded ? cards : cards.slice(0, cap);
  const folded = cards.length - visible.length;
  return (
    <section
      ref={columnRef}
      aria-label={`${STAGE_LABELS[stage]}: ${cards.length}`}
      data-stage={stage}
      className={`flex flex-col ${mobile ? 'w-[84vw] max-w-[360px] shrink-0 snap-start' : 'min-w-0'}`}
    >
      <header className="flex items-end justify-between gap-2 px-1.5 pb-2" title={STAGE_HINTS[stage]}>
        <h2 className="wdth-condensed flex min-w-0 items-center gap-2 truncate text-[1.18rem] font-bold leading-none tracking-tight">
          {dot && <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${dot}`} aria-hidden />}
          {STAGE_LABELS[stage]}
        </h2>
        <AnimatedNumber
          value={cards.length}
          format={(v) => String(Math.round(v))}
          duration={0.5}
          className="wdth-wide text-[1.35rem] font-semibold leading-none text-ink-2 tnum"
        />
      </header>
      <ol ref={list} className={`flex flex-1 flex-col gap-2 rounded-well p-2 ${STAGE_WELL[stage] ?? 'bg-well'} ${mobile ? 'min-h-[12rem]' : 'min-h-[24rem]'}`}>
        {visible.map(({ item, shown, isNew }) => (
          <ItemCard key={item.key} item={item} shown={shown} isNew={isNew} onOpen={onOpen} />
        ))}
        {(folded > 0 || (expanded && cards.length > cap)) && (
          <motion.li layout="position" className="list-none">
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              className="w-full rounded-card border border-line/80 px-3 py-2 text-[0.88rem] font-semibold text-ink-2 hover:bg-card hover:text-ink"
            >
              {expanded ? 'Show the newest only' : `${folded} more`}
            </button>
          </motion.li>
        )}
      </ol>
    </section>
  );
}

function Legend() {
  return (
    <p className="flex min-w-0 items-center gap-2 text-[0.85rem] text-ink-2">
      <PassPie passes={3} attempts={8} size={14} />
      <span>
        Dots show how often each model family solved it, in order:{' '}
        {FAMILY_ORDER.map((family) => familyLabel(family)).join(', ')}.
      </span>
    </p>
  );
}

export function Board({ view, onOpen }: { view: BoardView; onOpen: (key: string) => void }) {
  const reduced = useReducedMotion() ?? false;
  const mobile = !useMediaQuery('(min-width: 1024px)');
  const [scope, setScope] = useState<Scope>('all');
  const currentBatch = view.campaign?.batch ?? null;

  const scoped = useMemo(
    () => (scope === 'batch' && currentBatch !== null ? view.items.filter((item) => item.batch === currentBatch) : view.items),
    [scope, currentBatch, view.items],
  );
  const shown = useDisplayStages(scoped, reduced);
  const now = performance.now();

  // Grouped on every render: `shown` is a ref the stage hook updates in place.
  const columns = new Map<Stage, { item: Item; shown: Shown; isNew: boolean }[]>(STAGES.map((stage) => [stage, []]));
  for (const item of scoped) {
    const display = shown.get(item.key) ?? { stage: item.stage, phase: 'idle' as const, beat: 0 };
    columns.get(display.stage)?.push({ item, shown: display, isNew: item.firstSeen > 0 && now - item.firstSeen < NEW_WINDOW_MS });
  }
  for (const [stage, cards] of columns) {
    cards.sort((a, b) => entryTime(b.item, stage) - entryTime(a.item, stage) || b.item.rowId - a.item.rowId);
  }

  const carousel = useRef<HTMLDivElement>(null);
  const columnNodes = useRef(new Map<Stage, HTMLElement>());
  const jumpTo = useCallback((stage: Stage) => {
    const node = columnNodes.current.get(stage);
    const scroller = carousel.current;
    if (node && scroller) scroller.scrollTo({ left: node.offsetLeft - scroller.offsetLeft - 16, behavior: reduced ? 'auto' : 'smooth' });
  }, [reduced]);

  if (view.loaded && view.items.length === 0) {
    return (
      <div className="mx-4 mt-4 grid flex-1 place-items-center rounded-well bg-well p-10 text-center sm:mx-6">
        <div className="max-w-md">
          <p className="wdth-semi text-2xl font-bold">No candidates yet</p>
          <p className="mt-2 text-ink-2">
            Cards appear here as soon as the pipeline mines its first bug-fix commit. Point the pipeline at this worker's ingest API to start.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 pb-3 pt-4 sm:px-6">
        <Legend />
        <div role="radiogroup" aria-label="Which candidates to show" className="flex rounded-full bg-well p-1 text-[0.85rem] font-semibold">
          {(['all', 'batch'] as Scope[]).map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={scope === value}
              onClick={() => setScope(value)}
              className={`rounded-full px-3 py-1 ${scope === value ? 'bg-card text-ink shadow-sm' : 'text-ink-2 hover:text-ink'}`}
            >
              {value === 'all' ? 'All batches' : `Batch ${currentBatch ?? '—'} only`}
            </button>
          ))}
        </div>
      </div>

      {mobile && (
        <nav aria-label="Jump to a column" className="scrollbar-none -mb-1 flex gap-2 overflow-x-auto px-4 pb-3">
          {STAGES.map((stage) => (
            <button
              key={stage}
              type="button"
              onClick={() => jumpTo(stage)}
              className="flex shrink-0 items-center gap-1.5 rounded-full border border-line bg-card px-3 py-1 text-[0.85rem] font-semibold"
            >
              {STAGE_DOT[stage] && <span className={`h-2 w-2 rounded-full ${STAGE_DOT[stage]}`} aria-hidden />}
              {STAGE_LABELS[stage]}
              <span className="text-ink-3 tnum">{columns.get(stage)?.length ?? 0}</span>
            </button>
          ))}
        </nav>
      )}

      <LayoutGroup id="board">
        <motion.div
            ref={carousel}
            layoutScroll={mobile}
            className={
              mobile
                ? 'flex snap-x snap-mandatory items-start gap-3 overflow-x-auto scroll-px-4 px-4 pb-6 scrollbar-none'
                : 'grid flex-1 grid-cols-8 gap-2.5 px-4 pb-6 sm:px-6 2xl:gap-3'
            }
          >
            {STAGES.map((stage) => (
              <Column
                key={stage}
                stage={stage}
                cards={columns.get(stage) ?? []}
                onOpen={onOpen}
                mobile={mobile}
                columnRef={(node) => {
                  if (node) columnNodes.current.set(stage, node);
                  else columnNodes.current.delete(stage);
                }}
              />
            ))}
        </motion.div>
      </LayoutGroup>
    </div>
  );
}
