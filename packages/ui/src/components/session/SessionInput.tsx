import { useState, useRef, useCallback, useEffect } from 'react';
import { Send, CornerDownLeft } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Why the composer is locked, if it is. */
export type ComposerStatus = 'ready' | 'connecting' | 'working' | 'awaiting-approval' | 'finishing';

const COMPOSER_COPY: Record<ComposerStatus, { placeholder: string; hint: string }> = {
  ready: {
    placeholder: 'Message the agent…',
    hint: 'Enter to send · Shift+Enter for a new line',
  },
  connecting: {
    placeholder: 'Connecting…',
    hint: 'Loading the conversation',
  },
  working: {
    placeholder: 'Agent is working…',
    hint: 'You can send a new message when this turn ends',
  },
  'awaiting-approval': {
    placeholder: 'Waiting for your decision…',
    hint: 'The agent is paused until you approve or reject the request',
  },
  finishing: {
    placeholder: 'Closing the turn…',
    hint: 'The reply is complete. You can send a new message when the turn closes',
  },
};

interface SessionInputProps {
  onSend: (content: string) => void;
  status?: ComposerStatus;
}

export function SessionInput({ onSend, status = 'ready' }: SessionInputProps) {
  const [value, setValue] = useState('');
  const [isFocused, setIsFocused] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const disabled = status !== 'ready';
  const copy = COMPOSER_COPY[status];

  /* Auto-focus on mount */
  useEffect(() => {
    if (!disabled) {
      textareaRef.current?.focus();
    }
  }, [disabled]);

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setValue('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [value, disabled, onSend]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  };

  const canSend = value.trim().length > 0 && !disabled;

  return (
    <div className="border-t border-surface-700 bg-surface-850 px-4 py-3">
      <div className="mx-auto max-w-3xl">
        <div
          className={cn(
            'relative flex items-end gap-2 bg-surface-800 border border-surface-700 rounded-lg transition-all duration-200',
            isFocused
              ? 'border-accent-500'
              : '',
            disabled && 'opacity-60',
          )}
        >
          <textarea
            ref={textareaRef}
            data-testid="session-input"
            data-status={status}
            value={value}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            disabled={disabled}
            rows={1}
            placeholder={copy.placeholder}
            className={cn(
              'flex-1 resize-none bg-transparent px-4 py-3 text-sm text-surface-200 placeholder-surface-400 focus:outline-none',
              'min-h-[44px] max-h-[200px]',
              disabled && 'cursor-not-allowed',
            )}
          />
          <div className="flex items-center gap-1.5 pr-2 pb-2">
            {/* Keyboard hint */}
            {!disabled && value.trim() && (
              <div className="hidden sm:flex items-center gap-1 text-[10px] text-surface-400 mr-1">
                <CornerDownLeft className="h-3 w-3" />
              </div>
            )}
            <button
              type="button"
              data-testid="send-button"
              onClick={handleSend}
              disabled={!canSend}
              aria-label="Send message"
              className={cn(
                'flex h-10 w-10 items-center justify-center rounded-md transition-all duration-200',
                canSend
                  ? 'bg-accent-600 text-white hover:bg-accent-500'
                  : 'bg-surface-700/50 text-surface-400',
              )}
            >
              <Send className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="mt-1.5 flex items-center justify-center">
          <p data-testid="session-input-hint" className="text-[10px] text-surface-400">
            {copy.hint}
          </p>
        </div>
      </div>
    </div>
  );
}
