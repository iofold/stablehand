import { cn } from '@/lib/utils';
import { statusTheme } from '@/lib/status-theme';

interface StatusBadgeProps {
  status: string;
  subject: 'Conversation' | 'Turn';
  className?: string;
}

export function StatusBadge({ status, subject, className }: StatusBadgeProps) {
  const { label, dot } = statusTheme(status);

  return (
    <span
      data-testid="status-badge"
      className={cn(
        'inline-flex items-center gap-2 text-xs font-medium text-surface-400',
        className,
      )}
    >
      <span
        className={cn('h-1.5 w-1.5 rounded-full', dot)}
        role="img"
        aria-label={`${subject} status: ${label}`}
      />
      <span className="capitalize">{label}</span>
    </span>
  );
}
