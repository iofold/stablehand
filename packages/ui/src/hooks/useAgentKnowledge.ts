import { useEffect, useState } from 'react';
import { fetchKnowledge, fetchKnowledgeStats } from '@/lib/api';
import type { KnowledgeItem, KnowledgeStats, TabId } from '@/components/agent/types';

export interface UseAgentKnowledgeReturn {
  knowledgeItems: KnowledgeItem[];
  knowledgeStats: KnowledgeStats;
  knowledgeLoading: boolean;
  knowledgeSearch: string;
  setKnowledgeSearch: (v: string) => void;
  knowledgeCategoryFilter: string;
  setKnowledgeCategoryFilter: (v: string) => void;
  error: string | null;
}

export function useAgentKnowledge(id: string | undefined, activeTab: TabId): UseAgentKnowledgeReturn {
  const [knowledgeItems, setKnowledgeItems] = useState<KnowledgeItem[]>([]);
  const [knowledgeStats, setKnowledgeStats] = useState<KnowledgeStats>({ totalItems: 0, categories: {} });
  const [knowledgeLoading, setKnowledgeLoading] = useState(false);
  const [knowledgeSearch, setKnowledgeSearch] = useState('');
  const [knowledgeCategoryFilter, setKnowledgeCategoryFilter] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (activeTab !== 'knowledge' || !id) return;
    let mounted = true;
    setKnowledgeLoading(true);

    const params: { q?: string; category?: string } = {};
    if (knowledgeSearch.trim()) params.q = knowledgeSearch.trim();
    if (knowledgeCategoryFilter) params.category = knowledgeCategoryFilter;

    setError(null);

    Promise.all([
      fetchKnowledge(id, params),
      fetchKnowledgeStats(id),
    ])
      .then(([items, stats]) => {
        if (!mounted) return;
        const itemsArr: KnowledgeItem[] = Array.isArray(items) ? items : ((items as Record<string, unknown>)?.items as KnowledgeItem[] ?? []);
        setKnowledgeItems(itemsArr);
        setKnowledgeStats(stats && typeof stats === 'object' ? stats as KnowledgeStats : { totalItems: 0, categories: {} });
      })
      .catch((err) => {
        if (!mounted) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (mounted) setKnowledgeLoading(false);
      });

    return () => { mounted = false; };
  }, [activeTab, id, knowledgeSearch, knowledgeCategoryFilter]);

  return {
    knowledgeItems,
    knowledgeStats,
    knowledgeLoading,
    knowledgeSearch,
    setKnowledgeSearch,
    knowledgeCategoryFilter,
    setKnowledgeCategoryFilter,
    error,
  };
}
