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
      className={cn(
        "bg-surface-850 border-b px-4 py-2",
        isConnecting ? "border-surface-700" : "border-status-warning/30"
      )}
    >
      <div className={cn("text-surface-400 text-xs", isConnecting && "animate-pulse")}>
        {isConnecting
          ? 'Connecting to agent stream...'
          : 'Connection lost, reconnecting...'}
      </div>
    </div>
  );
}
