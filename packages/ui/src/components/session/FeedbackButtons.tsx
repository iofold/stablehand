import { useState, useEffect } from 'react';
import { ThumbsUp, ThumbsDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { submitFeedback } from '@/lib/api';

interface FeedbackButtonsProps {
  agentId: string;
  messageId: string;
  conversationId?: string;
}

export function FeedbackButtons({ agentId, messageId, conversationId }: FeedbackButtonsProps) {
  const [feedback, setFeedback] = useState<'up' | 'down' | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showToast, setShowToast] = useState(false);

  useEffect(() => {
    if (!showToast) return;
    const timer = setTimeout(() => setShowToast(false), 2000);
    return () => clearTimeout(timer);
  }, [showToast]);

  const sendFeedback = async (type: 'thumbs_up' | 'thumbs_down') => {
    setSubmitting(true);
    try {
      await submitFeedback(agentId, {
          conversationId: conversationId || 'unknown',
        messageId,
        type,
      });
      setFeedback(type === 'thumbs_up' ? 'up' : 'down');
      setShowToast(true);
    } catch (err) {
      console.warn('[Feedback] Submission failed:', err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div data-testid="feedback-buttons" className="relative flex items-center gap-2 mt-1">
      <button
        type="button"
        data-testid="thumbs-up"
        disabled={submitting || feedback !== null}
        onClick={() => sendFeedback('thumbs_up')}
        className={cn(
          'transition-colors',
          feedback === 'up'
            ? 'text-accent-400'
            : 'text-surface-400 hover:text-surface-200',
          (submitting || feedback !== null) && feedback !== 'up' && 'opacity-30 cursor-not-allowed',
        )}
        title="Helpful"
      >
        <ThumbsUp className="h-4 w-4" />
      </button>
      <button
        type="button"
        data-testid="thumbs-down"
        disabled={submitting || feedback !== null}
        onClick={() => sendFeedback('thumbs_down')}
        className={cn(
          'transition-colors',
          feedback === 'down'
            ? 'text-accent-400'
            : 'text-surface-400 hover:text-surface-200',
          (submitting || feedback !== null) && feedback !== 'down' && 'opacity-30 cursor-not-allowed',
        )}
        title="Not helpful"
      >
        <ThumbsDown className="h-4 w-4" />
      </button>

      {/* Post-feedback toast */}
      {showToast && (
        <span className="ml-2 text-[11px] text-surface-400 animate-fade-in">
          Feedback sent
        </span>
      )}
    </div>
  );
}
