import { useState, useEffect, useMemo, useCallback } from 'react';
import { X, Search, Loader2, ChevronDown, ChevronRight, Shield, Check } from 'lucide-react';
import { fetchCatalogTools, type CatalogTool } from '@/lib/api';
import { cn } from '@/lib/utils';

interface ToolPickerModalProps {
  open: boolean;
  onClose: () => void;
  selectedTools: string[];
  onSelectionChange: (tools: string[]) => void;
  excludedBuiltins: string[];
  onExcludedBuiltinsChange: (excluded: string[]) => void;
}

function sourceBadgeClass(source: string): string {
  switch (source) {
    case 'local':
      return 'bg-accent-500/10 border-accent-500/20 text-accent-400';
    case 'mcp':
      return 'bg-violet-500/10 border-violet-500/20 text-violet-400';
    case 'composio':
      return 'bg-amber-500/10 border-amber-500/20 text-amber-400';
    default:
      return 'bg-surface-700/30 border-surface-600/30 text-surface-400';
  }
}

function locationBadgeClass(location?: string): string {
  switch (location) {
    case 'orchestrator':
      return 'bg-blue-500/10 border-blue-500/20 text-blue-400';
    case 'daemon':
      return 'bg-purple-500/10 border-purple-500/20 text-purple-400';
    case 'sandbox':
    default:
      return 'bg-surface-700/30 border-surface-600/30 text-surface-400';
  }
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
                        <div
                          key={tool.name}
                          className={cn(
                            'border rounded-lg overflow-hidden transition-colors',
                            isExcluded
                              ? 'border-surface-700 bg-surface-800/30 opacity-50'
                              : 'border-surface-700 bg-surface-800/50 hover:border-surface-600'
                          )}
                        >
                          <div className="flex items-start px-4 py-3 gap-3">
                            <button
                              type="button"
                              onClick={() => handleToggleBuiltin(tool.name)}
                              className={cn(
                                'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/50',
                                !isExcluded
                                  ? 'border-accent-500 bg-accent-500 text-surface-950'
                                  : 'border-surface-600 bg-surface-900 hover:border-surface-500'
                              )}
                              aria-label={isExcluded ? `Include ${tool.name}` : `Exclude ${tool.name}`}
                            >
                              {!isExcluded && <Check className="h-3.5 w-3.5" />}
                            </button>

                            <div className="flex-1 min-w-0">
                              <div className="flex items-center justify-between gap-2">
                                <div className="flex items-center gap-2 min-w-0 flex-wrap">
                                  <span className={cn('text-sm font-semibold text-surface-100 font-mono truncate', isExcluded && 'line-through')}>
                                    {tool.name}
                                  </span>
                                  <span className="inline-flex rounded-md border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider shrink-0 bg-sky-500/10 border-sky-500/20 text-sky-400">
                                    builtin
                                  </span>
                                  {isExcluded && (
                                    <span className="inline-flex rounded-md border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider shrink-0 bg-red-500/10 border-red-500/20 text-red-400">
                                      excluded
                                    </span>
                                  )}
                                  {tool.location && (
                                    <span className={cn('inline-flex rounded-md border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider shrink-0', locationBadgeClass(tool.location))}>
                                      {tool.location}
                                    </span>
                                  )}
                                  <span
                                    className={cn(
                                      'inline-flex rounded-md border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider shrink-0',
                                      sourceBadgeClass(tool.source)
                                    )}
                                  >
                                    {tool.source}
                                  </span>
                                  {tool.requiresApproval && (
                                    <span className="inline-flex items-center gap-1 rounded-md border border-orange-500/20 bg-orange-500/10 px-1.5 py-0.5 text-[10px] font-medium text-orange-400 shrink-0">
                                      <Shield className="h-3 w-3" />
                                      approval
                                    </span>
                                  )}
                                </div>
                                <button
                                  type="button"
                                  onClick={() => setExpandedTool(isExpanded ? null : tool.name)}
                                  className="p-1 text-surface-400 hover:text-surface-200 transition-colors rounded hover:bg-surface-700/50"
                                  aria-label={isExpanded ? 'Collapse details' : 'Expand details'}
                                >
                                  {isExpanded ? (
                                    <ChevronDown className="h-4 w-4" />
                                  ) : (
                                    <ChevronRight className="h-4 w-4" />
                                  )}
                                </button>
                              </div>
                              
                              {tool.description && (
                                <p className="mt-1 text-xs text-surface-400 pr-8 cursor-pointer" onClick={() => handleToggleBuiltin(tool.name)}>
                                  {tool.description}
                                </p>
                              )}
                            </div>
                          </div>

                          {isExpanded && (
                            <div className="border-t border-surface-700/50 bg-surface-900/50 px-4 py-3 ml-8 space-y-3">
                              {tool.inputSchema && (
                                <div>
                                  <p className="text-[10px] font-medium text-surface-500 uppercase tracking-wider mb-1.5">
                                    Input Schema
                                  </p>
                                  <pre className="overflow-x-auto rounded-md bg-surface-950 border border-surface-800 p-2.5 text-[11px] text-surface-300 font-mono leading-relaxed max-h-40">
                                    {JSON.stringify(tool.inputSchema, null, 2)}
                                  </pre>
                                </div>
                              )}
                              {tool.secrets && tool.secrets.length > 0 && (
                                <div>
                                  <p className="text-[10px] font-medium text-surface-500 uppercase tracking-wider mb-1.5">
                                    Secrets
                                  </p>
                                  <div className="flex flex-wrap gap-1.5">
                                    {tool.secrets.map((s) => (
                                      <span
                                        key={s}
                                        className="inline-flex rounded border border-surface-700 bg-surface-800 px-1.5 py-0.5 text-[10px] font-mono text-surface-300"
                                      >
                                        {s}
                                      </span>
                                    ))}
                                  </div>
                                </div>
                              )}
                              {!tool.inputSchema && (!tool.secrets || tool.secrets.length === 0) && (
                                <p className="text-xs text-surface-500 italic">No additional details available.</p>
                              )}
                            </div>
                          )}
                        </div>
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
                        <div
                          key={tool.name}
                          className={cn(
                            'border rounded-lg overflow-hidden transition-colors',
                            isSelected
                              ? 'border-accent-500/50 bg-accent-500/5'
                              : 'border-surface-700 bg-surface-800/50 hover:border-surface-600'
                          )}
                        >
                          <div className="flex items-start px-4 py-3 gap-3">
                            <button
                              type="button"
                              onClick={() => handleToggleTool(tool.name)}
                              className={cn(
                                'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/50',
                                isSelected
                                  ? 'border-accent-500 bg-accent-500 text-surface-950'
                                  : 'border-surface-600 bg-surface-900 hover:border-surface-500'
                              )}
                              aria-label={`Select ${tool.name}`}
                            >
                              {isSelected && <Check className="h-3.5 w-3.5" />}
                            </button>

                            <div className="flex-1 min-w-0">
                              <div className="flex items-center justify-between gap-2">
                                <div className="flex items-center gap-2 min-w-0 flex-wrap">
                                  <span className="text-sm font-semibold text-surface-100 font-mono truncate">
                                    {tool.name}
                                  </span>
                                  {tool.location && (
                                    <span className={cn('inline-flex rounded-md border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider shrink-0', locationBadgeClass(tool.location))}>
                                      {tool.location}
                                    </span>
                                  )}
                                  <span
                                    className={cn(
                                      'inline-flex rounded-md border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider shrink-0',
                                      sourceBadgeClass(tool.source)
                                    )}
                                  >
                                    {tool.source}
                                  </span>
                                  {tool.requiresApproval && (
                                    <span className="inline-flex items-center gap-1 rounded-md border border-orange-500/20 bg-orange-500/10 px-1.5 py-0.5 text-[10px] font-medium text-orange-400 shrink-0">
                                      <Shield className="h-3 w-3" />
                                      approval
                                    </span>
                                  )}
                                </div>
                                <button
                                  type="button"
                                  onClick={() => setExpandedTool(isExpanded ? null : tool.name)}
                                  className="p-1 text-surface-400 hover:text-surface-200 transition-colors rounded hover:bg-surface-700/50"
                                  aria-label={isExpanded ? 'Collapse details' : 'Expand details'}
                                >
                                  {isExpanded ? (
                                    <ChevronDown className="h-4 w-4" />
                                  ) : (
                                    <ChevronRight className="h-4 w-4" />
                                  )}
                                </button>
                              </div>
                              
                              {tool.description && (
                                <p className="mt-1 text-xs text-surface-400 pr-8 cursor-pointer" onClick={() => handleToggleTool(tool.name)}>
                                  {tool.description}
                                </p>
                              )}
                            </div>
                          </div>

                          {isExpanded && (
                            <div className="border-t border-surface-700/50 bg-surface-900/50 px-4 py-3 ml-8 space-y-3">
                              {tool.inputSchema && (
                                <div>
                                  <p className="text-[10px] font-medium text-surface-500 uppercase tracking-wider mb-1.5">
                                    Input Schema
                                  </p>
                                  <pre className="overflow-x-auto rounded-md bg-surface-950 border border-surface-800 p-2.5 text-[11px] text-surface-300 font-mono leading-relaxed max-h-40">
                                    {JSON.stringify(tool.inputSchema, null, 2)}
                                  </pre>
                                </div>
                              )}
                              {tool.secrets && tool.secrets.length > 0 && (
                                <div>
                                  <p className="text-[10px] font-medium text-surface-500 uppercase tracking-wider mb-1.5">
                                    Secrets
                                  </p>
                                  <div className="flex flex-wrap gap-1.5">
                                    {tool.secrets.map((s) => (
                                      <span
                                        key={s}
                                        className="inline-flex rounded border border-surface-700 bg-surface-800 px-1.5 py-0.5 text-[10px] font-mono text-surface-300"
                                      >
                                        {s}
                                      </span>
                                    ))}
                                  </div>
                                </div>
                              )}
                              {!tool.inputSchema && (!tool.secrets || tool.secrets.length === 0) && (
                                <p className="text-xs text-surface-500 italic">No additional details available.</p>
                              )}
                            </div>
                          )}
                        </div>
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
