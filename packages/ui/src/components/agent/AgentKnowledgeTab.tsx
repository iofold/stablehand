import {
  Brain,
  Search,
  ExternalLink,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';
import type { KnowledgeItem, KnowledgeStats } from './types';

export interface AgentKnowledgeTabProps {
  items: KnowledgeItem[];
  stats: KnowledgeStats;
  loading: boolean;
  search: string;
  onSearchChange: (v: string) => void;
  categoryFilter: string;
  onCategoryFilterChange: (v: string) => void;
}

export function AgentKnowledgeTab({
  items,
  stats,
  loading,
  search,
  onSearchChange,
  categoryFilter,
  onCategoryFilterChange,
}: AgentKnowledgeTabProps) {
  const categories = Object.entries(stats.categories || {});

  return (
    <div data-testid="knowledge-explorer" className="space-y-6">
      {/* Stats card */}
      <div className="rounded-lg border border-surface-700/40 bg-surface-900/60 p-5">
        <div className="flex items-center gap-6 flex-wrap text-sm text-surface-400">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-surface-200">{stats.totalItems} items</span>
            {categories.length > 0 && (
              <>
                <span>&middot;</span>
                {categories.map(([cat, count], index) => (
                  <span key={cat}>
                    {count as number} {cat}{index < categories.length - 1 ? <span className="mx-2">&middot;</span> : ''}
                  </span>
                ))}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Search & filter */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-surface-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search knowledge..."
            className="input-base pl-9"
          />
        </div>
        {/* Category filter pills */}
        <div className="flex gap-4">
          <button
            type="button"
            onClick={() => onCategoryFilterChange('')}
            className={cn(
              'text-sm transition-colors pb-1',
              !categoryFilter
                ? 'text-accent-400'
                : 'text-surface-400 hover:text-surface-300',
            )}
          >
            All
          </button>
          {categories.map(([cat]) => (
            <button
              key={cat}
              type="button"
              onClick={() => onCategoryFilterChange(categoryFilter === cat ? '' : cat)}
              className={cn(
                'text-sm transition-colors pb-1',
                categoryFilter === cat
                  ? 'text-accent-400'
                  : 'text-surface-400 hover:text-surface-300',
              )}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      {/* Shared knowledge link */}
      <div className="rounded-lg border border-surface-700/40 bg-surface-900/40 p-4 flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-surface-300">Shared Knowledge</p>
          <p className="text-xs text-surface-400 mt-0.5">Knowledge shared across all agents is also available to this agent at runtime.</p>
        </div>
        <Link
          to="/knowledge"
          className="flex items-center gap-1.5 text-sm text-accent-400 hover:text-accent-300 transition-colors"
        >
          View Library
          <ExternalLink className="h-3.5 w-3.5" />
        </Link>
      </div>

      {/* Knowledge items list */}
      {loading ? (
        <div className="text-center py-12 text-surface-400 text-sm">Loading knowledge...</div>
      ) : items.length === 0 ? (
        <div className="text-center py-16">
          <Brain className="mx-auto h-10 w-10 text-surface-700 mb-3" />
          <p className="text-surface-400 font-medium">No knowledge items yet</p>
          <p className="text-surface-400 text-sm mt-1">This agent has not learned anything yet.</p>
        </div>
      ) : (
        <div className="space-y-0">
          {items.map((item) => (
            <div
              key={item.id}
              className="border-b border-surface-700/50 py-3 last:border-0"
            >
              <h4 className="text-sm font-medium text-surface-200">
                {item.source || item.category || 'Knowledge snippet'}
              </h4>
              <p className="mt-1 text-sm text-surface-400 line-clamp-2">
                {item.content}
              </p>
              <div className="mt-2 flex items-center gap-3 text-xs text-surface-400">
                {item.category && <span>{item.category}</span>}
                {item.createdAt && (
                  <span>{new Date(item.createdAt).toLocaleDateString()}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
