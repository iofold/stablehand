import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSSEConnection } from '@/lib/api';
import { useSSE } from '@/lib/useSSE';
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
}): null {
  useSSE('agent-1', { enabled, eventCursor });
  return null;
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
});
