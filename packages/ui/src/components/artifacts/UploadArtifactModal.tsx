import { useState, useEffect, useRef, type ChangeEvent, type DragEvent } from 'react';
import { X, Upload, File as FileIcon, Loader2 } from 'lucide-react';
import { useArtifactsStore } from '@/stores/artifacts';
import { useAgentsStore } from '@/stores/agents';
import { formatBytes } from '@/lib/format';
import { cn } from '@/lib/utils';

interface UploadArtifactModalProps {
  open: boolean;
  onClose: () => void;
  preSelectedAgentId?: string;
  onSuccess?: () => void;
}

export function UploadArtifactModal({ open, onClose, preSelectedAgentId, onSuccess }: UploadArtifactModalProps) {
  const { uploadArtifact } = useArtifactsStore();
  const { agents, fetchAgents } = useAgentsStore();

  useEffect(() => {
    if (open && agents.length === 0) fetchAgents();
  }, [open, agents.length, fetchAgents]);

  useEffect(() => {
    if (open && preSelectedAgentId && agents.some(a => a.id === preSelectedAgentId)) {
      setAgentId(preSelectedAgentId);
    }
  }, [open, preSelectedAgentId, agents]);
  
  const [agentId, setAgentId] = useState<string>(preSelectedAgentId || '');
  const [file, setFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!open) return null;

  const handleDragOver = (e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      setFile(e.dataTransfer.files[0]);
      setError(null);
    }
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      setFile(e.target.files[0]);
      setError(null);
    }
  };

  const handleUpload = async () => {
    if (!file || !agentId) return;
    
    setUploading(true);
    setError(null);
    
    try {
      await uploadArtifact(file, agentId);
      if (onSuccess) onSuccess();
      handleClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  };

  const handleClose = () => {
    setFile(null);
    setError(null);
    setAgentId(preSelectedAgentId || '');
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 animate-fade-in">
      <button
        type="button"
        aria-label="Close upload modal"
        className="absolute inset-0"
        onClick={handleClose}
        disabled={uploading}
      />
      <div
        className="relative z-10 w-full max-w-lg mx-4 rounded-xl border border-surface-700 bg-surface-800 animate-slide-up"
        role="dialog"
        aria-modal="true"
        aria-label="Upload Artifact"
      >
        <div className="flex items-center justify-between border-b border-surface-700 px-6 py-4">
          <h2 className="text-lg font-semibold text-surface-100">Upload Artifact</h2>
          <button
            type="button"
            onClick={handleClose}
            disabled={uploading}
            className="rounded-lg p-1.5 text-surface-400 transition-colors hover:bg-surface-700 hover:text-surface-200 disabled:opacity-50"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="px-6 py-5 space-y-5">
          {error && (
            <div className="rounded-md bg-red-500/10 border border-red-500/20 p-3">
              <p className="text-sm text-red-400">{error}</p>
            </div>
          )}

          <div>
            <label htmlFor="agent-select" className="block text-sm font-medium text-surface-300 mb-1.5">
              Agent
            </label>
            <select
              key={agents.length > 0 ? 'loaded' : 'loading'}
              id="agent-select"
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              disabled={uploading || !!preSelectedAgentId}
              className="w-full rounded-md border border-surface-600 bg-surface-900 px-3 py-2 text-sm text-surface-100 focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-accent-500 disabled:opacity-50"
            >
              <option value="" disabled>Select an agent</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <div className="block text-sm font-medium text-surface-300 mb-1.5">
              File
            </div>
            {!file ? (
              <button
                type="button"
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                className={cn(
                  "w-full flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-8 text-center cursor-pointer transition-colors",
                  isDragging 
                    ? "border-accent-500 bg-accent-500/10" 
                    : "border-surface-600 bg-surface-900/50 hover:border-accent-500 hover:bg-surface-800",
                  uploading && "pointer-events-none opacity-50"
                )}
              >
                <Upload className={cn("h-8 w-8 mb-3", isDragging ? "text-accent-400" : "text-surface-400")} />
                <p className="text-sm font-medium text-surface-200">
                  Drop file here or click to browse
                </p>
                <p className="text-xs text-surface-400 mt-1">
                  Any file type is supported
                </p>
                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={handleFileChange}
                  className="hidden"
                  disabled={uploading}
                  aria-label="File upload"
                />
              </button>
            ) : (
              <div className="flex items-center justify-between rounded-lg border border-surface-600 bg-surface-900/50 p-4">
                <div className="flex items-center space-x-3 overflow-hidden">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-surface-800">
                    <FileIcon className="h-5 w-5 text-accent-400" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-surface-100">
                      {file.name}
                    </p>
                    <p className="text-xs text-surface-400">
                      {formatBytes(file.size)} • {file.type || 'Unknown type'}
                    </p>
                  </div>
                </div>
                {!uploading && (
                  <button
                    type="button"
                    onClick={() => setFile(null)}
                    className="ml-4 shrink-0 rounded-md p-1.5 text-surface-400 hover:bg-surface-800 hover:text-surface-200"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-surface-700 px-6 py-4 bg-surface-800/50 rounded-b-xl">
          <button
            type="button"
            onClick={handleClose}
            disabled={uploading}
            className="rounded-md px-4 py-2 text-sm font-medium text-surface-300 hover:bg-surface-700 hover:text-surface-100 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleUpload}
            disabled={!file || !agentId || uploading}
            className="inline-flex items-center justify-center rounded-md bg-accent-600 px-4 py-2 text-sm font-medium text-white hover:bg-accent-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {uploading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Uploading...
              </>
            ) : (
              'Upload'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
