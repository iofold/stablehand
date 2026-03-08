import { create } from 'zustand';
import {
  fetchAgents as apiFetchAgents,
  startBackgroundRun as apiStartRun,
  cancelRun as apiCancelRun,
  fetchRuns as apiFetchRuns,
} from '@/lib/api';

export interface AgentRun {
  id: string;
  agentId: string;
  conversationId: string;
  status: 'queued' | 'running' | 'completed' | 'error' | 'cancelled';
  mode: 'interactive' | 'background';
  startedAt: number;
  completedAt?: number;
  error?: string;
  taskDescription?: string;
}

export interface Agent {
  id: string;
  name: string;
  status: string;
  description?: string;
  tools: string[];
  model: string;
  sseClients?: number;
  conversationCount?: number;
  hasPendingInterrupt?: boolean;
  lastActivity?: number;
  activeRuns?: number;
  runs?: AgentRun[];
  systemPrompt?: string;
}

interface AgentsStore {
  agents: Agent[];
  loading: boolean;
  error: string | null;
  fetchAgents: () => Promise<void>;
  updateAgent: (id: string, updates: Partial<Agent>) => void;
  startPolling: () => () => void;
  startBackgroundRun: (agentId: string, task: string) => Promise<void>;
  cancelRun: (agentId: string, runId: string) => Promise<void>;
  fetchRuns: (agentId: string) => Promise<AgentRun[]>;
}

export const useAgentsStore = create<AgentsStore>((set, get) => ({
  agents: [],
  loading: false,
  error: null,
  fetchAgents: async () => {
    set({ loading: true });
    try {
      const data = await apiFetchAgents();
      const agents = Array.isArray(data) ? data : (data?.agents ?? []);
      set({ agents, loading: false });
    } catch (err) {
      set({ error: String(err), loading: false });
    }
  },
  updateAgent: (id, updates) =>
    set((state) => ({
      agents: state.agents.map((a) => (a.id === id ? { ...a, ...updates } : a)),
    })),
  startPolling: () => {
    const id = setInterval(() => {
      const store = useAgentsStore.getState();
      store.fetchAgents();
    }, 5000);
    return () => clearInterval(id);
  },
  startBackgroundRun: async (agentId, task) => {
    await apiStartRun(agentId, task);
    await get().fetchAgents();
  },
  cancelRun: async (agentId, runId) => {
    await apiCancelRun(agentId, runId);
    await get().fetchAgents();
  },
  fetchRuns: async (agentId) => {
    const runs = await apiFetchRuns(agentId);
    return runs as AgentRun[];
  },
}));
