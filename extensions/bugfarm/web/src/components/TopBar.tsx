import { Bug, Moon, Sun } from 'lucide-react';
import { motion } from 'motion/react';
import type { Tab } from '../lib/hooks';
import type { Connection } from '../lib/store';
import type { BoardView } from '../lib/derive';

const TAB_LABELS: Record<Tab, string> = {
  board: 'Board',
  leaderboard: 'Leaderboard',
  learning: 'Learning',
  ledger: 'Ledger',
};

interface TopBarProps {
  view: BoardView;
  tab: Tab;
  onTab: (tab: Tab) => void;
  connection: Connection;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
}

export function Logo() {
  return (
    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-pollen text-ground" aria-hidden>
      <Bug size={20} strokeWidth={2.4} />
    </span>
  );
}

function LiveDot({ connection }: { connection: Connection }) {
  const label = connection === 'live' ? 'Live' : connection === 'offline' ? 'Offline' : 'Reconnecting';
  return (
    <span className="flex items-center gap-2 text-sm text-ink-2" role="status">
      <span className="relative flex h-2.5 w-2.5">
        {connection === 'live' && (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sprout opacity-60 motion-reduce:hidden" />
        )}
        <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${connection === 'live' ? 'bg-sprout' : connection === 'offline' ? 'bg-ember' : 'bg-pollen'}`} />
      </span>
      <span className="hidden sm:inline">{label}</span>
    </span>
  );
}

export function TopBar({ view, tab, onTab, connection, theme, onToggleTheme }: TopBarProps) {
  const approval = view.campaign?.approval;
  return (
    <header className="flex flex-wrap items-center gap-x-6 gap-y-3 px-4 pt-4 sm:px-6 lg:flex-nowrap">
      <div className="flex min-w-0 items-center gap-3">
        <Logo />
        <div className="min-w-0 leading-tight">
          <div className="wdth-semi text-xl font-bold tracking-tight">Bugfarm</div>
          <div className="truncate font-mono text-[0.8rem] text-ink-3">{view.campaign?.repo ?? 'no campaign yet'}</div>
        </div>
      </div>

      <nav aria-label="Views" className="order-3 w-full lg:order-none lg:w-auto">
        <ul className="flex gap-1 rounded-full bg-well p-1">
          {(Object.keys(TAB_LABELS) as Tab[]).map((key) => (
            <li key={key} className="flex-1 lg:flex-none">
              <button
                type="button"
                onClick={() => onTab(key)}
                aria-current={tab === key ? 'page' : undefined}
                className={`relative w-full rounded-full px-3 py-1.5 text-[0.95rem] font-semibold transition-colors sm:px-4 ${tab === key ? 'text-ground' : 'text-ink-2 hover:text-ink'}`}
              >
                {tab === key && (
                  <motion.span
                    layoutId="tab-pill"
                    className="absolute inset-0 rounded-full bg-ink"
                    transition={{ type: 'spring', stiffness: 500, damping: 38 }}
                  />
                )}
                <span className="relative">{TAB_LABELS[key]}</span>
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <div className="ml-auto flex items-center gap-4">
        {approval?.state === 'waiting' && (
          <motion.span
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            className="hidden items-center gap-2 rounded-full border border-pollen/50 bg-pollen/10 px-3 py-1 text-sm font-semibold text-ink md:flex"
          >
            <span className="h-2 w-2 rounded-full bg-pollen" />
            Waiting for approval to publish
          </motion.span>
        )}
        <LiveDot connection={connection} />
        <button
          type="button"
          onClick={onToggleTheme}
          className="grid h-9 w-9 place-items-center rounded-full text-ink-2 hover:bg-well hover:text-ink"
          aria-label={theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme'}
        >
          {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
        </button>
      </div>
    </header>
  );
}
