import { useState, useCallback } from 'react';
import { FileExplorer } from '@/components/explorer/FileExplorer';
import { FileViewer } from '@/components/explorer/FileViewer';
import { File, Upload } from 'lucide-react';

export interface AgentFilesTabProps {
  agentId: string;
  /** When provided, shows session overlay files instead of base workspace */
  sessionId?: string;
}

export function AgentFilesTab({ agentId, sessionId }: AgentFilesTabProps) {
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  // Increment key to force FileExplorer remount after mutations
  const [explorerKey, setExplorerKey] = useState(0);

  const refreshExplorer = useCallback(() => {
    setExplorerKey((k) => k + 1);
  }, []);

  const handleFileDeleted = useCallback(() => {
    setSelectedFile(null);
    refreshExplorer();
  }, [refreshExplorer]);

  return (
    <div data-testid="files-tab-content" className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-surface-200">
          {sessionId ? `Session Workspace (run ${sessionId.slice(0, 8)})` : 'Agent Base Workspace'}
        </h3>
        <p className="text-xs text-surface-400 mt-0.5">
          {sessionId ? 'Files and edits scoped to this run overlay' : 'Base workspace directory for this agent'}
        </p>
      </div>
      <div className="flex min-h-[500px] min-w-0 gap-4">
      {/* File tree (left panel) */}
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

      {/* File viewer (right panel) */}
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
              <button
                type="button"
                onClick={() => {/* TODO: implement upload */}}
                className="mt-4 inline-flex items-center gap-1.5 rounded-md border border-surface-600 px-3 py-1.5 text-sm text-surface-300 hover:bg-surface-800 hover:text-surface-200 transition-colors"
              >
                <Upload className="h-4 w-4" />
                Upload File
              </button>
            </div>
          </div>
        )}
      </div>
      </div>
    </div>
  );
}
