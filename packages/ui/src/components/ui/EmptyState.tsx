import type { ReactNode } from 'react';

interface EmptyStateProps {
  title: string;
  description?: string;
  action?: ReactNode;
}

export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <div data-testid="empty-state" className="flex flex-col items-center justify-center py-16">
      <div className="text-surface-300 text-base">{title}</div>
      {description && (
        <div className="text-surface-400 text-sm mt-2">{description}</div>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
