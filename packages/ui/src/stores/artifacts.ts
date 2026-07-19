import { create } from 'zustand';
import {
  fetchArtifacts as apiFetchArtifacts,
  fetchAllArtifacts as apiFetchAllArtifacts,
  deleteArtifact as apiDeleteArtifact,
  uploadArtifactDirect,
  type Artifact,
} from '@/lib/api';

interface ArtifactsStore {
  artifacts: Artifact[];
  total: number;
  selectedArtifact: Artifact | null;
  loading: boolean;
  error: string | null;
  fetchArtifacts: (agentId: string, turnId?: string) => Promise<void>;
  fetchAllArtifacts: (options?: { limit?: number; offset?: number; search?: string }) => Promise<void>;
  deleteArtifact: (id: string) => Promise<void>;
  uploadArtifact: (file: File, agentId: string) => Promise<void>;
  selectArtifact: (artifact: Artifact | null) => void;
  clearSelection: () => void;
}

export const useArtifactsStore = create<ArtifactsStore>((set, _get) => ({
  artifacts: [],
  total: 0,
  selectedArtifact: null,
  loading: false,
  error: null,

  fetchArtifacts: async (agentId: string, turnId?: string) => {
    if (!agentId) {
      set({ artifacts: [], total: 0, loading: false, error: null });
      return;
    }

    set({ loading: true, error: null });
    try {
      const data = await apiFetchArtifacts(agentId, turnId);
      const artifacts = data.artifacts || [];
      set({ artifacts, total: artifacts.length, loading: false });
    } catch (err) {
      set({ error: String(err), loading: false });
    }
  },

  fetchAllArtifacts: async (options) => {
    set({ loading: true, error: null });
    try {
      const data = await apiFetchAllArtifacts(options);
      set({ artifacts: data.artifacts || [], total: data.total ?? 0, loading: false });
    } catch (err) {
      set({ error: String(err), loading: false });
    }
  },

  deleteArtifact: async (id: string) => {
    try {
      await apiDeleteArtifact(id);
      set((state) => ({
        artifacts: state.artifacts.filter((a) => a.id !== id),
        total: Math.max(0, state.total - 1),
        selectedArtifact: state.selectedArtifact?.id === id ? null : state.selectedArtifact,
      }));
    } catch (err) {
      console.error('[artifacts] deleteArtifact failed:', err);
      throw err;
    }
  },

  uploadArtifact: async (file: File, agentId: string) => {
    set({ loading: true, error: null });
    try {
      await uploadArtifactDirect(file, agentId);
      const data = await apiFetchArtifacts(agentId);
      const artifacts = data.artifacts || [];
      set({ artifacts, total: artifacts.length, loading: false });
    } catch (err) {
      set({ error: String(err), loading: false });
      throw err;
    }
  },

  selectArtifact: (artifact) => {
    set({ selectedArtifact: artifact });
  },

  clearSelection: () => {
    set({ selectedArtifact: null });
  },
}));
