import { useState, useEffect } from 'react';
import { X, FileText, Loader2, AlertCircle, Copy, Check } from 'lucide-react';
import { readFile } from '@/lib/api';
import { cn } from '@/lib/utils';

interface FileViewerProps {
  agentId: string;
  filePath: string;
  onClose: () => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FileViewer({ agentId, filePath, onClose }: FileViewerProps) {
  const [content, setContent] = useState<string | null>(null);
  const [size, setSize] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setError(null);
    setContent(null);

    async function load() {
      try {
        const data = await readFile(agentId, filePath);
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
  }, [agentId, filePath]);

  const handleCopy = async () => {
    if (!content) return;
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard not available
    }
  };

  const fileName = filePath.split('/').pop() ?? filePath;

  return (
    <div data-testid="file-viewer" className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-surface-700/40 px-3 py-2">
        <FileText className="h-3.5 w-3.5 flex-shrink-0 text-surface-400" />
        <div className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium text-surface-200" title={filePath}>
            {fileName}
          </span>
          <span className="text-[10px] text-surface-500 font-mono">{filePath}</span>
        </div>
        {content !== null && (
          <span className="flex-shrink-0 text-[10px] text-surface-500">{formatSize(size)}</span>
        )}
        <button
          type="button"
          onClick={handleCopy}
          className={cn(
            'flex-shrink-0 rounded-md p-1 text-surface-500 transition-colors',
            'hover:bg-surface-700 hover:text-surface-300',
          )}
          title="Copy content"
        >
          {copied ? <Check className="h-3.5 w-3.5 text-green-400" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
        <button
          type="button"
          data-testid="file-viewer-close"
          onClick={onClose}
          className="flex-shrink-0 rounded-md p-1 text-surface-500 transition-colors hover:bg-surface-700 hover:text-surface-300"
          title="Close"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto bg-surface-950/50">
        {loading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-4 w-4 animate-spin text-surface-500" />
          </div>
        )}
        {error && (
          <div className="flex items-center gap-2 px-4 py-6 text-xs text-red-400">
            <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
            <span>Failed to read file</span>
          </div>
        )}
        {!loading && !error && content !== null && (
          <pre className="p-3 text-[11px] leading-relaxed text-surface-300 font-mono whitespace-pre-wrap break-words">
            {content}
          </pre>
        )}
      </div>
    </div>
  );
}
