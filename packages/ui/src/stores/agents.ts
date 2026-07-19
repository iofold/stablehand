import { create } from 'zustand';
import type { ApiAgent, ApiAgentTurn } from '@ctxmill/shared';
import {
  fetchAgents as apiFetchAgents,
  startBackgroundRun as apiStartRun,
  cancelTurn as apiCancelTurn,
  fetchAgentTurns as apiFetchAgentTurns,
  createAgent as apiCreateAgent,
  updateAgent as apiUpdateAgent,
  deleteAgent as apiDeleteAgent,
  type AgentUpsertInput,
} from '@/lib/api';
import type { HttpToolDefinition } from '@ctxmill/shared';
import { normalizeSandboxSessionStatusCounts } from '@/lib/lifecycle-status';

export type AgentTurn = ApiAgentTurn;

export interface Agent extends ApiAgent {
  httpTools?: HttpToolDefinition[];
  nativeTools?: { allowlist?: string[]; blocklist?: string[] } | null;
  workspaceContent?: { files?: Array<{ src: string; dest: string }> } | null;
  createdAt?: number;
}

interface AgentsStore {
  agents: Agent[];
  loading: boolean;
  error: string | null;
  fetchAgents: () => Promise<void>;
  updateAgentLocal: (id: string, updates: Partial<Agent>) => void;
  createAgent: (data: AgentUpsertInput) => Promise<Agent>;
  updateAgent: (id: string, data: Partial<AgentUpsertInput>) => Promise<Agent>;
  deleteAgent: (id: string) => Promise<void>;
  startPolling: () => () => void;
  startBackgroundRun: (agentId: string, task: string) => Promise<void>;
  cancelTurn: (agentId: string, turnId: string) => Promise<void>;
  fetchTurns: (agentId: string) => Promise<AgentTurn[]>;
}

export const useAgentsStore = create<AgentsStore>((set, get) => ({
  agents: [],
  loading: false,
  error: null,
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
      const agent = await apiCreateAgent(data) as Agent;
      get().fetchAgents();
      return agent;
    } catch (err) {
      console.error('[agents] createAgent failed:', err);
      throw err;
    }
  },
  updateAgent: async (id, data) => {
    try {
      const agent = await apiUpdateAgent(id, data) as Agent;
      get().fetchAgents();
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
  startBackgroundRun: async (agentId, task) => {
    try {
      await apiStartRun(agentId, task);
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
