import { create } from 'zustand';
import type { ApiAgentSession, ApiSessionStatusCounts } from '@ctxmill/shared';
import {
  fetchAgents as apiFetchAgents,
  startBackgroundRun as apiStartRun,
  cancelRun as apiCancelRun,
  fetchSessions as apiFetchSessions,
  createAgent as apiCreateAgent,
  updateAgent as apiUpdateAgent,
  deleteAgent as apiDeleteAgent,
  type HttpToolDefinition,
} from '@/lib/api';
import { normalizeSessionStatusCounts } from '@/lib/session-status';

export type AgentSession = ApiAgentSession & { sandboxSessionId?: string };

export interface Agent {
  id: string;
  name: string;
  status: string;
  description?: string;
  tools: string[];
  httpTools?: HttpToolDefinition[];
  nativeTools?: { allowlist?: string[]; blocklist?: string[] } | null;
  workspaceContent?: { files?: Array<{ src: string; dest: string }> } | null;
  harness: string;
  harnessConfig: Record<string, unknown>;
  sseClients?: number;
  conversationCount?: number;
  sessionsByStatus?: ApiSessionStatusCounts;
  hasPendingInterrupt?: boolean;
  lastActivity?: number;
  totalSessions?: number;
  systemPrompt?: string;
  createdAt?: number;

  knowledgeItems?: number;
  workspaceDir?: string | null;
  metadata?: Record<string, unknown> | null;
  manifest?: Record<string, unknown> | null;
  version?: number;
}

interface AgentsStore {
  agents: Agent[];
  loading: boolean;
  error: string | null;
  fetchAgents: () => Promise<void>;
  updateAgentLocal: (id: string, updates: Partial<Agent>) => void;
  createAgent: (data: {
    name: string;
    harness: string;
    harnessConfig: Record<string, unknown>;
    systemPrompt: string;
    tools: string[];
    description?: string;
    metadata?: Record<string, unknown>;
    httpTools?: HttpToolDefinition[];
  }) => Promise<Agent>;
  updateAgent: (id: string, data: Partial<{
    name: string;
    harness: string;
    harnessConfig: Record<string, unknown>;
    systemPrompt: string;
    tools: string[];
    description?: string;
    metadata?: Record<string, unknown>;
    httpTools?: HttpToolDefinition[];
  }>) => Promise<Agent>;
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
      const rawAgents: Agent[] = Array.isArray(data) ? data : ((data as Record<string, unknown>)?.agents as Agent[] ?? []);
      const agents = rawAgents.map((agent) => ({
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
