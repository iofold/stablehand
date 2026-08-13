import { Link, useLocation } from 'react-router-dom';

import { cn } from '@/lib/utils';

const sections = [
  { label: 'Runtime', path: '/settings' },
  { label: 'Access keys', path: '/settings/access-keys' },
] as const;

export function SettingsNav() {
  const { pathname } = useLocation();

  return (
    <nav
      aria-label="Settings sections"
      className="flex w-fit items-center gap-1 rounded-lg border border-surface-700 bg-surface-900/70 p-1"
    >
      {sections.map((section) => {
        const active = pathname === section.path;
        return (
          <Link
            key={section.path}
            to={section.path}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
              active
                ? 'bg-surface-700 text-surface-100 shadow-sm'
                : 'text-surface-400 hover:bg-surface-800 hover:text-surface-200',
            )}
          >
            {section.label}
          </Link>
        );
      })}
    </nav>
  );
}
