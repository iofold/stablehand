import { Link, useLocation } from 'react-router-dom';
import { LayoutDashboard, Activity, Brain, Zap, Settings, ChevronLeft, ChevronRight, Wrench, GitBranch } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/utils';

const navItems = [
  { icon: LayoutDashboard, label: 'Dashboard', path: '/' },
  { icon: Activity, label: 'Events', path: '/events' },
  { icon: Wrench, label: 'Tools', path: '/tools' },
  { icon: GitBranch, label: 'Agent Flow', path: '/flow' },
  { icon: Brain, label: 'Knowledge', path: '/knowledge' },
  { icon: Zap, label: 'Triggers', path: '/triggers' },
  { icon: Settings, label: 'Settings', path: '/settings' },
];

export function Sidebar() {
  const [expanded, setExpanded] = useState(false);
  const location = useLocation();

  return (
    <aside
      className={cn(
        'fixed left-0 top-0 h-screen z-40 flex flex-col border-r border-surface-700 bg-surface-850 transition-all duration-200',
        expanded ? 'w-60' : 'w-12',
      )}
    >
      {/* Logo */}
      <div className="flex h-14 items-center justify-center border-b border-surface-700/30 px-3">
        <span className="text-accent-400 font-bold text-lg flex-shrink-0">&#9881;</span>
        <span
          className={cn(
            'whitespace-nowrap transition-all duration-200 overflow-hidden text-sm font-semibold text-surface-100',
            expanded ? 'opacity-100 ml-3 max-w-[150px]' : 'opacity-0 max-w-0',
          )}
        >
          CTXMill
        </span>
      </div>

      {/* Nav items */}
      <nav className="flex-1 py-3 space-y-1">
        {navItems.map((item) => {
          const isActive =
            location.pathname === item.path ||
            (item.path !== '/' && location.pathname.startsWith(item.path));
          return (
            <Link
              key={item.label}
              to={item.path}
              className={cn(
                'flex items-center px-4 py-2.5 text-sm transition-colors border-l-2',
                isActive
                  ? 'text-surface-100 border-accent-400 font-medium'
                  : 'text-surface-400 hover:text-surface-200 border-transparent',
              )}
            >
              <item.icon className={cn(
                "h-5 w-5 flex-shrink-0 transition-colors",
                isActive ? "text-surface-200" : "text-surface-500"
              )} />
              <span
                className={cn(
                  'whitespace-nowrap transition-all duration-200 overflow-hidden',
                  expanded ? 'opacity-100 ml-3 max-w-[150px]' : 'opacity-0 max-w-0',
                )}
              >
                {item.label}
              </span>
            </Link>
          );
        })}
      </nav>

      {/* Status indicator */}
      <div className="px-3 pb-4">
        <div className="flex items-center justify-center">
          <div className="flex items-center w-full px-2">
            <span className="w-1.5 h-1.5 rounded-full bg-accent-500/50 flex-shrink-0" />
            <span
              className={cn(
                'whitespace-nowrap transition-all duration-200 overflow-hidden text-[11px] text-surface-500',
                expanded ? 'opacity-100 ml-3 max-w-[150px]' : 'opacity-0 max-w-0',
              )}
            >
              System Online
            </span>
          </div>
        </div>
      </div>

      {/* Toggle */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center justify-center h-10 border-t border-surface-700/30 text-surface-500 hover:text-surface-300 transition-colors"
      >
        {expanded ? (
          <ChevronLeft className="h-4 w-4" />
        ) : (
          <ChevronRight className="h-4 w-4" />
        )}
      </button>
    </aside>
  );
}
