import { useEffect, useRef, useCallback } from 'react';
import { create } from 'zustand';
import {
  AgentStreamEventSchema,
  InterruptRequestedEventSchema,
} from '@ctxmill/contracts';
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

export function useSSE(
  agentId: string | undefined,
  options: {
    enabled?: boolean;
    eventCursor?: string;
  } = {},
) {
  const enabled = options.enabled ?? true;
  const eventCursor = options.eventCursor;
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
        const parsed: unknown = JSON.parse(event.data);
        const validated = AgentStreamEventSchema.parse(parsed);
        const data: Record<string, unknown> = { ...validated };
        if (event.lastEventId) {
          data._eventId = event.lastEventId;
        }

        if (validated.type === 'CUSTOM' && validated.name === 'ctxmill.interrupt.requested') {
          const interrupt = InterruptRequestedEventSchema.safeParse(validated);
          if (interrupt.success) {
            setPending({
              interruptId: interrupt.data.interruptId,
              turnId: interrupt.data.turnId,
              agentId: interrupt.data.agentId ?? latestAgentIdRef.current ?? '',
              toolCallName: interrupt.data.toolCallName,
              args: interrupt.data.args,
              toolCallId: interrupt.data.toolCallId,
              ...(interrupt.data.sandboxSessionId
                ? { sandboxSessionId: interrupt.data.sandboxSessionId }
                : {}),
            });
          }
        }

        handleSSEEvent(data);
      } catch (err) {
        console.debug('[SSE] Rejected invalid event:', err);
      }
    },
    [handleSSEEvent, setPending],
  );

  useEffect(() => {
    if (!agentId || !enabled) {
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      if (mountedRef.current) {
        setStatus('disconnected');
      }
      return;
    }

    setStatus('connecting');
    useConversationStore.getState().seenEventIds?.clear();
    const es = createSSEConnection(agentId, eventCursor);
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
  }, [agentId, enabled, eventCursor, handleEvent, setStatus]);

  return { status: useSSEStatusStore((s) => s.status) };
}
