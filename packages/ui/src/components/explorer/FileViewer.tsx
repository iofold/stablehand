import { useState, useEffect } from 'react';
import { X, FileText, Loader2, AlertCircle, Copy, Check, Pencil, Trash2, Save } from 'lucide-react';
import { readFile, updateFile, deleteFile } from '@/lib/api';
import { cn } from '@/lib/utils';

interface FileViewerProps {
  agentId: string;
  filePath: string;
  onClose: () => void;
  /** When provided, reads from the session overlay instead of base workspace */
  sessionId?: string;
  /** Called after a file is deleted */
  onFileDeleted?: (path: string) => void;
  /** Called after a file is saved */
  onFileSaved?: (path: string) => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FileViewer({ agentId, filePath, onClose, sessionId, onFileDeleted, onFileSaved }: FileViewerProps) {
  const [content, setContent] = useState<string | null>(null);
  const [size, setSize] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setError(null);
    setContent(null);
    setEditing(false);
    setSaveError(null);

    async function load() {
      try {
        const data = await readFile(agentId, filePath, sessionId);
        if (!mounted) return;
        setContent(data.content ?? '');
        setSize(data.size ?? 0);
      } catch (err) {
        if (mounted) setError(String(err));
      } finally {
        if (mounted) setLoading(false);
      }
    }
    load();
    return () => {
      mounted = false;
    };
  }, [agentId, filePath, sessionId]);

  const handleCopy = async () => {
    if (!content) return;
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.debug('[FileViewer] Clipboard write failed:', err);
    }
  };

  const handleEdit = () => {
    setEditing(true);
    setEditContent(content ?? '');
    setSaveError(null);
  };

  const handleCancelEdit = () => {
    setEditing(false);
    setEditContent('');
    setSaveError(null);
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const result = await updateFile(agentId, filePath, editContent, sessionId);
      setContent(editContent);
      setSize(result.size);
      setEditing(false);
      onFileSaved?.(filePath);
    } catch (err) {
      setSaveError(String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await deleteFile(agentId, filePath, sessionId);
      onFileDeleted?.(filePath);
      onClose();
    } catch (err) {
      setError(String(err));
      setShowDeleteConfirm(false);
    } finally {
      setDeleting(false);
    }
  };

  const fileName = filePath.split('/').pop() ?? filePath;
  const isReadOnly = false;

  return (
    <div data-testid="file-viewer" className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-surface-700 bg-surface-850 px-4 py-2">
        <FileText className="h-4 w-4 flex-shrink-0 text-surface-400" />
        <div className="min-w-0 flex-1">
          <span className="block truncate font-mono text-sm text-surface-300" title={filePath}>
            {fileName}
          </span>
        </div>
        {content !== null && (
          <span className="flex-shrink-0 font-mono text-[10px] text-surface-400">
            {formatSize(size)}
          </span>
        )}

        {/* Edit / Save buttons */}
        {!isReadOnly && content !== null && !editing && (
          <button
            type="button"
            data-testid="file-edit-btn"
            onClick={handleEdit}
            className="flex-shrink-0 rounded-md p-1.5 text-surface-400 transition-colors hover:bg-surface-800 hover:text-surface-300"
            title="Edit file"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
        )}
        {editing && (
          <>
            <button
              type="button"
              data-testid="file-save-btn"
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-surface-200 bg-surface-700 hover:bg-surface-600 disabled:opacity-50 transition-colors"
              title="Save changes"
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              Save
            </button>
            <button
              type="button"
              data-testid="file-cancel-edit-btn"
              onClick={handleCancelEdit}
              className="rounded-md px-2 py-1 text-xs text-surface-400 hover:text-surface-200 transition-colors"
            >
              Cancel
            </button>
          </>
        )}

        {/* Delete button */}
        {!isReadOnly && content !== null && !editing && (
          <button
            type="button"
            data-testid="file-delete-btn"
            onClick={() => setShowDeleteConfirm(true)}
            className="flex-shrink-0 rounded-md p-1.5 text-surface-400 transition-colors hover:bg-red-900/30 hover:text-red-400"
            title="Delete file"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}

        <button
          type="button"
          onClick={handleCopy}
          className={cn(
            'flex-shrink-0 rounded-md p-1.5 text-surface-400 transition-colors',
            'hover:bg-surface-800 hover:text-surface-300',
          )}
          title="Copy content"
        >
          {copied ? <Check className="h-3.5 w-3.5 text-green-400" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
        <button
          type="button"
          data-testid="file-viewer-close"
          onClick={onClose}
          className="flex-shrink-0 rounded-md p-1.5 text-surface-400 transition-colors hover:bg-surface-800 hover:text-surface-300"
          title="Close"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Delete confirmation dialog */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setShowDeleteConfirm(false)}>
          <div
            className="w-full max-w-sm rounded-lg border border-surface-700 bg-surface-900 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-4 space-y-3">
              <h3 className="text-sm font-semibold text-surface-200">Delete file?</h3>
              <p className="text-xs text-surface-400">
                This will permanently delete <span className="font-mono text-surface-300">{filePath}</span>. This action cannot be undone.
              </p>
              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setShowDeleteConfirm(false)}
                  className="rounded-md px-3 py-1.5 text-sm text-surface-400 hover:text-surface-200 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  data-testid="confirm-delete-btn"
                  onClick={handleDelete}
                  disabled={deleting}
                  className="flex items-center gap-1.5 rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-50 transition-colors"
                >
                  {deleting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  Delete
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-auto bg-surface-950">
        {loading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-surface-400" />
          </div>
        )}
        {error && (
          <div className="flex items-center gap-2 px-6 py-8 text-sm text-red-400">
            <AlertCircle className="h-4 w-4 flex-shrink-0" />
            <span>Failed to read file: {error}</span>
          </div>
        )}
        {saveError && (
          <div className="flex items-center gap-2 px-4 py-2 text-xs text-red-400 border-b border-surface-800">
            <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
            <span>Save failed: {saveError}</span>
          </div>
        )}
        {!loading && !error && content !== null && !editing && (
          <div className="flex min-h-full font-mono text-sm leading-relaxed">
            {/* Line Numbers */}
            <div className="flex-shrink-0 border-r border-surface-800 bg-surface-900/20 px-4 py-4 text-right text-surface-400 select-none">
              {content.split('\n').map((_, i) => (
                <div key={i + 1}>{i + 1}</div>
              ))}
            </div>
            {/* Code */}
            <pre className="flex-1 p-4 text-surface-300 whitespace-pre overflow-x-auto">
              {content}
            </pre>
          </div>
        )}
        {editing && (
          <textarea
            data-testid="file-edit-textarea"
            value={editContent}
            onChange={(e) => setEditContent(e.target.value)}
            className="h-full w-full resize-none bg-surface-950 p-4 font-mono text-sm text-surface-300 leading-relaxed focus:outline-none"
            spellCheck={false}
          />
        )}
      </div>
    </div>
  );
}
