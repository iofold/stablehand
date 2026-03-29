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
  const mountedRef = useRef(false);
  const latestAgentIdRef = useRef(agentId);
  const handleSSEEvent = useConversationStore((s) => s.handleSSEEvent);
  const setPending = useInterruptStore((s) => s.setPending);
  const setStatus = useSSEStatusStore((s) => s.setStatus);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    latestAgentIdRef.current = agentId;
  }, [agentId]);

  const handleEvent = useCallback(
    (event: MessageEvent) => {
      if (!mountedRef.current) return;

      try {
        const data = JSON.parse(event.data);
        if (event.lastEventId) {
          data._eventId = event.lastEventId;
        }

        if (data.type === 'CUSTOM' && (data.subtype === 'interrupted' || data.internalType === 'run.interrupted')) {
          setPending({
            agentId: data.agentId ?? latestAgentIdRef.current ?? '',
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
    [handleSSEEvent, setPending],
  );

  useEffect(() => {
    if (!agentId) {
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      if (mountedRef.current) {
        setStatus('disconnected');
      }
      return;
    }

    setStatus('connecting');
    const es = createSSEConnection(agentId);
    eventSourceRef.current = es;

    es.onopen = () => {
      if (!mountedRef.current || eventSourceRef.current !== es) return;
      setStatus('connected');
    };

    es.onmessage = (event) => {
      if (!mountedRef.current || eventSourceRef.current !== es) return;
      handleEvent(event);
    };

    es.onerror = () => {
      if (!mountedRef.current || eventSourceRef.current !== es) return;
      setStatus('disconnected');
      // EventSource will auto-reconnect
    };

    return () => {
      es.onopen = null;
      es.onmessage = null;
      es.onerror = null;
      es.close();
      if (eventSourceRef.current === es) {
        eventSourceRef.current = null;
      }
      if (mountedRef.current) {
        setStatus('disconnected');
      }
    };
  }, [agentId, handleEvent, setStatus]);

  return { status: useSSEStatusStore((s) => s.status) };
}
