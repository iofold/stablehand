import React, { useCallback, useEffect, useState } from 'react';
import { Archive, Search, Upload } from 'lucide-react';
import { useAgentsStore } from '@/stores/agents';
import { useArtifactsStore } from '@/stores/artifacts';
import { ArtifactList, ArtifactDetailPanel, UploadArtifactModal } from '@/components/artifacts';

export function ArtifactsPage() {
  const { agents, fetchAgents } = useAgentsStore();
  const { fetchArtifacts, fetchAllArtifacts, total, selectedArtifact } = useArtifactsStore();

  const [selectedAgentId, setSelectedAgentId] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState('');
  const [uploadModalOpen, setUploadModalOpen] = useState(false);

  useEffect(() => {
    fetchAgents();
  }, [fetchAgents]);

  const loadArtifacts = useCallback(() => {
    if (selectedAgentId) {
      fetchArtifacts(selectedAgentId);
    } else {
      fetchAllArtifacts({ limit: 200, search: searchQuery || undefined });
    }
  }, [selectedAgentId, searchQuery, fetchArtifacts, fetchAllArtifacts]);

  useEffect(() => {
    loadArtifacts();
  }, [loadArtifacts]);

  return (
    <div className="flex flex-col h-full bg-surface-950">
      <div className="flex-none p-6 border-b border-surface-800">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-3">
            <Archive className="w-6 h-6 text-accent-400" />
            <h1 className="text-2xl font-semibold text-surface-100">Artifacts</h1>
          </div>
          {total > 0 && (
            <span className="text-sm text-surface-400">
              {total} artifact{total !== 1 ? 's' : ''}
            </span>
          )}
        </div>
        <p className="text-surface-400">
          Files your agents saved.
        </p>

        <div className="mt-6 flex items-center gap-4">
          <div className="w-64">
            <select
              value={selectedAgentId}
              onChange={(e) => setSelectedAgentId(e.target.value)}
              className="w-full bg-surface-900 border border-surface-700 text-surface-100 rounded-md px-3 py-2 focus:outline-none focus:border-accent-500"
            >
              <option value="">All agents</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </div>

          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-surface-500" />
            <input
              type="text"
              placeholder="Search artifacts…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-surface-900 border border-surface-700 text-surface-100 rounded-md pl-9 pr-4 py-2 focus:outline-none focus:border-accent-500"
            />
          </div>

          <button
            type="button"
            onClick={() => setUploadModalOpen(true)}
            className="inline-flex items-center gap-2 rounded-md bg-accent-600 px-4 py-2 text-sm font-medium text-white hover:bg-accent-500 transition-colors"
          >
            <Upload className="h-4 w-4" />
            Upload artifact
          </button>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        <ArtifactList searchQuery={selectedAgentId ? searchQuery : ''} showAgentName={!selectedAgentId} />
        {selectedArtifact && <ArtifactDetailPanel />}
      </div>

      <UploadArtifactModal
        open={uploadModalOpen}
        onClose={() => setUploadModalOpen(false)}
        preSelectedAgentId={selectedAgentId}
        onSuccess={loadArtifacts}
      />
    </div>
  );
}
