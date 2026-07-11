import type { ReactNode } from 'react';

interface AlertBannerProps {
  tone: 'error' | 'warning';
  message: ReactNode;
  actionLabel?: string;
  onAction?: () => void;
  testId?: string;
}

const TONE_CLASSES = {
  error: {
    banner: 'border-red-500/30 bg-red-500/10 text-red-300',
    action: 'border-red-400/30 text-red-100 hover:bg-red-500/10',
  },
  warning: {
    banner: 'border-amber-500/30 bg-amber-500/10 text-amber-200',
    action: 'border-amber-400/30 text-amber-100 hover:bg-amber-500/10',
  },
} as const;

export function AlertBanner({
  tone,
  message,
  actionLabel,
  onAction,
  testId,
}: AlertBannerProps) {
  const classes = TONE_CLASSES[tone];

  return (
    <div
      role="alert"
      className={`flex items-center justify-between gap-3 rounded-lg border px-4 py-3 text-sm ${classes.banner}`}
    >
      <span>{message}</span>
      {actionLabel && onAction ? (
        <button
          type="button"
          data-testid={testId}
          onClick={onAction}
          className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${classes.action}`}
        >
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}
