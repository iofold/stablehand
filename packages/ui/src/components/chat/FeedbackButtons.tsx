import { useState } from 'react';
import { ThumbsUp, ThumbsDown } from 'lucide-react';
import { cn } from '@/lib/utils';

interface FeedbackButtonsProps {
  agentId: string;
  messageId: string;
  conversationId?: string;
}

export function FeedbackButtons({ agentId, messageId, conversationId }: FeedbackButtonsProps) {
  const [feedback, setFeedback] = useState<'up' | 'down' | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const sendFeedback = async (type: 'thumbs_up' | 'thumbs_down') => {
    setSubmitting(true);
    try {
      const resp = await fetch(`/api/agents/${agentId}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: conversationId || 'unknown',
          messageId,
          type,
        }),
      });
      if (resp.ok) {
        setFeedback(type === 'thumbs_up' ? 'up' : 'down');
      }
    } catch {
      // Silently fail — feedback is non-critical
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div data-testid="feedback-buttons" className="flex items-center gap-1 mt-1">
      <button
        type="button"
        data-testid="thumbs-up"
        disabled={submitting || feedback !== null}
        onClick={() => sendFeedback('thumbs_up')}
        className={cn(
          'rounded-md p-1 transition-colors',
          feedback === 'up'
            ? 'text-green-400 bg-green-500/10'
            : 'text-surface-500 hover:text-green-400 hover:bg-green-500/10',
          (submitting || feedback !== null) && feedback !== 'up' && 'opacity-30 cursor-not-allowed',
        )}
        title="Helpful"
      >
        <ThumbsUp className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        data-testid="thumbs-down"
        disabled={submitting || feedback !== null}
        onClick={() => sendFeedback('thumbs_down')}
        className={cn(
          'rounded-md p-1 transition-colors',
          feedback === 'down'
            ? 'text-red-400 bg-red-500/10'
            : 'text-surface-500 hover:text-red-400 hover:bg-red-500/10',
          (submitting || feedback !== null) && feedback !== 'down' && 'opacity-30 cursor-not-allowed',
        )}
        title="Not helpful"
      >
        <ThumbsDown className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
