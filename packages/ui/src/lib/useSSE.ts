import { useEffect, useRef, useCallback } from 'react';
import { create } from 'zustand';
import {
  AgentStreamEventSchema,
  InterruptRequestedEventSchema,
} from '@stablehand/contracts';
import { useConversationStore } from '@/stores/conversation';
import { useInterruptStore } from '@/stores/interrupt';
import { createSSEConnection } from '@/lib/api';

export type SSEStatus = 'connecting' | 'connected' | 'disconnected';

const SSE_DISCONNECT_GRACE_MS = 5_000;
const SSE_RECONNECT_BASE_MS = 1_000;
const SSE_RECONNECT_MAX_MS = 10_000;
/** EventSource.CLOSED; spelled out so non-browser test doubles need no global. */
const EVENT_SOURCE_CLOSED = 2;

interface SSEStatusStore {
  status: SSEStatus;
  /** Number of mounted stream subscriptions; 0 means status is stale. */
  activeSubscriptions: number;
  setStatus: (status: SSEStatus) => void;
  adjustActive: (delta: number) => void;
}

const useSSEStatusStore = create<SSEStatusStore>((set) => ({
  status: 'connecting',
  activeSubscriptions: 0,
  setStatus: (status) => set({ status }),
  adjustActive: (delta) => set((s) => ({
    activeSubscriptions: Math.max(0, s.activeSubscriptions + delta),
  })),
}));

/** Read the current SSE connection status (for ConnectionBanner etc.) */
export function useSSEStatus(): SSEStatus {
  return useSSEStatusStore((s) => s.status);
}

/**
 * True while at least one live stream subscription is mounted; when false the
 * connection status is stale and should read as idle, not as an outage.
 */
export function useSSEHasSubscription(): boolean {
  return useSSEStatusStore((s) => s.activeSubscriptions > 0);
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

        if (validated.type === 'CUSTOM' && validated.name === 'stablehand.interrupt.requested') {
          const interrupt = InterruptRequestedEventSchema.safeParse(validated);
          if (interrupt.success) {
            setPending({
              interruptId: interrupt.data.interruptId,
              turnId: interrupt.data.turnId,
              agentId: interrupt.data.agentId ?? latestAgentIdRef.current ?? '',
              toolName: interrupt.data.toolName,
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
        // SessionPage disables SSE while installing its REST snapshot. That
        // intentional cursor handoff is pending work, not a connection loss.
        setStatus('connecting');
      }
      return;
    }

    setStatus('connecting');
    useSSEStatusStore.getState().adjustActive(1);
    useConversationStore.getState().seenEventIds?.clear();
    let hasOpened = false;
    let disposed = false;
    let disconnectStatusTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempts = 0;
    let lastSeenEventId: string | undefined;

    const detach = (source: EventSource): void => {
      source.onopen = null;
      source.onmessage = null;
      source.onerror = null;
      source.close();
    };

    const open = (cursor: string | undefined): void => {
      const es = createSSEConnection(agentId, cursor);
      eventSourceRef.current = es;

      es.onopen = () => {
        if (!mountedRef.current || eventSourceRef.current !== es) return;
        if (disconnectStatusTimer !== null) {
          clearTimeout(disconnectStatusTimer);
          disconnectStatusTimer = null;
        }
        hasOpened = true;
        reconnectAttempts = 0;
        setStatus('connected');
      };

      es.onmessage = (event) => {
        if (!mountedRef.current || eventSourceRef.current !== es) return;
        if (event.lastEventId) {
          lastSeenEventId = event.lastEventId;
        }
        handleEvent(event);
      };

      es.onerror = () => {
        if (!mountedRef.current || eventSourceRef.current !== es) return;
        if (!hasOpened) {
          setStatus('connecting');
          return;
        }
        if (disconnectStatusTimer === null) {
          disconnectStatusTimer = setTimeout(() => {
            disconnectStatusTimer = null;
            if (!mountedRef.current || disposed) return;
            setStatus('disconnected');
          }, SSE_DISCONNECT_GRACE_MS);
        }
        // EventSource auto-reconnects after a dropped stream, keeping the
        // last known connected state during its retry window. A non-200
        // answer, such as a proxy 502 while the orchestrator restarts, closes
        // it for good instead; reopen from the last event seen so the stream
        // resumes exactly where it stopped (ADR 024).
        if (es.readyState === EVENT_SOURCE_CLOSED && !disposed && reconnectTimer === null) {
          const delay = Math.min(
            SSE_RECONNECT_MAX_MS,
            SSE_RECONNECT_BASE_MS * 2 ** reconnectAttempts,
          );
          reconnectAttempts += 1;
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            if (disposed || eventSourceRef.current !== es) return;
            detach(es);
            open(lastSeenEventId ?? cursor);
          }, delay);
        }
      };
    };

    open(eventCursor);

    return () => {
      disposed = true;
      if (disconnectStatusTimer !== null) {
        clearTimeout(disconnectStatusTimer);
        disconnectStatusTimer = null;
      }
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      const current = eventSourceRef.current;
      if (current) {
        detach(current);
      }
      useSSEStatusStore.getState().adjustActive(-1);
      eventSourceRef.current = null;
      if (mountedRef.current) {
        setStatus('connecting');
      }
    };
  }, [agentId, enabled, eventCursor, handleEvent, setStatus]);

  return { status: useSSEStatusStore((s) => s.status) };
}
