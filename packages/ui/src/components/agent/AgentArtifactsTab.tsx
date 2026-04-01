import React, { useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import { useArtifactsStore } from '@/stores/artifacts';
import { ArtifactList, ArtifactDetailPanel } from '@/components/artifacts';

interface AgentArtifactsTabProps {
  agentId: string;
}

export function AgentArtifactsTab({ agentId }: AgentArtifactsTabProps) {
  const { fetchArtifacts, selectedArtifact } = useArtifactsStore();
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    if (agentId) {
      fetchArtifacts(agentId);
    }
  }, [agentId, fetchArtifacts]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex-none p-4 border-b border-surface-800 flex items-center justify-between">
        <h2 className="text-lg font-medium text-surface-100">Artifacts</h2>
        <div className="relative w-64">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-surface-500" />
          <input
            type="text"
            placeholder="Search artifacts..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-surface-900 border border-surface-700 text-surface-100 rounded-md pl-9 pr-4 py-1.5 text-sm focus:outline-none focus:border-accent-500"
          />
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        <ArtifactList searchQuery={searchQuery} />
        {selectedArtifact && <ArtifactDetailPanel />}
      </div>
    </div>
  );
}
