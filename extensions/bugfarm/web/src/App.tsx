import { FlaskConical } from 'lucide-react';
import { MotionConfig } from 'motion/react';
import { useCallback, useEffect } from 'react';
import { Board } from './components/Board';
import { Leaderboard } from './components/Leaderboard';
import { Learning } from './components/Learning';
import { Ledger } from './components/Ledger';
import { ReceiptDrawer } from './components/ReceiptDrawer';
import { StatsStrip } from './components/StatsStrip';
import { TopBar } from './components/TopBar';
import { useBoardView } from './lib/derive';
import { useRoute, useTheme } from './lib/hooks';
import { connectBoard, useBoard } from './lib/store';

function SimBanner() {
  return (
    <div role="note" className="mx-4 mt-3 flex items-center gap-2.5 rounded-full border border-pollen/50 bg-pollen/10 px-4 py-1.5 text-[0.92rem] sm:mx-6">
      <FlaskConical size={16} className="shrink-0 text-pollen" aria-hidden />
      <span>
        <strong className="font-bold">Simulated data.</strong>{' '}
        <span className="text-ink-2">These rows come from the simulator, not a real run.</span>
      </span>
    </div>
  );
}

function ErrorNotice({ message }: { message: string }) {
  return (
    <div role="alert" className="mx-4 mt-3 rounded-card border border-ember/50 bg-ember/10 px-4 py-2 text-[0.92rem] sm:mx-6">
      {message} Retrying.
    </div>
  );
}

export function App() {
  const [theme, toggleTheme] = useTheme();
  const [route, navigate] = useRoute();
  const view = useBoardView();
  const connection = useBoard((state) => state.connection);
  const error = useBoard((state) => state.error);

  useEffect(() => connectBoard(), []);

  const openItem = useCallback((key: string) => navigate({ tab: route.tab, item: key }), [navigate, route.tab]);
  const closeItem = useCallback(() => navigate({ tab: route.tab, item: null }), [navigate, route.tab]);

  const item = route.item ? view.items.find((entry) => entry.key === route.item) ?? null : null;
  const attempts = item ? view.attemptsByItem.get(item.key) ?? [] : [];

  return (
    <MotionConfig reducedMotion="user">
      <div className="flex min-h-dvh flex-col">
        <TopBar
          view={view}
          tab={route.tab}
          onTab={(tab) => navigate({ tab, item: null })}
          connection={connection}
          theme={theme}
          onToggleTheme={toggleTheme}
        />
        {view.simulated && <SimBanner />}
        {error && connection === 'offline' && <ErrorNotice message={error} />}
        <StatsStrip view={view} />
        <main className="flex flex-1 flex-col">
          {route.tab === 'board' && <Board view={view} onOpen={openItem} />}
          {route.tab === 'leaderboard' && <Leaderboard view={view} />}
          {route.tab === 'learning' && <Learning view={view} />}
          {route.tab === 'ledger' && <Ledger view={view} onOpen={openItem} />}
        </main>
      </div>
      <ReceiptDrawer item={item} attempts={attempts} onClose={closeItem} />
    </MotionConfig>
  );
}
