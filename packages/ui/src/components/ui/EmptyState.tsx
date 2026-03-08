import type { ReactNode } from 'react';

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div data-testid="empty-state" className="flex flex-col items-center justify-center py-12 px-6 text-center">
      {icon && (
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-surface-800/80 ring-1 ring-surface-700/40">
          {icon}
        </div>
      )}
      <h3 className="text-sm font-medium text-surface-300">{title}</h3>
      {description && (
        <p className="mt-1.5 max-w-sm text-xs text-surface-500 leading-relaxed">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
