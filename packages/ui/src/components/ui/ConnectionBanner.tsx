import { AlertTriangle } from 'lucide-react';
import { useSSEStatus } from '@/lib/useSSE';
import { cn } from '@/lib/utils';

/**
 * Shows a banner when SSE connection is lost.
 * Reads status from the shared SSE status store.
 */
export function ConnectionBanner() {
  const status = useSSEStatus();

  if (!status || status === 'connected') return null;

  const isConnecting = status === 'connecting';

  return (
    <div
      data-testid="connection-lost-banner"
      role="alert"
      aria-live="polite"
      className={cn(
        "border-b px-4 py-2",
        isConnecting
          ? "bg-amber-900/50 border-amber-700/30"
          : "bg-amber-900/50 border-amber-500/30"
      )}
    >
      <div className={cn("flex items-center gap-2 text-amber-200 text-xs", isConnecting && "animate-pulse")}>
        <AlertTriangle className="h-3.5 w-3.5 text-amber-400 flex-shrink-0" />
        {isConnecting
          ? 'Connecting to agent stream...'
          : 'Connection lost, reconnecting...'}
      </div>
    </div>
  );
}
