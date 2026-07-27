import { create } from 'zustand';
import {
  fetchAgent as apiFetchAgent,
  fetchAgents as apiFetchAgents,
  startBackgroundRun as apiStartRun,
  cancelTurn as apiCancelTurn,
  fetchAgentTurns as apiFetchAgentTurns,
  createAgent as apiCreateAgent,
  updateAgent as apiUpdateAgent,
  deleteAgent as apiDeleteAgent,
} from '@/lib/api';
import type {
  Agent,
  AgentCreateInput,
  AgentPatchInput,
  Turn,
} from '@ctxmill/contracts';
import { normalizeSandboxSessionStatusCounts } from '@/lib/lifecycle-status';

export type AgentTurn = Turn;
export type { Agent } from '@ctxmill/contracts';

interface AgentsStore {
  agents: Agent[];
  loading: boolean;
  error: string | null;
  fetchAgent: (id: string) => Promise<Agent>;
  fetchAgents: () => Promise<void>;
  updateAgentLocal: (id: string, updates: Partial<Agent>) => void;
  createAgent: (data: AgentCreateInput) => Promise<Agent>;
  updateAgent: (id: string, data: AgentPatchInput) => Promise<Agent>;
  deleteAgent: (id: string) => Promise<void>;
  startPolling: () => () => void;
  startBackgroundRun: (agentId: string, task: string, tags?: Record<string, string>) => Promise<void>;
  cancelTurn: (agentId: string, turnId: string) => Promise<void>;
  fetchTurns: (agentId: string) => Promise<AgentTurn[]>;
}

export const useAgentsStore = create<AgentsStore>((set, get) => ({
  agents: [],
  loading: false,
  error: null,
  fetchAgent: async (id) => {
    try {
      const agent = await apiFetchAgent(id);
      set((state) => ({
        agents: state.agents.some((current) => current.id === id)
          ? state.agents.map((current) => current.id === id ? agent : current)
          : [...state.agents, agent],
        error: null,
      }));
      return agent;
    } catch (err) {
      set({ error: String(err) });
      throw err;
    }
  },
  fetchAgents: async () => {
    const isInitial = get().agents.length === 0;
    if (isInitial) set({ loading: true });
    try {
      const data = await apiFetchAgents();
      const agents = data.map((agent) => ({
        ...agent,
        sandboxSessionsByStatus: normalizeSandboxSessionStatusCounts(agent.sandboxSessionsByStatus) ?? undefined,
      }));
      set({ agents, loading: false, error: null });
    } catch (err) {
      set({ error: String(err), loading: false });
    }
  },
  updateAgentLocal: (id, updates) =>
    set((state) => ({
      agents: state.agents.map((a) => (a.id === id ? { ...a, ...updates } : a)),
    })),
  createAgent: async (data) => {
    try {
      const agent = await apiCreateAgent(data);
      get().fetchAgents();
      return agent;
    } catch (err) {
      console.error('[agents] createAgent failed:', err);
      throw err;
    }
  },
  updateAgent: async (id, data) => {
    try {
      const agent = await apiUpdateAgent(id, data);
      set((state) => ({
        agents: state.agents.map((current) => current.id === id ? agent : current),
      }));
      return agent;
    } catch (err) {
      console.error('[agents] updateAgent failed:', err);
      throw err;
    }
  },
  deleteAgent: async (id) => {
    try {
      await apiDeleteAgent(id);
      get().fetchAgents();
    } catch (err) {
      console.error('[agents] deleteAgent failed:', err);
      throw err;
    }
  },
  startPolling: () => {
    const id = setInterval(() => {
      const store = useAgentsStore.getState();
      store.fetchAgents();
    }, 5000);
    return () => clearInterval(id);
  },
  startBackgroundRun: async (agentId, task, tags) => {
    try {
      await apiStartRun(agentId, task, tags);
      await get().fetchAgents();
    } catch (err) {
      console.error('[agents] startBackgroundRun failed:', err);
      throw err;
    }
  },
  cancelTurn: async (agentId, turnId) => {
    try {
      await apiCancelTurn(agentId, turnId);
      await get().fetchAgents();
    } catch (err) {
      console.error('[agents] cancelTurn failed:', err);
      throw err;
    }
  },
  fetchTurns: async (agentId) => {
    try {
      return await apiFetchAgentTurns(agentId);
    } catch (err) {
      console.error('[agents] fetchTurns failed:', err);
      throw err;
    }
  },
}));
