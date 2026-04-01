import React from 'react';
import { X, Download } from 'lucide-react';
import { useArtifactsStore } from '@/stores/artifacts';
import { formatBytes, getMimeIcon } from './ArtifactRow';


export function ArtifactDetailPanel() {
  const { selectedArtifact, clearSelection } = useArtifactsStore();

  if (!selectedArtifact) return null;

  const handleDownload = () => {
    window.open(`/api/artifacts/${selectedArtifact.id}/download`, '_blank');
  };

  return (
    <div className="w-[400px] border-l border-surface-800 bg-surface-900 flex flex-col h-full">
      <div className="p-4 border-b border-surface-800 flex items-center justify-between">
        <h3 className="font-medium text-surface-100">Artifact Details</h3>
        <button
          type="button"
          onClick={clearSelection}
          className="p-1 text-surface-400 hover:text-surface-100 rounded transition-colors"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        <div className="flex items-start gap-4">
          <div className="p-3 bg-surface-800 rounded-lg">
            {getMimeIcon(selectedArtifact.mimeType)}
          </div>
          <div className="flex-1 min-w-0">
            <h4 className="text-lg font-medium text-surface-100 break-words">
              {selectedArtifact.name}
            </h4>
            <p className="text-sm text-surface-400 mt-1">{selectedArtifact.mimeType}</p>
          </div>
        </div>

        <button
          type="button"
          onClick={handleDownload}
          className="w-full flex items-center justify-center gap-2 py-2.5 bg-accent-500 hover:bg-accent-400 text-white rounded-md font-medium transition-colors"
        >
          <Download className="w-4 h-4" />
          Download File
        </button>

        <div className="space-y-4">
          <div>
            <div className="text-xs font-medium text-surface-500 uppercase tracking-wider">Size</div>
            <p className="text-sm text-surface-100 mt-1">{formatBytes(selectedArtifact.sizeBytes)}</p>
          </div>

          <div>
            <div className="text-xs font-medium text-surface-500 uppercase tracking-wider">Agent ID</div>
            <p className="text-sm text-surface-100 mt-1 font-mono break-all">{selectedArtifact.agentId}</p>
          </div>

          {selectedArtifact.sessionId && (
            <div>
              <div className="text-xs font-medium text-surface-500 uppercase tracking-wider">Session ID</div>
              <p className="text-sm text-surface-100 mt-1 font-mono break-all">{selectedArtifact.sessionId}</p>
            </div>
          )}

          <div>
            <div className="text-xs font-medium text-surface-500 uppercase tracking-wider">Storage Key</div>
            <p className="text-sm text-surface-100 mt-1 font-mono break-all">{selectedArtifact.storageKey}</p>
          </div>

          <div>
            <div className="text-xs font-medium text-surface-500 uppercase tracking-wider">Created</div>
            <p className="text-sm text-surface-100 mt-1">
              {selectedArtifact.createdAt ? new Date(selectedArtifact.createdAt).toLocaleString() : 'Unknown'}
            </p>
          </div>

          {selectedArtifact.metadata && Object.keys(selectedArtifact.metadata).length > 0 && (
            <div>
              <div className="text-xs font-medium text-surface-500 uppercase tracking-wider">Metadata</div>
              <pre className="mt-2 p-3 bg-surface-950 rounded-md text-xs text-surface-300 overflow-x-auto border border-surface-800">
                {JSON.stringify(selectedArtifact.metadata, null, 2)}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
