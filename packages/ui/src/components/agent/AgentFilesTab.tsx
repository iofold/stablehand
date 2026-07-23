import { useRef, useState, useCallback, useEffect } from 'react';
import { FileExplorer } from '@/components/explorer/FileExplorer';
import { FileViewer } from '@/components/explorer/FileViewer';
import { File, Upload } from 'lucide-react';
import { uploadWorkspaceTarball, fetchSettings } from '@/lib/api';
import { validateWorkspaceArchive, DEFAULT_MAX_TAR_UPLOAD_BYTES } from '@/lib/workspace-upload';

export interface AgentFilesTabProps {
  agentId: string;
  /** When provided, shows conversation workspace files instead of base workspace */
  conversationId?: string;
}

export function AgentFilesTab({ agentId, conversationId }: AgentFilesTabProps) {
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [explorerKey, setExplorerKey] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [uploadMessage, setUploadMessage] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [maxArchiveBytes, setMaxArchiveBytes] = useState<number>(DEFAULT_MAX_TAR_UPLOAD_BYTES);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Fetch the configured max upload size from settings (falls back to default).
  useEffect(() => {
    let mounted = true;
    fetchSettings()
      .then((s) => {
        if (mounted && typeof s.maxTarUploadBytes === 'number' && s.maxTarUploadBytes > 0) {
          setMaxArchiveBytes(s.maxTarUploadBytes);
        }
      })
      .catch(() => {
        // Settings fetch is best-effort; the server enforces the real limit.
      });
    return () => { mounted = false; };
  }, []);

  const refreshExplorer = useCallback(() => {
    setExplorerKey((k) => k + 1);
  }, []);

  const handleFileDeleted = useCallback(() => {
    setSelectedFile(null);
    refreshExplorer();
  }, [refreshExplorer]);

  const handleUpload = useCallback(async (file: File | undefined) => {
    if (!file || conversationId) return;

    // Client-side pre-validation per ADR 010: tar.gz only, archive size limit.
    const validation = validateWorkspaceArchive(file, { maxBytes: maxArchiveBytes });
    if (!validation.ok) {
      setUploadError(validation.error);
      setUploadMessage(null);
      if (inputRef.current) inputRef.current.value = '';
      return;
    }

    setUploading(true);
    setUploadError(null);
    setUploadMessage(null);
    try {
      const result = await uploadWorkspaceTarball(agentId, file);
      setUploadMessage(`Uploaded workspace archive: ${result.fileCount} files, ${result.totalBytes} bytes.`);
      setSelectedFile(null);
      refreshExplorer();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }, [agentId, maxArchiveBytes, refreshExplorer, conversationId]);

  const uploadDisabled = uploading || Boolean(conversationId);

  const handleDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (uploadDisabled) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setIsDragging(true);
  }, [uploadDisabled]);

  const handleDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    if (uploadDisabled) return;
    const file = event.dataTransfer.files?.[0];
    if (file) {
      void handleUpload(file);
    }
  }, [handleUpload, uploadDisabled]);

  return (
    <div data-testid="files-tab-content" className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-surface-200">
            {conversationId ? `Conversation Workspace (${conversationId.slice(0, 8)})` : 'Agent Base Workspace'}
          </h3>
          <p className="text-xs text-surface-400 mt-0.5">
            {conversationId
              ? 'Files and edits scoped to this durable conversation workspace. Uploads replace the base workspace only.'
              : 'Base workspace directory for this agent. Upload accepts a workspace .tar.gz archive, not an artifact.'}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <input
            ref={inputRef}
            data-testid="workspace-upload-input"
            type="file"
            accept=".tar.gz,.tgz,application/gzip,application/x-gzip"
            className="hidden"
            onChange={(event) => void handleUpload(event.currentTarget.files?.[0])}
            disabled={uploadDisabled}
          />
          <button
            type="button"
            data-testid="workspace-upload-button"
            onClick={() => inputRef.current?.click()}
            disabled={uploadDisabled}
            className="inline-flex items-center gap-1.5 rounded-md border border-surface-600 px-3 py-1.5 text-sm text-surface-300 transition-colors hover:bg-surface-800 hover:text-surface-200 disabled:cursor-not-allowed disabled:opacity-50"
            title={conversationId ? 'Switch to base workspace to upload a workspace archive' : 'Upload workspace .tar.gz'}
          >
            <Upload className="h-4 w-4" />
            {uploading ? 'Uploading…' : 'Upload Workspace'}
          </button>
          {conversationId && <p className="text-[11px] text-surface-500">Base workspace uploads are disabled in conversation view.</p>}
        </div>
      </div>

      {uploadMessage && (
        <div role="status" className="rounded-lg border border-green-500/30 bg-green-500/10 px-3 py-2 text-sm text-green-300">
          {uploadMessage}
        </div>
      )}
      {uploadError && (
        <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          Workspace upload failed: {uploadError}
        </div>
      )}

      <div
        data-testid="workspace-upload-dropzone"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`flex min-h-[500px] min-w-0 gap-4 rounded-lg transition-colors ${isDragging && !uploadDisabled ? 'ring-2 ring-accent-500/60 bg-accent-500/5' : ''}`}
      >
        <div className="w-[280px] flex-shrink-0 rounded-lg border border-surface-700 bg-surface-850 overflow-hidden">
          <FileExplorer
            key={explorerKey}
            agentId={agentId}
            onFileSelect={setSelectedFile}
            selectedFile={selectedFile}
            conversationId={conversationId}
            onFileCreated={refreshExplorer}
          />
        </div>

        <div className="min-w-0 flex-1 rounded-lg border border-surface-700 bg-surface-850 overflow-hidden">
          {selectedFile ? (
            <FileViewer
              agentId={agentId}
              filePath={selectedFile}
              onClose={() => setSelectedFile(null)}
              conversationId={conversationId}
              onFileDeleted={handleFileDeleted}
              onFileSaved={refreshExplorer}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-center p-8">
              <div className="border-2 border-dashed border-surface-600 rounded-lg p-8">
                <File className="h-10 w-10 text-surface-400 mx-auto mb-3" />
                <p className="text-surface-300 font-medium">No file selected</p>
                <p className="text-surface-400 text-sm mt-1">Select a file from the explorer to view its contents.</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
