import { useEffect, useRef, useCallback } from 'react';
import { create } from 'zustand';
import { useConversationStore } from '@/stores/conversation';
import { useInterruptStore } from '@/stores/interrupt';
import { createSSEConnection } from '@/lib/api';

export type SSEStatus = 'connecting' | 'connected' | 'disconnected';

interface SSEStatusStore {
  status: SSEStatus;
  setStatus: (status: SSEStatus) => void;
}

const useSSEStatusStore = create<SSEStatusStore>((set) => ({
  status: 'disconnected',
  setStatus: (status) => set({ status }),
}));

/** Read the current SSE connection status (for ConnectionBanner etc.) */
export function useSSEStatus(): SSEStatus {
  return useSSEStatusStore((s) => s.status);
}

export function useSSE(agentId: string | undefined) {
  const eventSourceRef = useRef<EventSource | null>(null);
  const handleSSEEvent = useConversationStore((s) => s.handleSSEEvent);
  const setPending = useInterruptStore((s) => s.setPending);
  const setStatus = useSSEStatusStore((s) => s.setStatus);

  const handleEvent = useCallback(
    (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);

        // Route interrupt events to the interrupt store
        if (data.type === 'CUSTOM' && data.subtype === 'interrupted') {
          setPending({
            agentId: data.agentId ?? agentId ?? '',
            toolName: data.toolName ?? '',
            args: data.args ?? {},
            toolCallId: data.toolCallId ?? '',
            runId: data.runId,
          });
        }

        handleSSEEvent(data);
      } catch (err) {
        console.debug('[SSE] Failed to parse event:', err);
      }
    },
    [handleSSEEvent, setPending, agentId],
  );

  useEffect(() => {
    if (!agentId) return;

    setStatus('connecting');
    const es = createSSEConnection(agentId);
    eventSourceRef.current = es;

    es.onopen = () => {
      setStatus('connected');
    };

    es.onmessage = handleEvent;

    es.onerror = () => {
      setStatus('disconnected');
      // EventSource will auto-reconnect
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
      setStatus('disconnected');
    };
  }, [agentId, handleEvent, setStatus]);

  return { status: useSSEStatusStore((s) => s.status) };
}
