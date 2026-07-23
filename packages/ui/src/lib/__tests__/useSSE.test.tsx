import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSSEConnection } from '@/lib/api';
import { useSSE, useSSEStatus } from '@/lib/useSSE';
import { useConversationStore } from '@/stores/conversation';

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return {
    ...actual,
    createSSEConnection: vi.fn(),
  };
});

interface FakeEventSource {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  close: ReturnType<typeof vi.fn>;
}

function createFakeEventSource(): FakeEventSource {
  return {
    onopen: null,
    onmessage: null,
    onerror: null,
    close: vi.fn(),
  };
}

function Harness({
  enabled = true,
  eventCursor,
}: {
  enabled?: boolean;
  eventCursor?: string;
}) {
  useSSE('agent-1', { enabled, eventCursor });
  const status = useSSEStatus();
  return <span data-testid="sse-status">{status}</span>;
}

describe('useSSE', () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalHandleSSEEvent: ReturnType<typeof useConversationStore.getState>['handleSSEEvent'];

  beforeEach(() => {
    (globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    originalHandleSSEEvent = useConversationStore.getState().handleSSEEvent;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useConversationStore.setState({ handleSSEEvent: originalHandleSSEEvent });
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('rejects a malformed frame while still handling the following terminal frame', () => {
    const eventSource = createFakeEventSource();
    vi.mocked(createSSEConnection).mockReturnValue(eventSource as unknown as EventSource);
    const handleSSEEvent = vi.fn();
    useConversationStore.setState({ handleSSEEvent });
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);

    act(() => {
      root.render(<Harness />);
    });
    act(() => {
      eventSource.onmessage?.(new MessageEvent('message', {
        data: JSON.stringify({
          type: 'TEXT_MESSAGE_END',
          runId: 'turn-1',
          threadId: 'conversation-1',
          messageId: 'message-1',
          role: 'assistant',
          timestamp: 1,
        }),
        lastEventId: 'seq:41',
      }));
      eventSource.onmessage?.(new MessageEvent('message', {
        data: JSON.stringify({
          type: 'RUN_FINISHED',
          runId: 'turn-1',
          threadId: 'conversation-1',
          status: 'completed',
          timestamp: 2,
          usage: null,
        }),
        lastEventId: 'seq:42',
      }));
    });

    expect(handleSSEEvent).toHaveBeenCalledTimes(1);
    expect(handleSSEEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'RUN_FINISHED',
      _eventId: 'seq:42',
    }));
    expect(eventSource.close).not.toHaveBeenCalled();
  });

  it('waits for the REST snapshot before opening SSE at its cursor', () => {
    const eventSource = createFakeEventSource();
    vi.mocked(createSSEConnection).mockReturnValue(
      eventSource as unknown as EventSource,
    );

    act(() => {
      root.render(<Harness enabled={false} />);
    });
    expect(createSSEConnection).not.toHaveBeenCalled();
    expect(container.textContent).toBe('connecting');

    act(() => {
      root.render(
        <Harness enabled eventCursor="000000000042" />,
      );
    });
    expect(createSSEConnection).toHaveBeenCalledWith(
      'agent-1',
      '000000000042',
    );
  });

  it('keeps an intentional snapshot handoff in connecting state', () => {
    const firstEventSource = createFakeEventSource();
    const secondEventSource = createFakeEventSource();
    vi.mocked(createSSEConnection)
      .mockReturnValueOnce(firstEventSource as unknown as EventSource)
      .mockReturnValueOnce(secondEventSource as unknown as EventSource);

    act(() => {
      root.render(<Harness eventCursor="000000000041" />);
    });
    act(() => {
      firstEventSource.onopen?.(new Event('open'));
    });
    expect(container.textContent).toBe('connected');

    act(() => {
      root.render(<Harness enabled={false} />);
    });

    expect(firstEventSource.close).toHaveBeenCalledOnce();
    expect(container.textContent).toBe('connecting');

    act(() => {
      root.render(<Harness eventCursor="000000000042" />);
    });
    expect(createSSEConnection).toHaveBeenLastCalledWith(
      'agent-1',
      '000000000042',
    );
    expect(container.textContent).toBe('connecting');
  });

  it('does not report a transient connection loss when EventSource reconnects within the grace period', () => {
    vi.useFakeTimers();
    const eventSource = createFakeEventSource();
    vi.mocked(createSSEConnection).mockReturnValue(
      eventSource as unknown as EventSource,
    );

    act(() => {
      root.render(<Harness />);
    });
    expect(container.textContent).toBe('connecting');

    act(() => {
      eventSource.onerror?.(new Event('error'));
    });
    expect(container.textContent).toBe('connecting');

    act(() => {
      eventSource.onopen?.(new Event('open'));
    });
    expect(container.textContent).toBe('connected');

    act(() => {
      eventSource.onerror?.(new Event('error'));
    });
    expect(container.textContent).toBe('connected');

    act(() => {
      vi.advanceTimersByTime(3_000);
      eventSource.onopen?.(new Event('open'));
      vi.advanceTimersByTime(5_000);
    });
    expect(container.textContent).toBe('connected');
  });

  it('reports a sustained connection loss after the reconnect grace period', () => {
    vi.useFakeTimers();
    const eventSource = createFakeEventSource();
    vi.mocked(createSSEConnection).mockReturnValue(
      eventSource as unknown as EventSource,
    );

    act(() => {
      root.render(<Harness />);
    });
    act(() => {
      eventSource.onopen?.(new Event('open'));
      eventSource.onerror?.(new Event('error'));
    });
    expect(container.textContent).toBe('connected');

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(container.textContent).toBe('disconnected');

    act(() => {
      eventSource.onopen?.(new Event('open'));
    });
    expect(container.textContent).toBe('connected');
  });
});
