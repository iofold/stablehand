import { WifiOff } from 'lucide-react';
import { useSSEStatus } from '@/lib/useSSE';

/**
 * Shows a banner when SSE connection is lost.
 * Reads status from the shared SSE status store.
 */
export function ConnectionBanner() {
  const status = useSSEStatus();

  if (!status || status === 'connected') return null;

  return (
    <div
      data-testid="connection-lost-banner"
      className="flex items-center justify-center gap-2 bg-amber-600/90 px-4 py-2 text-sm font-medium text-white"
    >
      <WifiOff className="h-4 w-4" />
      <span>
        {status === 'connecting'
          ? 'Connecting to agent stream...'
          : 'Connection lost, reconnecting...'}
      </span>
    </div>
  );
}
