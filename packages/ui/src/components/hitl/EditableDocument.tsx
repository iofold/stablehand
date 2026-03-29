import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface EditableDocumentProps {
  title: string;
  content: string;
  format?: string;
  onSubmit: (content: string) => void;
  onCancel: () => void;
}

export function EditableDocument({ title, content, format, onSubmit, onCancel }: EditableDocumentProps) {
  const [value, setValue] = useState(content);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isDirty = value !== content;

  const handleSubmit = async () => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    setError(null);
    try {
      await Promise.resolve(onSubmit(value));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
      setIsSubmitting(false);
      return;
    }
    setIsSubmitting(false);
  };

  const handleClose = () => {
    if (isDirty && !window.confirm('You have unsaved changes. Discard?')) return;
    onCancel();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-surface-950/80 animate-fade-in"
      onClick={(e) => {
        if (e.target === e.currentTarget) handleClose();
      }}
    >
      <div
        data-testid="editable-document"
        className="relative w-full max-w-2xl mx-4 rounded-lg border border-surface-700 bg-surface-850 animate-slide-up"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        aria-busy={isSubmitting}
      >
        <div className="flex items-center justify-between border-b border-surface-700/40 px-6 py-4">
          <h2 className="text-lg font-semibold text-surface-100">{title}</h2>
          {format && (
            <span className="rounded-md bg-surface-800 px-2 py-0.5 text-xs text-surface-400 font-mono">
              {format}
            </span>
          )}
        </div>

        <div className="p-6">
          <textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={isSubmitting}
            className="input-base w-full resize-y min-h-[200px] font-mono leading-relaxed disabled:opacity-50 disabled:cursor-not-allowed"
            rows={12}
          />
        </div>

        <div className="flex flex-col border-t border-surface-700/40 px-6 py-4">
          {error && (
            <div className="mb-4 text-sm text-status-error bg-status-error/10 px-3 py-2 rounded-md">
              {error}
            </div>
          )}
          <div className="flex items-center justify-end gap-6">
            <button
              type="button"
              onClick={handleClose}
              disabled={isSubmitting}
              className="text-sm font-medium text-surface-400 hover:text-surface-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Cancel
            </button>
            <button
              data-testid="submit-button"
              type="button"
              onClick={handleSubmit}
              disabled={isSubmitting}
              className="btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
