import { useCallback, useEffect, useState } from 'react';
import {
  Brain,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { AsyncContentState } from '@/components/ui/AsyncContentState';
import {
  fetchSharedKnowledge,
  fetchSharedKnowledgeStats,
  addSharedKnowledge,
  deleteSharedKnowledge,
  searchAllKnowledge,
} from '@/lib/api';
import type { KnowledgeStats } from '@/components/agent/types';

interface KnowledgeItem {
  id: string;
  agentId?: string;
  content: string;
  category?: string;
  source?: string;
  createdAt?: string;
  relevance?: number;
}

type ViewMode = 'shared' | 'all';

export function KnowledgePage() {
  const [items, setItems] = useState<KnowledgeItem[]>([]);
  const [stats, setStats] = useState<KnowledgeStats>({ totalItems: 0, categories: {}, recentItems: 0 });
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>('shared');
  const [showAddModal, setShowAddModal] = useState(false);
  const [addContent, setAddContent] = useState('');
  const [addCategory, setAddCategory] = useState('general');
  const [addSource, setAddSource] = useState('human');
  const [submitting, setSubmitting] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const params = {
        q: searchQuery || undefined,
        category: categoryFilter || undefined,
      };

      if (viewMode === 'shared') {
        const [itemsRes, statsRes] = await Promise.all([
          fetchSharedKnowledge(params) as Promise<{ items: KnowledgeItem[]; total: number }>,
          fetchSharedKnowledgeStats() as Promise<KnowledgeStats>,
        ]);
        setItems(itemsRes.items ?? []);
        setStats(statsRes);
      } else {
        const result = await searchAllKnowledge(params) as { items: KnowledgeItem[]; total: number };
        setItems(result.items ?? []);
        setStats({ totalItems: result.total, categories: {}, recentItems: 0 });
      }
    } catch (err) {
      console.error('[KnowledgePage] Failed to load data:', err);
    } finally {
      setLoading(false);
    }
  }, [searchQuery, categoryFilter, viewMode]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleAdd = async () => {
    if (!addContent.trim()) return;
    setSubmitting(true);
    try {
      await addSharedKnowledge({
        content: addContent.trim(),
        category: addCategory,
        source: addSource,
      });
      setAddContent('');
      setShowAddModal(false);
      await loadData();
    } catch (err) {
      console.error('[KnowledgePage] Failed to add item:', err);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (itemId: string) => {
    try {
      await deleteSharedKnowledge(itemId);
      await loadData();
    } catch (err) {
      console.error('[KnowledgePage] Failed to delete item:', err);
    }
  };

  const categories = Object.entries(stats.categories || {});

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-xl font-semibold text-surface-100">Knowledge Library</h1>
          <p className="text-sm text-surface-400 mt-1">
            Shared knowledge accessible across all agents
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowAddModal(true)}
          className="btn-primary flex items-center gap-2 px-4 py-2 text-sm rounded-lg bg-accent-600 hover:bg-accent-500 text-white transition-colors"
        >
          <Plus className="h-4 w-4" />
          Add Knowledge
        </button>
      </div>

      {/* View mode toggle */}
      <div className="flex items-center gap-1 mb-6 border-b border-surface-700/40">
        <button
          type="button"
          onClick={() => setViewMode('shared')}
          className={cn(
            'px-4 py-2.5 text-sm transition-colors border-b-2 -mb-px',
            viewMode === 'shared'
              ? 'text-accent-400 border-accent-400 font-medium'
              : 'text-surface-400 border-transparent hover:text-surface-300',
          )}
        >
          Shared Knowledge
        </button>
        <button
          type="button"
          onClick={() => setViewMode('all')}
          className={cn(
            'px-4 py-2.5 text-sm transition-colors border-b-2 -mb-px',
            viewMode === 'all'
              ? 'text-accent-400 border-accent-400 font-medium'
              : 'text-surface-400 border-transparent hover:text-surface-300',
          )}
        >
          All Knowledge
        </button>
      </div>

      {/* Stats card */}
      <div className="rounded-lg border border-surface-700/40 bg-surface-900/60 p-5 mb-6">
        <div className="flex items-center gap-6 flex-wrap text-sm text-surface-400">
          <span className="font-medium text-surface-200">{stats.totalItems} items</span>
          {categories.length > 0 && (
            <>
              <span>&middot;</span>
              {categories.map(([cat, count], index) => (
                <span key={cat}>
                  {typeof count === 'number' ? count : 0} {cat}{index < categories.length - 1 ? <span className="mx-2">&middot;</span> : ''}
                </span>
              ))}
            </>
          )}
        </div>
      </div>

      {/* Search & filter */}
      <div className="flex items-center gap-3 flex-wrap mb-6">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-surface-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={viewMode === 'all' ? 'Search across all agents...' : 'Search shared knowledge...'}
            className="input-base pl-9"
          />
        </div>
        {categories.length > 0 && (
          <div className="flex gap-4">
            <button
              type="button"
              onClick={() => setCategoryFilter('')}
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
                onClick={() => setCategoryFilter(categoryFilter === cat ? '' : cat)}
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
        )}
      </div>

      <AsyncContentState
        loading={loading}
        empty={items.length === 0}
        loadingFallback={
          <div className="text-center py-12 text-surface-400 text-sm">Loading knowledge...</div>
        }
        emptyFallback={
          <div className="text-center py-16">
            <Brain className="mx-auto h-10 w-10 text-surface-700 mb-3" />
            <p className="text-surface-400 font-medium">No knowledge items yet</p>
            <p className="text-surface-400 text-sm mt-1">
              {viewMode === 'shared'
                ? 'Add shared knowledge that all agents can access.'
                : 'No knowledge items found across any agents.'}
            </p>
          </div>
        }
      >
        <div className="space-y-0">
          {items.map((item) => (
            <div
              key={item.id}
              className="border-b border-surface-700/50 py-3 last:border-0 group"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <h4 className="text-sm font-medium text-surface-200">
                    {item.source || item.category || 'Knowledge snippet'}
                  </h4>
                  <p className="mt-1 text-sm text-surface-400 line-clamp-2">
                    {item.content}
                  </p>
                  <div className="mt-2 flex items-center gap-3 text-xs text-surface-400">
                    {item.category && <span>{item.category}</span>}
                    {item.agentId && item.agentId !== '__shared__' && (
                      <span className="text-accent-500/70">agent: {item.agentId.slice(0, 8)}</span>
                    )}
                    {item.createdAt && (
                      <span>{new Date(item.createdAt).toLocaleDateString()}</span>
                    )}
                  </div>
                </div>
                {viewMode === 'shared' && (
                  <button
                    type="button"
                    onClick={() => handleDelete(item.id)}
                    className="opacity-0 group-hover:opacity-100 p-1.5 text-surface-400 hover:text-red-400 transition-all"
                    title="Delete knowledge item"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </AsyncContentState>

      {/* Add Knowledge Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-surface-900 border border-surface-700 rounded-xl p-6 w-full max-w-lg mx-4">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-lg font-semibold text-surface-100">Add Shared Knowledge</h2>
              <button
                type="button"
                onClick={() => setShowAddModal(false)}
                className="p-1 text-surface-400 hover:text-surface-300 transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm text-surface-400 mb-1.5">Content</label>
                <textarea
                  value={addContent}
                  onChange={(e) => setAddContent(e.target.value)}
                  placeholder="Enter knowledge content..."
                  rows={4}
                  className="input-base w-full resize-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm text-surface-400 mb-1.5">Category</label>
                  <select
                    value={addCategory}
                    onChange={(e) => setAddCategory(e.target.value)}
                    className="input-base w-full"
                  >
                    <option value="general">General</option>
                    <option value="strategy">Strategy</option>
                    <option value="fact">Fact</option>
                    <option value="preference">Preference</option>
                    <option value="correction">Correction</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm text-surface-400 mb-1.5">Source</label>
                  <select
                    value={addSource}
                    onChange={(e) => setAddSource(e.target.value)}
                    className="input-base w-full"
                  >
                    <option value="human">Human</option>
                    <option value="seed">Seed</option>
                    <option value="reflector">Reflector</option>
                  </select>
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-3 mt-6">
              <button
                type="button"
                onClick={() => setShowAddModal(false)}
                className="px-4 py-2 text-sm text-surface-400 hover:text-surface-200 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleAdd}
                disabled={!addContent.trim() || submitting}
                className="px-4 py-2 text-sm rounded-lg bg-accent-600 hover:bg-accent-500 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting ? 'Adding...' : 'Add'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
