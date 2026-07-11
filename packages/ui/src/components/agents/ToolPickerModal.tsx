import { useState, useEffect, useMemo, useCallback, type ReactNode } from 'react';
import { X, Search, Loader2, ChevronDown, ChevronRight, Check } from 'lucide-react';
import { fetchCatalogTools, type CatalogTool } from '@/lib/api';
import { cn } from '@/lib/utils';
import { ToolBadges, ToolDetailsPanel } from '@/components/tools/ToolPresentation';

interface ToolPickerModalProps {
  open: boolean;
  onClose: () => void;
  selectedTools: string[];
  onSelectionChange: (tools: string[]) => void;
  excludedBuiltins: string[];
  onExcludedBuiltinsChange: (excluded: string[]) => void;
}

interface ToolPickerCardProps {
  tool: CatalogTool;
  checked: boolean;
  onToggle: () => void;
  expanded: boolean;
  onToggleExpanded: () => void;
  toggleLabel: string;
  extraBadges?: ReactNode;
  dimmed?: boolean;
  highlightChecked?: boolean;
}

function ToolPickerCard({
  tool,
  checked,
  onToggle,
  expanded,
  onToggleExpanded,
  toggleLabel,
  extraBadges,
  dimmed = false,
  highlightChecked = true,
}: ToolPickerCardProps) {
  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border transition-colors',
        dimmed
          ? 'border-surface-700 bg-surface-800/30 opacity-50'
          : checked && highlightChecked
            ? 'border-accent-500/50 bg-accent-500/5'
            : 'border-surface-700 bg-surface-800/50 hover:border-surface-600',
      )}
    >
      <div className="flex items-start gap-3 px-4 py-3">
        <button
          type="button"
          onClick={onToggle}
          className={cn(
            'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/50',
            checked
              ? 'border-accent-500 bg-accent-500 text-surface-950'
              : 'border-surface-600 bg-surface-900 hover:border-surface-500',
          )}
          aria-label={toggleLabel}
        >
          {checked ? <Check className="h-3.5 w-3.5" /> : null}
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span
                className={cn(
                  'truncate font-mono text-sm font-semibold text-surface-100',
                  dimmed && 'line-through',
                )}
              >
                {tool.name}
              </span>
              <ToolBadges tool={tool} compact extraBadges={extraBadges} />
            </div>
            <button
              type="button"
              onClick={onToggleExpanded}
              className="rounded p-1 text-surface-400 transition-colors hover:bg-surface-700/50 hover:text-surface-200"
              aria-label={expanded ? 'Collapse details' : 'Expand details'}
            >
              {expanded ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
            </button>
          </div>

          {tool.description ? (
            <p className="mt-1 cursor-pointer pr-8 text-xs text-surface-400" onClick={onToggle}>
              {tool.description}
            </p>
          ) : null}
        </div>
      </div>

      {expanded ? (
        <ToolDetailsPanel
          tool={tool}
          compact
          className="ml-8 border-t border-surface-700/50 bg-surface-900/50 px-4 py-3"
        />
      ) : null}
    </div>
  );
}

export function ToolPickerModal({
  open,
  onClose,
  selectedTools,
  onSelectionChange,
  excludedBuiltins,
  onExcludedBuiltinsChange,
}: ToolPickerModalProps) {
  const [tools, setTools] = useState<CatalogTool[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [expandedTool, setExpandedTool] = useState<string | null>(null);
  const [draftSelection, setDraftSelection] = useState<Set<string>>(new Set());
  const [draftExcludedBuiltins, setDraftExcludedBuiltins] = useState<Set<string>>(new Set());

  const loadTools = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchCatalogTools();
      setTools(Array.isArray(data) ? data : []);
    } catch (err) {
      console.debug('[ToolPickerModal] Load failed:', err);
      setError('Failed to load tools');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      loadTools();
      setDraftSelection(new Set(selectedTools));
      setDraftExcludedBuiltins(new Set(excludedBuiltins));
      setSearch('');
      setExpandedTool(null);
    }
  }, [open, loadTools, selectedTools, excludedBuiltins]);

  const { builtinTools, selectableTools } = useMemo(() => {
    let result = tools;
    if (search.trim()) {
      const q = search.toLowerCase();
      result = tools.filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          (t.description?.toLowerCase().includes(q) ?? false),
      );
    }
    result = result.sort((a, b) => {
      if (a.source !== b.source) return a.source.localeCompare(b.source);
      return a.name.localeCompare(b.name);
    });

    return {
      builtinTools: result.filter(t => t.builtin),
      selectableTools: result.filter(t => !t.builtin)
    };
  }, [tools, search]);

  const handleToggleTool = (toolName: string) => {
    setDraftSelection((prev) => {
      const next = new Set(prev);
      if (next.has(toolName)) {
        next.delete(toolName);
      } else {
        next.add(toolName);
      }
      return next;
    });
  };

  const handleToggleBuiltin = (toolName: string) => {
    setDraftExcludedBuiltins((prev) => {
      const next = new Set(prev);
      if (next.has(toolName)) {
        next.delete(toolName);
      } else {
        next.add(toolName);
      }
      return next;
    });
  };

  const handleSelectAll = () => {
    setDraftSelection((prev) => {
      const next = new Set(prev);
      selectableTools.forEach((t) => next.add(t.name));
      return next;
    });
  };

  const handleDeselectAll = () => {
    setDraftSelection((prev) => {
      const next = new Set(prev);
      selectableTools.forEach((t) => next.delete(t.name));
      return next;
    });
  };

  const handleApply = () => {
    onSelectionChange(Array.from(draftSelection));
    onExcludedBuiltinsChange(Array.from(draftExcludedBuiltins));
    onClose();
  };

  if (!open) return null;

  const totalSelected = draftSelection.size + builtinTools.length - draftExcludedBuiltins.size;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-surface-950/80 animate-fade-in"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="relative w-full max-w-3xl mx-4 rounded-lg border border-surface-700 bg-surface-850 animate-slide-up flex flex-col max-h-[85vh]"
        role="dialog"
        aria-modal="true"
        aria-label="Select Tools"
      >
        <div className="flex items-center justify-between border-b border-surface-700/40 px-6 py-4 shrink-0">
          <div>
            <h2 className="text-lg font-semibold text-surface-100">
              Select Tools
            </h2>
            <p className="text-sm text-surface-400 mt-0.5">
              {totalSelected} tool{totalSelected !== 1 ? 's' : ''} selected
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-surface-400 transition-colors hover:bg-surface-800 hover:text-surface-200"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="px-6 py-4 border-b border-surface-700/40 shrink-0 space-y-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-surface-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search tools by name or description..."
              className="w-full rounded-lg border border-surface-700 bg-surface-900 pl-9 pr-4 py-2 text-sm text-surface-200 placeholder:text-surface-500 focus:outline-none focus:ring-1 focus:ring-accent-500/50"
            />
          </div>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={handleSelectAll}
                className="text-xs font-medium text-accent-400 hover:text-accent-300 transition-colors"
              >
                Select All
              </button>
              <span className="text-surface-700">|</span>
              <button
                type="button"
                onClick={handleDeselectAll}
                className="text-xs font-medium text-surface-400 hover:text-surface-300 transition-colors"
              >
                Deselect All
              </button>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-6 bg-surface-900/30">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 text-accent-400 animate-spin" />
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <p className="text-sm text-red-400">{error}</p>
            </div>
          ) : builtinTools.length === 0 && selectableTools.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <p className="text-sm text-surface-400">
                {search ? 'No tools match your search.' : 'No tools available.'}
              </p>
            </div>
          ) : (
            <div className="space-y-6">
              {builtinTools.length > 0 && (
                <div className="space-y-3">
                  <h3 className="text-sm font-semibold text-surface-200">Platform Tools (enabled by default)</h3>
                  <div className="space-y-3">
                    {builtinTools.map((tool) => {
                      const isExpanded = expandedTool === tool.name;
                      const isExcluded = draftExcludedBuiltins.has(tool.name);

                      return (
                        <ToolPickerCard
                          key={tool.name}
                          tool={tool}
                          checked={!isExcluded}
                          onToggle={() => handleToggleBuiltin(tool.name)}
                          expanded={isExpanded}
                          onToggleExpanded={() => setExpandedTool(isExpanded ? null : tool.name)}
                          toggleLabel={isExcluded ? `Include ${tool.name}` : `Exclude ${tool.name}`}
                          dimmed={isExcluded}
                          highlightChecked={false}
                          extraBadges={isExcluded ? (
                            <span className="inline-flex shrink-0 rounded-md border border-red-500/20 bg-red-500/10 px-2 py-0.5 text-[10px] font-medium uppercase text-red-400">
                              excluded
                            </span>
                          ) : null}
                        />
                      );
                    })}
                  </div>
                </div>
              )}

              {selectableTools.length > 0 && (
                <div className="space-y-3">
                  {builtinTools.length > 0 && (
                    <h3 className="text-sm font-semibold text-surface-200">Available Tools</h3>
                  )}
                  <div className="space-y-3">
                    {selectableTools.map((tool) => {
                      const isExpanded = expandedTool === tool.name;
                      const isSelected = draftSelection.has(tool.name);

                      return (
                        <ToolPickerCard
                          key={tool.name}
                          tool={tool}
                          checked={isSelected}
                          onToggle={() => handleToggleTool(tool.name)}
                          expanded={isExpanded}
                          onToggleExpanded={() => setExpandedTool(isExpanded ? null : tool.name)}
                          toggleLabel={`Select ${tool.name}`}
                        />
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-4 border-t border-surface-700/40 px-6 py-4 shrink-0 bg-surface-850 rounded-b-lg">
          <button
            type="button"
            onClick={onClose}
            className="text-sm font-medium text-surface-400 hover:text-surface-200 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleApply}
            className="btn-primary"
          >
            Apply {totalSelected} Tool{totalSelected !== 1 ? 's' : ''}
          </button>
        </div>
      </div>
    </div>
  );
}
