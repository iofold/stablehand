import { useState } from 'react';
import { Check, Loader2, X } from 'lucide-react';

interface EditableDocumentProps {
  title: string;
  content: string;
  format?: string;
  /** Approve, with the possibly edited text and an optional note for the agent. */
  onSubmit: (content: string, note?: string) => void | Promise<void>;
  /** Reject with an optional note; omitted when the caller has no reject path. */
  onReject?: (note?: string) => void | Promise<void>;
  /** Close without deciding; the draft keeps waiting. */
  onCancel: () => void;
}

/**
 * Review card for `edit_document`: approve as is, edit and approve, or
 * reject with a note. Works at phone width.
 */
export function EditableDocument({ title, content, format, onSubmit, onReject, onCancel }: EditableDocumentProps) {
  const [value, setValue] = useState(content);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isDirty = value !== content;
  const trimmedNote = note.trim() || undefined;

  const decide = async (action: 'approve' | 'reject') => {
    if (busy) return;
    setBusy(action);
    setError(null);
    try {
      if (action === 'approve') {
        await Promise.resolve(onSubmit(value, trimmedNote));
      } else if (onReject) {
        await Promise.resolve(onReject(trimmedNote));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The decision was not sent');
    } finally {
      setBusy(null);
    }
  };

  const handleClose = () => {
    if (isDirty && !window.confirm('You have unsaved edits. Discard them?')) return;
    onCancel();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-surface-950/80 animate-fade-in">
      <button type="button" aria-label="Close editor" className="absolute inset-0" onClick={handleClose} />
      <div
        data-testid="editable-document"
        className="relative z-10 mx-4 flex max-h-[92vh] w-full max-w-2xl flex-col rounded-lg border border-surface-700 bg-surface-850 animate-slide-up"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        aria-busy={busy !== null}
      >
        <div className="flex items-center justify-between gap-3 border-b border-surface-700/40 px-4 py-3 sm:px-6 sm:py-4">
          <h2 className="text-base font-semibold text-surface-100 sm:text-lg">{title}</h2>
          {format && (
            <span className="shrink-0 rounded-md bg-surface-800 px-2 py-0.5 font-mono text-xs text-surface-400">
              {format}
            </span>
          )}
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 sm:p-6">
          <textarea
            aria-label="Draft text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={busy !== null}
            className="input-base min-h-[200px] w-full resize-y leading-relaxed disabled:cursor-not-allowed disabled:opacity-50"
            rows={12}
          />
          <input
            aria-label="Note for the agent"
            placeholder="Note for the agent (optional), e.g. why you rejected it"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={busy !== null}
            className="input-base w-full text-sm"
          />
        </div>

        <div className="flex flex-col border-t border-surface-700/40 px-4 py-3 sm:px-6 sm:py-4">
          {error && (
            <div className="mb-3 rounded-md bg-status-error/10 px-3 py-2 text-sm text-status-error">{error}</div>
          )}
          <div className="flex flex-wrap items-center justify-end gap-3">
            <button
              type="button"
              onClick={handleClose}
              disabled={busy !== null}
              className="mr-auto text-sm font-medium text-surface-400 transition-colors hover:text-surface-200 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Later
            </button>
            {onReject && (
              <button
                type="button"
                data-testid="reject-document-button"
                onClick={() => void decide('reject')}
                disabled={busy !== null}
                className="btn-secondary flex items-center gap-1.5 px-3 py-1.5 hover:border-red-500/50 hover:text-red-300 disabled:cursor-not-allowed"
              >
                {busy === 'reject' ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
                Reject
              </button>
            )}
            <button
              data-testid="submit-button"
              type="button"
              onClick={() => void decide('approve')}
              disabled={busy !== null}
              className="btn-primary flex items-center gap-1.5 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy === 'approve' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              {isDirty ? 'Approve with edits' : 'Approve'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
