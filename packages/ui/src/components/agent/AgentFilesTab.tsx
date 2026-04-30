import { useRef, useState, useCallback } from 'react';
import { FileExplorer } from '@/components/explorer/FileExplorer';
import { FileViewer } from '@/components/explorer/FileViewer';
import { File, Upload } from 'lucide-react';
import { uploadWorkspaceTarball } from '@/lib/api';

export interface AgentFilesTabProps {
  agentId: string;
  /** When provided, shows session overlay files instead of base workspace */
  sessionId?: string;
}

export function AgentFilesTab({ agentId, sessionId }: AgentFilesTabProps) {
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [explorerKey, setExplorerKey] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [uploadMessage, setUploadMessage] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const refreshExplorer = useCallback(() => {
    setExplorerKey((k) => k + 1);
  }, []);

  const handleFileDeleted = useCallback(() => {
    setSelectedFile(null);
    refreshExplorer();
  }, [refreshExplorer]);

  const handleUpload = useCallback(async (file: File | undefined) => {
    if (!file || sessionId) return;
    setUploading(true);
    setUploadError(null);
    setUploadMessage(null);
    try {
      const result = await uploadWorkspaceTarball(agentId, file);
      setUploadMessage(`Uploaded workspace archive: ${result.files} files, ${result.totalBytes} bytes.`);
      setSelectedFile(null);
      refreshExplorer();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }, [agentId, refreshExplorer, sessionId]);

  const uploadDisabled = uploading || Boolean(sessionId);

  return (
    <div data-testid="files-tab-content" className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-surface-200">
            {sessionId ? `Session Workspace (run ${sessionId.slice(0, 8)})` : 'Agent Base Workspace'}
          </h3>
          <p className="text-xs text-surface-400 mt-0.5">
            {sessionId
              ? 'Files and edits scoped to this run overlay. Uploads replace the base workspace only.'
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
            title={sessionId ? 'Switch to base workspace to upload a workspace archive' : 'Upload workspace .tar.gz'}
          >
            <Upload className="h-4 w-4" />
            {uploading ? 'Uploading…' : 'Upload Workspace'}
          </button>
          {sessionId && <p className="text-[11px] text-surface-500">Base workspace uploads are disabled in session view.</p>}
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

      <div className="flex min-h-[500px] min-w-0 gap-4">
        <div className="w-[280px] flex-shrink-0 rounded-lg border border-surface-700 bg-surface-850 overflow-hidden">
          <FileExplorer
            key={explorerKey}
            agentId={agentId}
            onFileSelect={setSelectedFile}
            selectedFile={selectedFile}
            sessionId={sessionId}
            onFileCreated={refreshExplorer}
          />
        </div>

        <div className="min-w-0 flex-1 rounded-lg border border-surface-700 bg-surface-850 overflow-hidden">
          {selectedFile ? (
            <FileViewer
              agentId={agentId}
              filePath={selectedFile}
              onClose={() => setSelectedFile(null)}
              sessionId={sessionId}
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
