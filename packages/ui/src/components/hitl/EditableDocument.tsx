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
    <div data-testid="editable-document" className="rounded-lg border border-zinc-700 bg-zinc-900 p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-base font-semibold text-zinc-100">{title}</h3>
        {format && (
          <span className="rounded-md bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400 font-mono">
            {format}
          </span>
        )}
      </div>

      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className={cn(
          'w-full rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-3 text-sm text-zinc-200',
          'font-mono leading-relaxed resize-y min-h-[200px]',
          'focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500',
          'placeholder:text-zinc-600',
        )}
        rows={12}
      />

      <div className="mt-4 flex items-center gap-3">
        <button
          data-testid="submit-button"
          type="button"
          onClick={handleSubmit}
          className="inline-flex items-center rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-500 transition-colors"
        >
          Submit
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex items-center rounded-lg bg-zinc-800 px-4 py-2 text-sm font-medium text-zinc-300 border border-zinc-700 hover:bg-zinc-700 transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
