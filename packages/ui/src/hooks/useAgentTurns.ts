import { useMemo } from 'react';
import type { AgentTurn } from '@/stores/agents';
import { normalizeTurnStatus } from '@/lib/lifecycle-status';

export interface UseAgentTurnsReturn {
  filteredTurns: AgentTurn[];
}

export function useAgentTurns(allTurns: AgentTurn[], turnFilter: string): UseAgentTurnsReturn {
  const filteredTurns = useMemo(() => {
    if (turnFilter === 'all') return allTurns;

    // Conversations containing at least one turn whose cost is not fully
    // known yet — the target of "costs incomplete" badges elsewhere in the UI.
    if (turnFilter === 'incomplete-cost') {
      const matchingConversationIds = new Set(
        allTurns
          .filter((turn) => {
            const coverage = turn.usage?.cost.coverage;
            return coverage === 'pending' || coverage === 'partial' || coverage === 'unpriced';
          })
          .map((turn) => turn.conversationId ?? 'unknown'),
      );
      return allTurns.filter((turn) =>
        matchingConversationIds.has(turn.conversationId ?? 'unknown'));
    }

    const latestTurnByConversation = new Map<string, AgentTurn>();
    for (const turn of allTurns) {
      const conversationId = turn.conversationId ?? 'unknown';
      const existing = latestTurnByConversation.get(conversationId);
      if (!existing || turn.startedAt > existing.startedAt) {
        latestTurnByConversation.set(conversationId, turn);
      }
    }
    
    const matchingConversationIds = new Set<string>();
    for (const [conversationId, latestTurn] of latestTurnByConversation.entries()) {
      if (normalizeTurnStatus(latestTurn.status) === turnFilter) {
        matchingConversationIds.add(conversationId);
      }
    }
    
    return allTurns.filter((turn) => matchingConversationIds.has(turn.conversationId ?? 'unknown'));
  }, [allTurns, turnFilter]);

  return { filteredTurns };
}
