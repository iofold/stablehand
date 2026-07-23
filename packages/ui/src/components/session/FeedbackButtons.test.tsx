import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FeedbackButtons } from './FeedbackButtons';
import { submitFeedback } from '@/lib/api';

vi.mock('@/lib/api', () => ({ submitFeedback: vi.fn() }));

const submitFeedbackMock = vi.mocked(submitFeedback);

describe('FeedbackButtons', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('shows the API error and sends only the supplied canonical IDs', async () => {
    submitFeedbackMock.mockRejectedValue(new Error('Feedback message not found'));
    act(() => {
      root.render(
        <FeedbackButtons
          agentId="agent-1"
          conversationId="conversation-1"
          messageId="message-1"
        />,
      );
    });

    await act(async () => {
      (container.querySelector('[data-testid="thumbs-up"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });

    expect(submitFeedbackMock).toHaveBeenCalledWith('agent-1', {
      conversationId: 'conversation-1',
      messageId: 'message-1',
      type: 'thumbs_up',
    });
    const error = container.querySelector('[role="alert"]');
    expect(error?.textContent).toContain('Feedback message not found');
  });
});
