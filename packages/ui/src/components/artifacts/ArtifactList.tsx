import React from 'react';
import { Archive } from 'lucide-react';
import { useArtifactsStore } from '@/stores/artifacts';
import { ArtifactRow } from './ArtifactRow';

interface ArtifactListProps {
  searchQuery?: string;
  showAgentName?: boolean;
}

export function ArtifactList({ searchQuery = '', showAgentName = false }: ArtifactListProps) {
  const { artifacts, loading, error, selectedArtifact } = useArtifactsStore();

  if (loading) {
    return (
      <div className="flex-1 p-6">
        <div className="animate-pulse space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-12 bg-surface-800 rounded" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 p-6">
        <div className="bg-red-500/10 border border-red-500/20 text-red-400 p-4 rounded">
          {error}
        </div>
      </div>
    );
  }

  const filteredArtifacts = searchQuery
    ? artifacts.filter((a) =>
        a.name.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : artifacts;

  if (filteredArtifacts.length === 0) {
    return (
      <div className="flex-1 p-6 flex items-center justify-center">
        <div className="text-center p-8 border-2 border-dashed border-surface-800 rounded-lg max-w-md w-full">
          <Archive className="w-12 h-12 text-surface-600 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-surface-100 mb-2">No artifacts</h3>
          <p className="text-surface-400">
            {searchQuery ? 'No artifacts match your search.' : 'No artifacts have been generated yet.'}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto">
      <table className="w-full text-left border-collapse">
        <thead className="sticky top-0 bg-surface-900 z-10 shadow-sm">
          <tr>
            <th className="px-4 py-3 text-xs font-medium text-surface-400 uppercase tracking-wider">Name</th>
            <th className="px-4 py-3 text-xs font-medium text-surface-400 uppercase tracking-wider">Type</th>
            <th className="px-4 py-3 text-xs font-medium text-surface-400 uppercase tracking-wider">Size</th>
            <th className="px-4 py-3 text-xs font-medium text-surface-400 uppercase tracking-wider">Agent</th>
            <th className="px-4 py-3 text-xs font-medium text-surface-400 uppercase tracking-wider">Created</th>
            <th className="px-4 py-3 text-xs font-medium text-surface-400 uppercase tracking-wider text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {filteredArtifacts.map((artifact) => (
            <ArtifactRow
              key={artifact.id}
              artifact={artifact}
              isSelected={selectedArtifact?.id === artifact.id}
              showAgentName={showAgentName}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
