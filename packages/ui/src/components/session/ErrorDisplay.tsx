import { useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, X, RotateCcw } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ErrorDisplayProps {
  /** Human-readable summary, e.g. "Failed to send message" */
  summary: string;
  /** Optional HTTP status code to display as a badge */
  statusCode?: number;
  /** Raw technical details (JSON blob, stack trace, etc.) — shown in expandable section */
  details?: string;
  /** Called when the user clicks "Retry" */
  onRetry?: () => void;
  /** Called when the user clicks "Dismiss" */
  onDismiss?: () => void;
}

export function ErrorDisplay({ summary, statusCode, details, onRetry, onDismiss }: ErrorDisplayProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      data-testid="error-display"
      role="alert"
      className="bg-red-900/30 border border-red-500/50 text-red-200 rounded-lg p-3 animate-fade-in"
    >
      {/* Header row */}
      <div className="flex items-start gap-2">
        <AlertTriangle className="h-4 w-4 text-red-400 flex-shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-red-200">{summary}</span>
            {statusCode != null && (
              <span className="inline-flex items-center rounded-md bg-red-800/60 px-1.5 py-0.5 text-[11px] font-mono text-red-300 border border-red-700/40">
                {statusCode}
              </span>
            )}
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-1 flex-shrink-0">
          {onRetry && (
            <button
              type="button"
              data-testid="error-retry-button"
              onClick={onRetry}
              className="rounded-md p-1 text-red-300 hover:bg-red-800/40 hover:text-red-100 transition-colors"
              title="Retry"
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
          )}
          {onDismiss && (
            <button
              type="button"
              data-testid="error-dismiss-button"
              onClick={onDismiss}
              className="rounded-md p-1 text-red-300 hover:bg-red-800/40 hover:text-red-100 transition-colors"
              title="Dismiss"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Expandable technical details */}
      {details && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setExpanded((prev) => !prev)}
            className="flex items-center gap-1 text-[11px] text-red-400 hover:text-red-300 transition-colors"
          >
            {expanded ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            Technical details
          </button>
          {expanded && (
            <pre
              className={cn(
                'mt-1.5 rounded-md bg-red-950/50 border border-red-800/30 p-2',
                'text-[11px] font-mono text-red-300/80 leading-relaxed',
                'overflow-x-auto max-h-40 whitespace-pre-wrap break-words',
              )}
            >
              {details}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
