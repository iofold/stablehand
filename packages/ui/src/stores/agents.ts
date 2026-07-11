import { create } from 'zustand';
import type { ApiAgent, ApiAgentSession } from '@ctxmill/shared';
import {
  fetchAgents as apiFetchAgents,
  startBackgroundRun as apiStartRun,
  cancelRun as apiCancelRun,
  fetchSessions as apiFetchSessions,
  createAgent as apiCreateAgent,
  updateAgent as apiUpdateAgent,
  deleteAgent as apiDeleteAgent,
  type AgentUpsertInput,
} from '@/lib/api';
import type { HttpToolDefinition } from '@ctxmill/shared';
import { normalizeSessionStatusCounts } from '@/lib/session-status';

export type AgentSession = ApiAgentSession;

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
  cancelRun: (agentId: string, sessionId: string) => Promise<void>;
  fetchSessions: (agentId: string) => Promise<AgentSession[]>;
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
        sessionsByStatus: normalizeSessionStatusCounts(agent.sessionsByStatus) ?? undefined,
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
  cancelRun: async (agentId, sessionId) => {
    try {
      await apiCancelRun(agentId, sessionId);
      await get().fetchAgents();
    } catch (err) {
      console.error('[agents] cancelRun failed:', err);
      throw err;
    }
  },
  fetchSessions: async (agentId) => {
    try {
      const data = await apiFetchSessions(agentId);
      const sessions = (data as { sessions?: AgentSession[] }).sessions;
      return Array.isArray(sessions) ? sessions : [];
    } catch (err) {
      console.error('[agents] fetchSessions failed:', err);
      throw err;
    }
  },
}));
