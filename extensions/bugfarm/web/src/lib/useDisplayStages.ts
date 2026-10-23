import { useEffect, useLayoutEffect, useReducer, useRef } from 'react';
import type { Stage } from '../../../src/shared/board';
import type { Item } from './derive';

export type CardPhase = 'idle' | 'shaking' | 'dropped' | 'glow';

export interface Shown {
  stage: Stage;
  phase: CardPhase;
  /** Bumped on every transition so the card can replay its entrance. */
  beat: number;
}

/** How long a rejected card shakes in place before it drops into Rejected. */
export const SHAKE_MS = 560;

/**
 * The stage each card is drawn in. It trails the data by one beat for
 * rejects: the card shakes where it stands, then drops into Rejected, so the
 * eye can follow what happened. Everything else moves at once.
 */
export function useDisplayStages(items: Item[], reduced: boolean): Map<string, Shown> {
  const shown = useRef(new Map<string, Shown>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  useLayoutEffect(() => {
    const map = shown.current;
    let changed = false;
    const live = new Set<string>();
    for (const item of items) {
      live.add(item.key);
      const current = map.get(item.key);
      if (!current) {
        map.set(item.key, { stage: item.stage, phase: 'idle', beat: 0 });
        changed = true;
        continue;
      }
      if (current.stage === item.stage || current.phase === 'shaking') continue;
      if (item.stage === 'rejected' && !reduced) {
        map.set(item.key, { ...current, phase: 'shaking', beat: current.beat + 1 });
        const key = item.key;
        timers.current.set(key, setTimeout(() => {
          timers.current.delete(key);
          const latest = shown.current.get(key);
          if (!latest) return;
          shown.current.set(key, { stage: 'rejected', phase: 'dropped', beat: latest.beat + 1 });
          rerender();
        }, SHAKE_MS));
      } else {
        map.set(item.key, {
          stage: item.stage,
          phase: item.stage === 'accepted' && !reduced ? 'glow' : item.stage === 'rejected' ? 'dropped' : 'idle',
          beat: current.beat + 1,
        });
      }
      changed = true;
    }
    for (const key of [...map.keys()]) {
      if (!live.has(key)) {
        map.delete(key);
        changed = true;
      }
    }
    if (changed) rerender();
  }, [items, reduced]);

  useEffect(() => () => {
    for (const timer of timers.current.values()) clearTimeout(timer);
  }, []);

  return shown.current;
}
