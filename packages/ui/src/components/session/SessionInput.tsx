import { useState, useRef, useCallback, useEffect } from 'react';
import { Send, CornerDownLeft } from 'lucide-react';
import { cn } from '@/lib/utils';

interface SessionInputProps {
  onSend: (content: string) => void;
  disabled?: boolean;
}

export function SessionInput({ onSend, disabled }: SessionInputProps) {
  const [value, setValue] = useState('');
  const [isFocused, setIsFocused] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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
            value={value}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            disabled={disabled}
            rows={1}
            placeholder={disabled ? 'Agent is thinking...' : 'Message the agent...'}
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
              className={cn(
                'flex items-center justify-center rounded-md px-3 py-2 transition-all duration-200',
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
          <p className="text-[10px] text-surface-400">
            {disabled ? 'Streaming response...' : 'Press Enter to send, Shift+Enter for new line'}
          </p>
        </div>
      </div>
    </div>
  );
}
