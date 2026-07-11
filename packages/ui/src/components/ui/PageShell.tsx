import type { ReactNode } from 'react';

interface PageShellProps {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
}

export function PageShell({ title, description, icon, actions }: PageShellProps) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <h2 className="flex items-center gap-3 text-2xl font-semibold text-surface-200">
          {icon}
          {title}
        </h2>
        {description ? (
          <p className="mt-1.5 max-w-lg text-sm text-surface-400">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="shrink-0 sm:self-start">{actions}</div> : null}
    </div>
  );
}
