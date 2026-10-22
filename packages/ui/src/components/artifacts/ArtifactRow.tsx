import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { FileText, Image, File, Download, Trash2, Archive } from 'lucide-react';
import type { Artifact } from '@/lib/api';
import { useArtifactsStore } from '@/stores/artifacts';
import { useAgentsStore } from '@/stores/agents';
import { formatBytes } from '@/lib/format';
import { downloadArtifact as downloadArtifactFile } from '@/lib/api';

interface ArtifactRowProps {
  artifact: Artifact;
  isSelected: boolean;
  showAgentName?: boolean;
}

export function getMimeIcon(mimeType: string) {
  if (mimeType.startsWith('image/')) return <Image className="w-4 h-4 text-accent-400" />;
  if (mimeType.startsWith('text/')) return <FileText className="w-4 h-4 text-accent-400" />;
  if (mimeType.includes('zip') || mimeType.includes('tar') || mimeType.includes('gzip')) {
    return <Archive className="w-4 h-4 text-accent-400" />;
  }
  return <File className="w-4 h-4 text-accent-400" />;
}

export function ArtifactRow({ artifact, isSelected, showAgentName = false }: ArtifactRowProps) {
  const selectArtifact = useArtifactsStore((s) => s.selectArtifact);
  const deleteArtifact = useArtifactsStore((s) => s.deleteArtifact);
  const agents = useAgentsStore((s) => s.agents);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const agentName = showAgentName
    ? agents.find((a) => a.id === artifact.agentId)?.name
    : undefined;
  const agentFallback = artifact.agentId
    ? `${artifact.agentId.slice(0, 8)}...`
    : 'No agent';

  const handleDownload = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsDownloading(true);
    setActionError(null);
    try {
      await downloadArtifactFile(artifact.id, artifact.name);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsDownloading(false);
    }
  };

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm(`Are you sure you want to delete ${artifact.name}?`)) return;
    
    setIsDeleting(true);
    setActionError(null);
    try {
      await deleteArtifact(artifact.id);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
      setIsDeleting(false);
    }
  };

  return (
    <tr
      onClick={() => selectArtifact(artifact)}
      className={`
        cursor-pointer border-b border-surface-800 transition-colors
        ${isSelected ? 'bg-surface-800' : 'hover:bg-surface-800/50'}
        ${isDeleting ? 'opacity-50 pointer-events-none' : ''}
      `}
    >
      <td className="px-4 py-3">
        <div className="flex items-center gap-3">
          {getMimeIcon(artifact.mimeType)}
          <span className="font-medium text-surface-100 truncate max-w-[200px] sm:max-w-[300px]" title={artifact.name}>
            {artifact.name}
          </span>
        </div>
      </td>
      <td className="px-4 py-3 text-sm text-surface-400">
        {artifact.mimeType}
      </td>
      <td className="px-4 py-3 text-sm text-surface-400">
        {formatBytes(artifact.sizeBytes)}
      </td>
      <td className="px-4 py-3 text-sm text-surface-400">
        {agentName && artifact.agentId ? (
          <Link
            to={`/agents/${artifact.agentId}`}
            onClick={(clickEvent) => clickEvent.stopPropagation()}
            className="truncate max-w-[120px] inline-block hover:text-accent-300 hover:underline"
            title={`Open ${agentName}`}
          >
            {agentName}
          </Link>
        ) : (
          <span className={artifact.agentId ? 'font-mono text-xs' : 'text-xs text-surface-500'}>
            {agentFallback}
          </span>
        )}
      </td>
      <td className="px-4 py-3 text-sm text-surface-400">
        {artifact.createdAt ? new Date(artifact.createdAt).toLocaleDateString() : 'Unknown'}
      </td>
      <td className="px-4 py-3">
        <div className="flex flex-col items-end gap-1">
          <div className="flex items-center gap-2 justify-end">
            <button
              type="button"
              onClick={handleDownload}
              disabled={isDownloading || isDeleting}
              className="p-1.5 text-surface-400 hover:text-accent-400 hover:bg-surface-700 rounded transition-colors"
              title={isDownloading ? 'Downloading' : 'Download'}
            >
              <Download className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={handleDelete}
              disabled={isDeleting || isDownloading}
              className="p-1.5 text-surface-400 hover:text-red-400 hover:bg-surface-700 rounded transition-colors"
              title="Delete"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
          {actionError && (
            <p role="alert" className="max-w-48 text-right text-xs text-red-300">
              {actionError}
            </p>
          )}
        </div>
      </td>
    </tr>
  );
}
