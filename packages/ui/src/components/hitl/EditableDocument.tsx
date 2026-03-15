import { useState } from 'react';
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

  const handleSubmit = () => {
    onSubmit(value);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-surface-950/80 animate-fade-in"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        data-testid="editable-document"
        className="relative w-full max-w-2xl mx-4 rounded-lg border border-surface-700 bg-surface-850 animate-slide-up"
        role="dialog"
        aria-modal="true"
        aria-label={title}
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
            className="input-base w-full resize-y min-h-[200px] font-mono leading-relaxed"
            rows={12}
          />
        </div>

        <div className="flex items-center justify-end gap-6 border-t border-surface-700/40 px-6 py-4">
          <button
            type="button"
            onClick={onCancel}
            className="text-sm font-medium text-surface-400 hover:text-surface-200 transition-colors"
          >
            Cancel
          </button>
          <button
            data-testid="submit-button"
            type="button"
            onClick={handleSubmit}
            className="btn-primary"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
