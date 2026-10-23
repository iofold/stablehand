import { Link, useLocation } from 'react-router-dom';
import { LayoutDashboard, Activity, Zap, Settings, Wrench, GitBranch, Menu, X, Archive, ChartNoAxesCombined, CalendarClock } from 'lucide-react';
import { useState, useEffect, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { BrandMark } from './BrandMark';
import { PRODUCT_NAME } from '@/branding';
import { useSSEHasSubscription, useSSEStatus } from '@/lib/useSSE';

const navItems = [
  { icon: LayoutDashboard, label: 'Dashboard', path: '/' },
  { icon: ChartNoAxesCombined, label: 'Analytics', path: '/analytics' },
  { icon: Activity, label: 'Events', path: '/events' },
  { icon: Wrench, label: 'Tools', path: '/tools' },
  { icon: GitBranch, label: 'Agent Flow', path: '/flow' },
  { icon: Zap, label: 'Triggers', path: '/triggers' },
  { icon: CalendarClock, label: 'Schedules', path: '/schedules' },
  { icon: Archive, label: 'Artifacts', path: '/artifacts' },
  { icon: Settings, label: 'Settings', path: '/settings' },
];

const STATUS_META = {
  connected: { dot: 'bg-teal-400', label: 'Live updates connected' },
  connecting: { dot: 'bg-amber-400 animate-pulse', label: 'Connecting live updates…' },
  disconnected: { dot: 'bg-red-400', label: 'Live updates offline' },
  idle: { dot: 'bg-surface-600', label: 'Live updates idle' },
} as const;

export function Sidebar() {
  const [hovered, setHovered] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const location = useLocation();
  const pathname = location.pathname;
  const sseStatus = useSSEStatus();
  const hasSubscription = useSSEHasSubscription();
  const status = hasSubscription
    ? STATUS_META[sseStatus] ?? STATUS_META.connecting
    : STATUS_META.idle;

  // Detect mobile viewport
  useEffect(() => {
    const mql = window.matchMedia('(max-width: 767px)');
    const onChange = (e: MediaQueryListEvent | MediaQueryList) => {
      setIsMobile(e.matches);
      if (!e.matches) setMobileOpen(false);
    };
    onChange(mql);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  // Close mobile sidebar on route change
  useEffect(() => {
    if (pathname) {
      setMobileOpen(false);
    }
  }, [pathname]);

  // Close on Escape key
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') setMobileOpen(false);
  }, []);

  useEffect(() => {
    if (mobileOpen) {
      document.addEventListener('keydown', handleKeyDown);
      return () => document.removeEventListener('keydown', handleKeyDown);
    }
  }, [mobileOpen, handleKeyDown]);

  // Labels are visible while hover-expanded on desktop, always on mobile.
  const expanded = hovered || isMobile;

  const sidebarContent = (
    <nav
      aria-label="Main navigation"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={cn(
        'flex h-full flex-col border-r border-surface-700 bg-surface-850',
        // Desktop: fixed rail that expands on hover above the content.
        !isMobile && 'fixed left-0 top-0 z-30 h-screen transition-[width] duration-200',
        !isMobile && (expanded ? 'w-52 shadow-xl shadow-black/40' : 'w-12'),
        // Mobile: full width in overlay
        isMobile && 'w-64',
      )}
    >
      {/* Brand */}
      <div className="flex h-14 shrink-0 items-center overflow-hidden border-b border-surface-700/30 px-2.5">
        {isMobile && (
          <button
            type="button"
            onClick={() => setMobileOpen(false)}
            className="mr-2 text-surface-400 transition-colors hover:text-surface-200"
            aria-label="Close navigation menu"
          >
            <X className="h-5 w-5" />
          </button>
        )}
        <BrandMark size={26} className="shrink-0 text-accent-400" data-testid="brand-mark" />
        <span
          className={cn(
            'overflow-hidden whitespace-nowrap text-sm font-semibold tracking-tight text-surface-100 transition-all duration-200',
            expanded ? 'ml-2.5 max-w-[150px] opacity-100' : 'max-w-0 opacity-0',
          )}
        >
          {PRODUCT_NAME}
        </span>
      </div>

      {/* Nav items */}
      <nav className="flex-1 space-y-1 overflow-y-auto overflow-x-hidden py-3">
        {navItems.map((item) => {
          const isActive =
            pathname === item.path ||
            (item.path !== '/' && pathname.startsWith(item.path));
          return (
            <Link
              key={item.label}
              to={item.path}
              aria-label={item.label}
              aria-current={isActive ? 'page' : undefined}
              className={cn(
                'flex items-center overflow-hidden border-l-2 px-[11px] py-2.5 text-sm transition-colors',
                isActive
                  ? 'border-accent-400 bg-accent-400/5 font-medium text-surface-100'
                  : 'border-transparent text-surface-400 hover:bg-surface-800/60 hover:text-surface-200',
              )}
            >
              <item.icon className={cn(
                'h-5 w-5 shrink-0 transition-colors',
                isActive ? 'text-accent-400' : 'text-surface-400',
              )} />
              <span
                className={cn(
                  'overflow-hidden whitespace-nowrap transition-all duration-200',
                  expanded ? 'ml-3 max-w-[150px] opacity-100' : 'max-w-0 opacity-0',
                )}
              >
                {item.label}
              </span>
            </Link>
          );
        })}
      </nav>

      {/* Live-updates status (SSE connection) */}
      <div
        className="shrink-0 px-[15px] pb-4"
        data-testid="sidebar-connection-status"
        title={status.label}
      >
        <div className="flex items-center overflow-hidden">
          <span className={cn('h-2 w-2 shrink-0 rounded-full', status.dot)} />
          <span
            className={cn(
              'overflow-hidden whitespace-nowrap text-[11px] text-surface-400 transition-all duration-200',
              expanded ? 'ml-3 max-w-[150px] opacity-100' : 'max-w-0 opacity-0',
            )}
          >
            {status.label}
          </span>
        </div>
      </div>
    </nav>
  );

  // Mobile: hamburger button + overlay
  if (isMobile) {
    return (
      <>
        {/* Hamburger button - fixed top bar */}
        <div className="fixed left-0 right-0 top-0 z-30 flex h-12 items-center border-b border-surface-700/30 bg-surface-900 px-3">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            aria-label="Open navigation menu"
            className="p-1.5 text-surface-400 transition-colors hover:text-surface-200"
          >
            <Menu className="h-5 w-5" />
          </button>
          <span className="ml-2 flex items-center gap-2 text-sm font-semibold text-surface-100">
            <BrandMark size={20} className="text-accent-400" />
            {PRODUCT_NAME}
          </span>
        </div>

        {/* Overlay backdrop */}
        {mobileOpen && (
          <div
            className="fixed inset-0 z-40 bg-black/50 transition-opacity"
            onClick={() => setMobileOpen(false)}
            aria-hidden="true"
          />
        )}

        {/* Sliding sidebar */}
        <div
          className={cn(
            'fixed inset-y-0 left-0 z-50 transform transition-transform duration-200 ease-in-out',
            mobileOpen ? 'translate-x-0' : '-translate-x-full',
          )}
        >
          {sidebarContent}
        </div>
      </>
    );
  }

  // Desktop: fixed rail, expands on hover
  return sidebarContent;
}
