import { useState, useEffect, useCallback, type KeyboardEvent } from 'react';
import { X, Wrench, Check } from 'lucide-react';
import { useAgentsStore, type Agent } from '@/stores/agents';
import { fetchCatalogTools, type CatalogTool } from '@/lib/api';
import { cn } from '@/lib/utils';
import { ToolPickerModal } from './ToolPickerModal';

interface AgentFormModalProps {
  open: boolean;
  onClose: () => void;
  agent?: Agent | null;
}

const HARNESS_OPTIONS = [
  'langgraph',
  'claude-agents',
  'pi-agent',
] as const;

const HARNESS_CONFIG_TEMPLATES: Record<string, object> = {
  langgraph: { provider: 'openai', model: 'gpt-5.4-mini', apiKeyRef: '$secret:OPENAI_API_KEY' },
  'claude-agents': { model: 'claude-sonnet-4-6', apiKeyRef: '$secret:ANTHROPIC_API_KEY' },
  'pi-agent': { provider: 'openai', model: 'gpt-5.4-mini', apiKeyRef: '$secret:OPENAI_API_KEY' },
};

function TagList({
  items,
  onRemove,
  color = 'brand',
}: {
  items: string[];
  onRemove: (index: number) => void;
  color?: 'brand' | 'accent';
}) {
  if (items.length === 0) return null;
  const pillBg =
    color === 'brand'
      ? 'bg-accent-600/15 text-accent-300 border-accent-500/20'
      : 'bg-accent-600/15 text-accent-300 border-accent-500/20';
  const hoverX =
    color === 'brand' ? 'hover:text-accent-100' : 'hover:text-accent-100';

  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {items.map((item, i) => (
        <span
          key={item}
          className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs ${pillBg}`}
        >
          {item}
          <button
            type="button"
            onClick={() => onRemove(i)}
            className={`ml-0.5 ${hoverX} transition-colors`}
            aria-label={`Remove ${item}`}
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
    </div>
  );
}

export function AgentFormModal({ open, onClose, agent }: AgentFormModalProps) {
  const { createAgent, updateAgent } = useAgentsStore();

  const [name, setName] = useState('');
  const [harness, setHarness] = useState<string>(HARNESS_OPTIONS[0]);
  const [harnessConfigText, setHarnessConfigText] = useState(
    JSON.stringify(HARNESS_CONFIG_TEMPLATES[HARNESS_OPTIONS[0]], null, 2)
  );
  const [description, setDescription] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [tools, setTools] = useState<string[]>([]);
  const [excludedBuiltins, setExcludedBuiltins] = useState<string[]>([]);
  const [builtinTools, setBuiltinTools] = useState<CatalogTool[]>([]);
  const [toolPickerOpen, setToolPickerOpen] = useState(false);
  const [nativeToolsMode, setNativeToolsMode] = useState<'none' | 'allowlist' | 'blocklist'>('none');
  const [nativeToolsList, setNativeToolsList] = useState<string[]>([]);
  const [nativeToolInput, setNativeToolInput] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const isEditing = Boolean(agent);

  useEffect(() => {
    if (!open) return;
    let mounted = true;
    fetchCatalogTools().then((data) => {
      if (mounted && Array.isArray(data)) {
        setBuiltinTools(data.filter(t => t.builtin));
      }
    }).catch(err => {
      console.debug('[AgentFormModal] Failed to load tools:', err);
    });
    return () => { mounted = false; };
  }, [open]);

  // Populate form when editing
  useEffect(() => {
    if (!open) return;

    if (agent) {
      setName(agent.name);
      setHarness(agent.harness ?? HARNESS_OPTIONS[0]);
      setHarnessConfigText(formatJsonLike(agent.harnessConfig));
      setDescription(agent.description ?? '');
      setSystemPrompt(agent.systemPrompt ?? '');
      setTools(agent.tools ?? []);
      
      const metaExcluded = agent.metadata?.excludeBuiltinTools;
      setExcludedBuiltins(Array.isArray(metaExcluded) ? metaExcluded.filter((v: unknown): v is string => typeof v === 'string') : []);

      if (agent.nativeTools?.allowlist?.length) {
        setNativeToolsMode('allowlist');
        setNativeToolsList(agent.nativeTools.allowlist);
      } else if (agent.nativeTools?.blocklist?.length) {
        setNativeToolsMode('blocklist');
        setNativeToolsList(agent.nativeTools.blocklist);
      } else {
        setNativeToolsMode('none');
        setNativeToolsList([]);
      }
    } else {
      setName('');
      setHarness(HARNESS_OPTIONS[0]);
      setHarnessConfigText(JSON.stringify(HARNESS_CONFIG_TEMPLATES[HARNESS_OPTIONS[0]], null, 2));
      setDescription('');
      setSystemPrompt('');
      setTools([]);
      setExcludedBuiltins([]);
      setNativeToolsMode('none');
      setNativeToolsList([]);
    }
    setNativeToolInput('');
    setErrors({});
  }, [agent, open]);

  const commitTags = useCallback(
    (
      raw: string,
      current: string[],
      setCurrent: (v: string[]) => void,
      setInput: (v: string) => void,
    ) => {
      const newTags = raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && !current.includes(s));
      if (newTags.length > 0) {
        setCurrent([...current, ...newTags]);
      }
      setInput('');
    },
    [],
  );

  const handleTagKeyDown = (
    e: KeyboardEvent<HTMLInputElement>,
    raw: string,
    current: string[],
    setCurrent: (v: string[]) => void,
    setInput: (v: string) => void,
  ) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      commitTags(raw, current, setCurrent, setInput);
    }
  };

  const handleTagBlur = (
    raw: string,
    current: string[],
    setCurrent: (v: string[]) => void,
    setInput: (v: string) => void,
  ) => {
    commitTags(raw, current, setCurrent, setInput);
  };

  const validate = (): boolean => {
    const errs: Record<string, string> = {};
    if (!name.trim()) errs.name = 'Name is required';
    if (!harness) errs.harness = 'Harness is required';
    if (!systemPrompt.trim()) errs.systemPrompt = 'System prompt is required';
    if (!harnessConfigText.trim()) {
      errs.harnessConfig = 'Harness config is required';
    } else {
      try {
        JSON.parse(harnessConfigText);
      } catch {
        errs.harnessConfig = 'Harness config must be valid JSON';
      }
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleSave = async () => {
    if (!validate()) return;
    setSaving(true);
    try {
      const parsedHarnessConfig = JSON.parse(harnessConfigText) as Record<string, unknown>;
      const nativeTools = nativeToolsMode === 'none' ? null
        : nativeToolsMode === 'allowlist' ? { allowlist: nativeToolsList }
        : { blocklist: nativeToolsList };
      const metadata = buildMetadata(agent?.metadata, nativeTools);
      if (excludedBuiltins.length > 0) {
        metadata.excludeBuiltinTools = excludedBuiltins;
      } else {
        delete metadata.excludeBuiltinTools;
      }
      const payload = {
        name: name.trim(),
        harness,
        systemPrompt: systemPrompt.trim(),
        tools,
        description: description.trim() || undefined,
        harnessConfig: parsedHarnessConfig,
        metadata,
      };
      if (isEditing && agent) {
        await updateAgent(agent.id, payload);
      } else {
        await createAgent(payload);
      }
      onClose();
    } catch {
      setErrors({ _form: 'Failed to save agent. Please try again.' });
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-surface-950/80 animate-fade-in">
      <button
        type="button"
        aria-label="Close agent form modal"
        className="absolute inset-0"
        onClick={onClose}
      />
      <div
        className="relative z-10 w-full max-w-lg mx-4 rounded-lg border border-surface-700 bg-surface-850 animate-slide-up"
        role="dialog"
        aria-modal="true"
        aria-label={isEditing ? 'Edit Agent' : 'New Agent'}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-surface-700/40 px-6 py-4">
          <h2 className="text-lg font-semibold text-surface-100">
            {isEditing ? 'Edit Agent' : 'New Agent'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-surface-400 transition-colors hover:bg-surface-800 hover:text-surface-200"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="max-h-[70vh] overflow-y-auto px-6 py-5 space-y-5">
          {errors._form && (
            <p className="text-sm text-red-400">{errors._form}</p>
          )}

          {/* Name */}
          <div>
            <label htmlFor="agent-name" className="text-label">
              Name
            </label>
            <input
              id="agent-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Agent"
              className={cn('input-base mt-1.5', errors.name && 'border-red-500/60')}
            />
            {errors.name && (
              <p className="mt-1 text-xs text-red-400">{errors.name}</p>
            )}
          </div>

          {/* Harness */}
          <div>
            <label htmlFor="agent-harness" className="text-label">
              Harness
            </label>
            <select
              id="agent-harness"
              value={harness}
              onChange={(e) => {
                const newHarness = e.target.value;
                setHarness(newHarness);
                
                // Auto-populate template if empty or matches a previous template
                const currentIsTemplate = Object.values(HARNESS_CONFIG_TEMPLATES).some(
                  (t) => JSON.stringify(t, null, 2) === harnessConfigText.trim()
                );
                if (!harnessConfigText.trim() || currentIsTemplate) {
                  setHarnessConfigText(JSON.stringify(HARNESS_CONFIG_TEMPLATES[newHarness] || {}, null, 2));
                }
              }}
              className={cn('input-base mt-1.5', errors.harness && 'border-red-500/60')}
            >
              {HARNESS_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
            {errors.harness && (
              <p className="mt-1 text-xs text-red-400">{errors.harness}</p>
            )}
          </div>

          <div>
            <label htmlFor="agent-harness-config" className="text-label">
              Harness Configuration (JSON)
            </label>
            <textarea
              id="agent-harness-config"
              value={harnessConfigText}
              onChange={(e) => setHarnessConfigText(e.target.value)}
              placeholder={'{\n  "provider": "openai",\n  "model": "gpt-5.4-mini"\n}'}
              rows={5}
              className={cn('input-base mt-1.5 resize-y font-mono', errors.harnessConfig && 'border-red-500/60')}
            />
            {errors.harnessConfig && (
              <p className="mt-1 text-xs text-red-400">{errors.harnessConfig}</p>
            )}
          </div>

          {/* Description */}
          <div>
            <label htmlFor="agent-description" className="text-label">
              Description
            </label>
            <textarea
              id="agent-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description..."
              rows={2}
              className="input-base mt-1.5 resize-none"
            />
          </div>

          {/* System Prompt */}
          <div>
            <label htmlFor="agent-system-prompt" className="text-label">
              System Prompt
            </label>
            <textarea
              id="agent-system-prompt"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="You are a helpful assistant..."
              rows={4}
              className={cn('input-base mt-1.5 resize-none font-mono', errors.systemPrompt && 'border-red-500/60')}
            />
            {errors.systemPrompt && (
              <p className="mt-1 text-xs text-red-400">{errors.systemPrompt}</p>
            )}
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <div className="text-label">
                Tools
              </div>
              <button
                type="button"
                onClick={() => setToolPickerOpen(true)}
                className="flex items-center gap-1.5 text-xs font-medium text-accent-400 hover:text-accent-300 transition-colors bg-accent-500/10 hover:bg-accent-500/20 px-2.5 py-1 rounded-md border border-accent-500/20"
              >
                <Wrench className="h-3.5 w-3.5" />
                Select Tools
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {tools.filter(t => !builtinTools.some(b => b.name === t)).map((tool) => (
                <span
                  key={tool}
                  className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs bg-accent-600/15 text-accent-300 border-accent-500/20"
                >
                  {tool}
                  <button
                    type="button"
                    onClick={() => setTools(tools.filter(t => t !== tool))}
                    className="ml-0.5 hover:text-accent-100 transition-colors"
                    aria-label={`Remove ${tool}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
              {builtinTools.map((tool) => {
                const isExcluded = excludedBuiltins.includes(tool.name);
                const isDeclared = tools.includes(tool.name);
                return (
                  <button
                    key={tool.name}
                    type="button"
                    onClick={() => {
                      setExcludedBuiltins((prev) =>
                        isExcluded
                          ? prev.filter((t) => t !== tool.name)
                          : [...prev, tool.name]
                      );
                    }}
                    className={cn(
                      'inline-flex items-center gap-1.5 px-2 py-0.5 text-xs rounded-md border transition-colors',
                      isExcluded
                        ? 'bg-surface-800/50 text-surface-500 border-surface-700/50 line-through opacity-60'
                        : 'bg-sky-500/10 text-sky-400 border-sky-500/20 hover:bg-sky-500/20'
                    )}
                    title={isExcluded ? 'Click to re-enable' : `Builtin${isDeclared ? ' + declared in manifest' : ''} — click to disable`}
                  >
                    {!isExcluded && <Check className="h-3 w-3" />}
                    {tool.name}
                    <span className="text-[9px] opacity-60 uppercase">builtin</span>
                  </button>
                );
              })}
              {tools.length === 0 && builtinTools.length === 0 && (
                <p className="text-xs text-surface-500">No tools selected</p>
              )}
            </div>
          </div>

          {/* Native SDK Tools */}
          <div>
            <div className="text-label">Native SDK Tools</div>
            <div className="flex gap-2 mt-1.5 mb-2">
              {(['none', 'allowlist', 'blocklist'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => { setNativeToolsMode(mode); if (mode === 'none') setNativeToolsList([]); }}
                  className={`px-2 py-1 text-xs rounded ${
                    nativeToolsMode === mode
                      ? 'bg-accent/20 text-accent border border-accent/30'
                      : 'bg-surface-800 text-surface-400 border border-surface-700 hover:border-surface-600'
                  }`}
                >
                  {mode === 'none' ? 'Default (all)' : mode === 'allowlist' ? 'Allowlist' : 'Blocklist'}
                </button>
              ))}
            </div>
            {nativeToolsMode !== 'none' && (
              <>
                <input
                  type="text"
                  value={nativeToolInput}
                  onChange={(e) => setNativeToolInput(e.target.value)}
                  onKeyDown={(e) =>
                    handleTagKeyDown(e, nativeToolInput, nativeToolsList, setNativeToolsList, setNativeToolInput)
                  }
                  onBlur={() =>
                    handleTagBlur(nativeToolInput, nativeToolsList, setNativeToolsList, setNativeToolInput)
                  }
                  placeholder={`SDK tool names to ${nativeToolsMode}...`}
                  className="input-base"
                />
                <TagList
                  items={nativeToolsList}
                  onRemove={(i) => setNativeToolsList(nativeToolsList.filter((_, idx) => idx !== i))}
                  color={nativeToolsMode === 'allowlist' ? 'brand' : 'accent'}
                />
              </>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-6 border-t border-surface-700/40 px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            className="text-sm font-medium text-surface-400 hover:text-surface-200 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="btn-primary"
          >
            {saving ? 'Saving...' : isEditing ? 'Save Changes' : 'Create Agent'}
          </button>
        </div>
      </div>

      <ToolPickerModal
        open={toolPickerOpen}
        onClose={() => setToolPickerOpen(false)}
        selectedTools={tools}
        onSelectionChange={setTools}
        excludedBuiltins={excludedBuiltins}
        onExcludedBuiltinsChange={setExcludedBuiltins}
      />
    </div>
  );
}

function buildMetadata(
  metadata: Record<string, unknown> | null | undefined,
  nativeTools: { allowlist?: string[]; blocklist?: string[] } | null,
): Record<string, unknown> {
  const preserved = extractNonManagedMetadata(metadata);
  preserved.nativeTools = nativeTools;
  return preserved;
}

function extractNonManagedMetadata(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!metadata) return {};
  const next = { ...metadata };
  delete next.skills;
  delete next.nativeTools;
  delete next.excludeBuiltinTools;
  return next;
}

function formatJsonLike(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '';
  }
}
