import { Link, useLocation } from 'react-router-dom';
import { LayoutDashboard, Activity, Brain, Zap, Settings, ChevronLeft, ChevronRight, Wrench, GitBranch, Menu, X } from 'lucide-react';
import { useState, useEffect, useCallback } from 'react';
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
  const [mobileOpen, setMobileOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const location = useLocation();

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
    setMobileOpen(false);
  }, [location.pathname]);

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

  const sidebarContent = (
    <aside
      role="navigation"
      aria-label="Main navigation"
      className={cn(
        'flex flex-col border-r border-surface-700 bg-surface-850 h-full',
        // Desktop: fixed sidebar with expand/collapse
        !isMobile && 'fixed left-0 top-0 h-screen z-20 transition-all duration-200',
        !isMobile && 'w-12',
        // Mobile: full width in overlay
        isMobile && 'w-64',
      )}
    >
      {/* Logo */}
      <div className="flex h-14 items-center border-b border-surface-700/30 px-3">
        {isMobile && (
          <button
            onClick={() => setMobileOpen(false)}
            className="mr-2 text-surface-400 hover:text-surface-200 transition-colors"
            aria-label="Close navigation menu"
          >
            <X className="h-5 w-5" />
          </button>
        )}
        <span className="text-accent-400 font-bold text-lg flex-shrink-0">&#9881;</span>
        <span
          className={cn(
            'whitespace-nowrap transition-all duration-200 overflow-hidden text-sm font-semibold text-surface-100',
            (expanded || isMobile) ? 'opacity-100 ml-3 max-w-[150px]' : 'opacity-0 max-w-0',
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
              aria-label={item.label}
              aria-current={isActive ? 'page' : undefined}
              className={cn(
                'group relative flex items-center px-4 py-2.5 text-sm transition-colors border-l-2',
                isActive
                  ? 'text-surface-100 border-accent-400 bg-accent-400/5 font-medium'
                  : 'text-surface-400 hover:text-surface-200 border-transparent',
              )}
            >
              <item.icon className={cn(
                "h-5 w-5 flex-shrink-0 transition-colors",
                isActive ? "text-accent-400" : "text-surface-400"
              )} />
              {/* Visible label (shown when expanded or mobile) */}
              <span
                className={cn(
                  'whitespace-nowrap transition-all duration-200 overflow-hidden',
                  (expanded || isMobile) ? 'opacity-100 ml-3 max-w-[150px]' : 'opacity-0 max-w-0',
                )}
              >
                {item.label}
              </span>
              {/* Tooltip (shown on hover when collapsed on desktop) */}
              {!expanded && !isMobile && (
                <span className="absolute left-full ml-2 px-2 py-1 bg-gray-800 text-xs text-white rounded opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap transition-opacity z-50">
                  {item.label}
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      {/* Status indicator */}
      <div className="px-3 pb-4">
        <div className="flex items-center">
          <div className="flex items-center w-full px-2" aria-label="System status: online">
            <span className="w-2 h-2 rounded-full bg-accent-500 flex-shrink-0 animate-pulse" />
            <span
              className={cn(
                'whitespace-nowrap transition-all duration-200 overflow-hidden text-[11px] text-surface-400',
                (expanded || isMobile) ? 'opacity-100 ml-3 max-w-[150px]' : 'opacity-0 max-w-0',
              )}
            >
              System Online
            </span>
            {/* Tooltip for collapsed state */}
            {!expanded && !isMobile && (
              <span className="sr-only">System Online</span>
            )}
          </div>
        </div>
      </div>

      {/* Desktop: always collapsed icon-only with tooltips. Mobile: full labels. */}
    </aside>
  );

  // Mobile: hamburger button + overlay
  if (isMobile) {
    return (
      <>
        {/* Hamburger button - fixed top bar */}
        <div className="fixed top-0 left-0 right-0 z-30 flex items-center h-12 px-3 bg-surface-900 border-b border-surface-700/30">
          <button
            onClick={() => setMobileOpen(true)}
            aria-label="Open navigation menu"
            className="p-1.5 text-surface-400 hover:text-surface-200 transition-colors"
          >
            <Menu className="h-5 w-5" />
          </button>
          <span className="ml-2 text-accent-400 font-bold text-sm">CTXMill</span>
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

  // Desktop: standard fixed sidebar
  return sidebarContent;
}
