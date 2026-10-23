import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

/** Current time, re-rendering every `intervalMs`. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function subscribeHash(callback: () => void): () => void {
  window.addEventListener('hashchange', callback);
  return () => window.removeEventListener('hashchange', callback);
}

export type Tab = 'board' | 'leaderboard' | 'learning' | 'ledger';
const TABS: readonly Tab[] = ['board', 'leaderboard', 'learning', 'ledger'];

export interface Route {
  tab: Tab;
  item: string | null;
}

export function parseHash(hash: string): Route {
  const [path, query = ''] = hash.replace(/^#\/?/, '').split('?');
  const tab = (TABS as readonly string[]).includes(path) ? (path as Tab) : 'board';
  const item = new URLSearchParams(query).get('item');
  return { tab, item };
}

export function routeHash(route: Route): string {
  const query = route.item ? `?item=${encodeURIComponent(route.item)}` : '';
  return `#/${route.tab}${query}`;
}

/** Tab and open receipt live in the URL hash, so a receipt can be linked. */
export function useRoute(): [Route, (next: Route) => void] {
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash, () => '');
  const route = parseHash(hash);
  const navigate = useCallback((next: Route) => {
    const target = routeHash(next);
    if (target !== window.location.hash) window.location.hash = target;
  }, []);
  return [route, navigate];
}

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (callback) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', callback);
      return () => list.removeEventListener('change', callback);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

type Theme = 'dark' | 'light';

function readTheme(): Theme {
  try {
    return window.localStorage.getItem('bugfarm.theme') === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

/** Dark by default; the choice is remembered per browser. */
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem('bugfarm.theme', theme);
    } catch {
      // Private windows can refuse storage; the theme still applies for this visit.
    }
  }, [theme]);
  return [theme, () => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))];
}
