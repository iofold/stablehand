import { useEffect, useState, useCallback } from 'react';
import type { ConversationSummary } from '@stablehand/contracts';
import { useAgentsStore } from '@/stores/agents';
import type { AgentTurn } from '@/stores/agents';
import type { Agent } from '@/stores/agents';
import type { TabId } from '@/components/agent/types';
import { fetchConversationSummaries } from '@/lib/api';

const RECENT_CONVERSATION_LIMIT = 12;

export interface UseAgentDetailReturn {
  agent: Agent | undefined;
  loading: boolean;
  agents: Agent[];
  error: string | null;

  allTurns: AgentTurn[];
  turnsLoading: boolean;
  loadTurns: () => Promise<void>;

  recentConversations: ConversationSummary[];
  conversationsLoading: boolean;
  conversationsError: string | null;
  loadConversations: () => Promise<void>;
}

export function useAgentDetail(id: string | undefined, activeTab: TabId): UseAgentDetailReturn {
  const agents = useAgentsStore((s) => s.agents);
  const storeFetchAgent = useAgentsStore((s) => s.fetchAgent);
  const storeFetchTurns = useAgentsStore((s) => s.fetchTurns);
  const agent = agents.find((candidate) => candidate.id === id);

  const [agentLoading, setAgentLoading] = useState(() => Boolean(id && !agent));
  const [agentError, setAgentError] = useState<string | null>(null);
  const [allTurns, setAllTurns] = useState<AgentTurn[]>([]);
  const [turnsLoading, setTurnsLoading] = useState(false);
  const [recentConversations, setRecentConversations] = useState<ConversationSummary[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(false);
  const [conversationsError, setConversationsError] = useState<string | null>(null);

  // Error state
  const [turnsError, setTurnsError] = useState<string | null>(null);

  useEffect(() => {
    if (!id || agent) {
      setAgentLoading(false);
      setAgentError(null);
      return;
    }

    let cancelled = false;
    setAgentLoading(true);
    setAgentError(null);
    void storeFetchAgent(id)
      .catch((err: unknown) => {
        if (!cancelled) {
          setAgentError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setAgentLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [agent, id, storeFetchAgent]);

  const loadTurns = useCallback(async () => {
    if (!id) return;
    setTurnsLoading(true);
    setTurnsError(null);
    try {
      const turns = await storeFetchTurns(id);
      setAllTurns(turns);
    } catch (err) {
      setTurnsError(err instanceof Error ? err.message : String(err));
    } finally {
      setTurnsLoading(false);
    }
  }, [id, storeFetchTurns]);

  const loadConversations = useCallback(async () => {
    if (!id) return;
    setConversationsLoading(true);
    setConversationsError(null);
    try {
      const { conversations } = await fetchConversationSummaries(id);
      setRecentConversations(conversations.slice(0, RECENT_CONVERSATION_LIMIT));
    } catch (err) {
      setConversationsError(err instanceof Error ? err.message : String(err));
    } finally {
      setConversationsLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (activeTab === 'overview') {
      void loadConversations();
    } else if (activeTab === 'turns') {
      void loadTurns();
    }
  }, [activeTab, loadConversations, loadTurns]);

  useEffect(() => {
    if (
      activeTab !== 'turns'
      || !id
      || !allTurns.some((turn) => turn.usage?.cost.coverage === 'pending')
    ) {
      return;
    }
    let cancelled = false;
    const timer = setInterval(() => {
      void storeFetchTurns(id)
        .then((turns) => {
          if (!cancelled) setAllTurns(turns);
        })
        .catch((err: unknown) => {
          if (!cancelled) {
            setTurnsError(err instanceof Error ? err.message : String(err));
          }
        });
    }, 5_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [activeTab, allTurns, id, storeFetchTurns]);

  return {
    agent,
    loading: agentLoading,
    agents,
    error: agent ? turnsError : agentError,
    allTurns,
    turnsLoading,
    loadTurns,
    recentConversations,
    conversationsLoading,
    conversationsError,
    loadConversations,
  };
}
