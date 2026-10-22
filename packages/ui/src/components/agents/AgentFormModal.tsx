import { useState, useEffect, useCallback, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { X, Wrench, Check } from 'lucide-react';
import { useAgentsStore, type Agent } from '@/stores/agents';
import { fetchCatalogTools, type CatalogTool } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  parseRunSpendCapInput,
  readRunSpendCap,
  writeRunSpendCap,
} from '@/lib/run-spend-cap';
import { ToolPickerModal } from './ToolPickerModal';
import {
  draftToMcpServer,
  mcpServerToDraft,
  McpServersEditor,
  type McpServerDraft,
} from './McpServersEditor';
import {
  STABLEHAND_HARNESS_NAMES,
  HARNESS_CONFIG_SCHEMAS,
  type AgentCreateInput,
  type AgentPatchInput,
  type BuiltinToolPolicy,
  type NativeToolPolicy,
} from '@stablehand/contracts';
import {
  manifestToAgentPatchInput,
  parseManifestString,
  serializeManifestYAML,
  validateManifest,
} from '@stablehand/manifest';
import { harnessLabel } from '@/lib/harness';

interface AgentFormModalProps {
  open: boolean;
  onClose: () => void;
  agent?: Agent | null;
}

const DEFAULT_HARNESS = 'langgraph';

const HARNESS_CONFIG_TEMPLATES: Record<string, object> = {
  langgraph: { provider: 'openai', model: 'gpt-5.4-mini', apiKeyRef: '$secret:OPENAI_API_KEY' },
  'claude-agents': { model: 'claude-sonnet-4-6', apiKeyRef: '$secret:ANTHROPIC_API_KEY' },
  'pi-agent': { provider: 'openai', model: 'gpt-5.4-mini', apiKeyRef: '$secret:OPENAI_API_KEY' },
};

function TagList({
  items,
  onRemove,
}: {
  items: string[];
  onRemove: (index: number) => void;
}) {
  if (items.length === 0) return null;
  const pillBg = 'bg-accent-600/15 text-accent-300 border-accent-500/20';
  const hoverX = 'hover:text-accent-100';

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
  const [harness, setHarness] = useState<string>(DEFAULT_HARNESS);
  const [harnessConfigText, setHarnessConfigText] = useState(
    JSON.stringify(HARNESS_CONFIG_TEMPLATES[DEFAULT_HARNESS], null, 2)
  );
  const [description, setDescription] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [tools, setTools] = useState<string[]>([]);
  const [mcpDrafts, setMcpDrafts] = useState<McpServerDraft[]>([]);
  const [builtinToolPolicy, setBuiltinToolPolicy] = useState<BuiltinToolPolicy>({ policy: 'all' });
  const [builtinTools, setBuiltinTools] = useState<CatalogTool[]>([]);
  const [toolPickerOpen, setToolPickerOpen] = useState(false);
  const [nativeToolPolicyMode, setNativeToolPolicyMode] = useState<NativeToolPolicy['policy']>('all');
  const [nativeToolsList, setNativeToolsList] = useState<string[]>([]);
  const [nativeToolInput, setNativeToolInput] = useState('');
  const [manifestYamlText, setManifestYamlText] = useState('');
  // Budget dimensions: per tag key, the bucket values budget policies may
  // group by (agent metadata.budgetDimensions). Values are comma-separated
  // in the editor.
  const [budgetDims, setBudgetDims] = useState<Array<{ key: string; values: string }>>([]);
  // Per-run spend cap; stored in the harness config as limits.maxCostUsd.
  const [spendCapText, setSpendCapText] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const isEditing = Boolean(agent);
  const isManifestEditor = Boolean(agent?.manifest);

  useEffect(() => {
    if (!open || isManifestEditor) return;
    let mounted = true;
    fetchCatalogTools().then((data) => {
      if (mounted && Array.isArray(data)) {
        setBuiltinTools(data.filter(t => t.builtin));
      }
    }).catch(err => {
      console.debug('[AgentFormModal] Failed to load tools:', err);
    });
    return () => { mounted = false; };
  }, [isManifestEditor, open]);

  // Populate form when editing
  useEffect(() => {
    if (!open) return;

    if (agent) {
      setName(agent.name);
      setHarness(agent.harness ?? DEFAULT_HARNESS);
      const configText = formatJsonLike(agent.harnessConfig);
      setHarnessConfigText(configText);
      setSpendCapText(readRunSpendCap(configText) ?? '');
      setDescription(agent.description ?? '');
      setSystemPrompt(agent.systemPrompt ?? '');
      setTools(agent.tools ?? []);
      setMcpDrafts((agent.mcpServers ?? []).map(mcpServerToDraft));
      
      setBuiltinToolPolicy(agent.builtinToolPolicy ?? { policy: 'all' });
      const nativePolicy = agent.nativeToolPolicy ?? { policy: 'all' };
      setNativeToolPolicyMode(nativePolicy.policy);
      setNativeToolsList(
        nativePolicy.policy === 'allow' || nativePolicy.policy === 'deny'
          ? nativePolicy.names
          : [],
      );
      setManifestYamlText(formatManifestYaml(agent.manifest));
      const dims = (agent.metadata as Record<string, unknown> | null)?.budgetDimensions;
      setBudgetDims(
        dims && typeof dims === 'object'
          ? Object.entries(dims as Record<string, unknown>).map(([key, values]) => ({
              key,
              values: Array.isArray(values) ? values.join(', ') : String(values ?? ''),
            }))
          : [],
      );
    } else {
      setName('');
      setHarness(DEFAULT_HARNESS);
      setHarnessConfigText(JSON.stringify(HARNESS_CONFIG_TEMPLATES[DEFAULT_HARNESS], null, 2));
      setDescription('');
      setSystemPrompt('');
      setTools([]);
      setMcpDrafts([]);
      setBuiltinToolPolicy({ policy: 'all' });
      setNativeToolPolicyMode('all');
      setNativeToolsList([]);
      setManifestYamlText('');
      setBudgetDims([]);
      setSpendCapText('');
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
    const canonicalHarness = STABLEHAND_HARNESS_NAMES.find((name) => name === harness);
    if (!canonicalHarness) errs.harness = 'Select a supported harness';
    if (!systemPrompt.trim()) errs.systemPrompt = 'System prompt is required';
    if (
      (nativeToolPolicyMode === 'allow' || nativeToolPolicyMode === 'deny')
      && nativeToolsList.length === 0
    ) {
      errs.nativeToolPolicy = 'Add at least one native tool name for this policy';
    }
    if (!harnessConfigText.trim()) {
      errs.harnessConfig = 'Harness config is required';
    } else {
      try {
        const parsedHarnessConfig = JSON.parse(harnessConfigText) as unknown;
        if (canonicalHarness) {
          const result = HARNESS_CONFIG_SCHEMAS[canonicalHarness].safeParse(parsedHarnessConfig);
          if (!result.success) {
            errs.harnessConfig = result.error.issues.map((issue) => {
              const path = ['harnessConfig', ...issue.path.map(String)].join('.');
              return `${path}: ${issue.message}`;
            }).join('; ');
          }
        }
      } catch {
        errs.harnessConfig = 'Harness config must be valid JSON';
      }
    }
    for (const draft of mcpDrafts) {
      const converted = draftToMcpServer(draft);
      if (converted.error) {
        errs.mcpServers = converted.error;
        break;
      }
    }
    if (parseRunSpendCapInput(spendCapText) === null) {
      errs.spendCap = 'Enter a dollar amount above zero, or leave empty for no cap';
    }
    for (const row of budgetDims) {
      const key = row.key.trim();
      const values = row.values.split(',').map((v) => v.trim()).filter(Boolean);
      if ((key && values.length === 0) || (!key && values.length > 0)) {
        errs.budgetDimensions = 'Each budget dimension needs a tag key and at least one value';
        break;
      }
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  /**
   * Only propose a metadata patch when the budget dimensions actually
   * changed — the modal must not rewrite metadata it does not manage.
   */
  const buildMetadataPayload = (): { changed: boolean; metadata: Record<string, unknown> | null } => {
    const budgetDimensions: Record<string, string[]> = {};
    for (const row of budgetDims) {
      const key = row.key.trim();
      const values = row.values.split(',').map((v) => v.trim()).filter(Boolean);
      if (key && values.length > 0) budgetDimensions[key] = values;
    }
    const nextDims = Object.keys(budgetDimensions).length > 0 ? budgetDimensions : null;
    const existingMetadata = (agent?.metadata as Record<string, unknown> | null) ?? null;
    const existingDims = existingMetadata?.budgetDimensions ?? null;
    if (JSON.stringify(existingDims) === JSON.stringify(nextDims)) {
      return { changed: false, metadata: null };
    }
    const publicMetadata = { ...(existingMetadata ?? {}) };
    delete publicMetadata.budgetDimensions;
    if (nextDims) {
      return { changed: true, metadata: { ...publicMetadata, budgetDimensions: nextDims } };
    }
    return {
      changed: true,
      metadata: Object.keys(publicMetadata).length > 0 ? publicMetadata : null,
    };
  };

  const handleSave = async () => {
    if (isManifestEditor && agent) {
      setSaving(true);
      setErrors({});
      try {
        const manifest = validateManifest(parseManifestString(manifestYamlText));
        const payload = manifestToAgentPatchInput(manifest, {
          ...(manifest.spec.instructions.startsWith('file:')
            ? { resolvedInstructions: agent.systemPrompt }
            : {}),
        });
        await updateAgent(agent.id, payload);
        onClose();
      } catch (error) {
        setErrors({ _form: errorMessage(error) });
      } finally {
        setSaving(false);
      }
      return;
    }

    if (!validate()) return;
    setSaving(true);
    try {
      const parsedHarnessConfig = JSON.parse(harnessConfigText) as Record<string, unknown>;
      const nativeToolPolicy: NativeToolPolicy =
        nativeToolPolicyMode === 'allow' || nativeToolPolicyMode === 'deny'
          ? { policy: nativeToolPolicyMode, names: nativeToolsList }
          : { policy: nativeToolPolicyMode };
      const commonInput = {
        name: name.trim(),
        harness,
        systemPrompt,
        tools,
        harnessConfig: parsedHarnessConfig,
        nativeToolPolicy,
        builtinToolPolicy,
      };
      const metadataPatch = buildMetadataPayload();
      const mcpServers = mcpDrafts.flatMap((draft) => {
        const converted = draftToMcpServer(draft);
        return converted.server ? [converted.server] : [];
      });
      if (isEditing && agent) {
        const payload: AgentPatchInput = {
          ...commonInput,
          description: description.length > 0 ? description : null,
          ...(metadataPatch.changed ? { metadata: metadataPatch.metadata } : {}),
          mcpServers: mcpServers.length > 0 ? mcpServers : null,
        };
        await updateAgent(agent.id, payload);
      } else {
        const payload: AgentCreateInput = {
          ...commonInput,
          ...(mcpServers.length > 0 ? { mcpServers } : {}),
          ...(description.length > 0 ? { description } : {}),
          ...(metadataPatch.changed && metadataPatch.metadata
            ? { metadata: metadataPatch.metadata }
            : {}),
        };
        await createAgent(payload);
      }
      onClose();
    } catch (error) {
      setErrors({ _form: errorMessage(error) });
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-surface-950/80 animate-fade-in">
      <button
        type="button"
        aria-label="Close agent form modal"
        className="absolute inset-0"
        onClick={onClose}
      />
      <div
        className="relative z-10 mx-4 flex h-[min(92vh,56rem)] w-full max-w-6xl flex-col overflow-hidden rounded-lg border border-surface-700 bg-surface-850 animate-slide-up"
        role="dialog"
        aria-modal="true"
        aria-label={isEditing ? 'Edit Agent' : 'New Agent'}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-surface-700/40 px-6 py-4">
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
        <div
          className={cn(
            'min-h-0 flex-1 px-6 py-5',
            isManifestEditor ? 'flex flex-col overflow-hidden' : 'space-y-5 overflow-y-auto',
          )}
        >
          {errors._form && (
            <p role="alert" className="mb-3 text-sm text-red-400">{errors._form}</p>
          )}

          {isManifestEditor ? (
            <section className="flex min-h-0 flex-1 flex-col" aria-label="Canonical agent manifest editor">
              <div className="mb-3 flex shrink-0 items-start justify-between gap-6">
                <div>
                  <label htmlFor="agent-manifest-yaml" className="text-label">
                    Agent manifest YAML
                  </label>
                  <p className="mt-1 text-xs text-surface-400">
                    This canonical manifest is the complete source for the agent definition.
                  </p>
                </div>
                <span className="shrink-0 rounded border border-accent-500/20 bg-accent-500/10 px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-accent-300">
                  stablehand.io/v1
                </span>
              </div>
              <textarea
                id="agent-manifest-yaml"
                aria-label="Agent manifest YAML"
                value={manifestYamlText}
                onChange={(event) => setManifestYamlText(event.target.value)}
                spellCheck={false}
                className="input-base min-h-[32rem] flex-1 resize-none whitespace-pre font-mono text-sm leading-6"
              />
            </section>
          ) : (
            <>
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
                  const template = JSON.stringify(HARNESS_CONFIG_TEMPLATES[newHarness] || {}, null, 2);
                  // Keep the spend cap the user set across a template swap.
                  const cap = parseRunSpendCapInput(spendCapText);
                  setHarnessConfigText(
                    (typeof cap === 'number' ? writeRunSpendCap(template, cap) : null) ?? template,
                  );
                }
              }}
              className={cn('input-base mt-1.5', errors.harness && 'border-red-500/60')}
            >
              {STABLEHAND_HARNESS_NAMES.map((option) => (
                <option key={option} value={option}>
                  {harnessLabel(option)}
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
              onBlur={() => {
                const cap = readRunSpendCap(harnessConfigText);
                if (cap !== null) setSpendCapText(cap);
              }}
              placeholder={'{\n  "provider": "openai",\n  "model": "gpt-5.4-mini"\n}'}
              rows={5}
              className={cn('input-base mt-1.5 resize-y font-mono', errors.harnessConfig && 'border-red-500/60')}
            />
            {errors.harnessConfig && (
              <p className="mt-1 text-xs text-red-400">{errors.harnessConfig}</p>
            )}
          </div>

          {/* Per-run spend cap (harnessConfig.limits.maxCostUsd) */}
          <div>
            <label htmlFor="agent-spend-cap" className="text-label">
              Spend cap per run (USD)
            </label>
            <p className="mt-1 text-xs text-surface-500">
              A run stops when its model spend reaches this amount, even mid-task. Needs the
              model gateway; leave empty for no per-run cap.
            </p>
            <input
              id="agent-spend-cap"
              data-testid="agent-spend-cap"
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              value={spendCapText}
              placeholder="No cap"
              disabled={readRunSpendCap(harnessConfigText) === null}
              title={readRunSpendCap(harnessConfigText) === null
                ? 'Fix the harness configuration JSON to set a spend cap'
                : undefined}
              onChange={(e) => {
                const text = e.target.value;
                setSpendCapText(text);
                const cap = parseRunSpendCapInput(text);
                if (cap === null) return;
                const nextConfig = writeRunSpendCap(harnessConfigText, cap);
                if (nextConfig !== null) setHarnessConfigText(nextConfig);
              }}
              className={cn('input-base mt-1.5 w-40 font-mono', errors.spendCap && 'border-red-500/60')}
            />
            {errors.spendCap && (
              <p className="mt-1 text-xs text-red-400">{errors.spendCap}</p>
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

          {/* Budget dimensions */}
          <div>
            <div className="text-label">Budget dimensions</div>
            <p className="mt-1 text-xs text-surface-500">
              Tag values budget policies can group this agent's runs by
              (e.g. key <span className="font-mono">team</span>, values{' '}
              <span className="font-mono">growth, platform</span>). Runs tagged with other
              values are rejected when a grouped policy matches.
            </p>
            <div className="mt-2 space-y-2">
              {budgetDims.map((row, index) => (
                <div key={index} className="flex items-center gap-2">
                  <input
                    type="text"
                    value={row.key}
                    onChange={(e) => setBudgetDims((prev) =>
                      prev.map((r, i) => (i === index ? { ...r, key: e.target.value } : r)))}
                    placeholder="tag key"
                    className="input-base w-36 font-mono text-xs"
                  />
                  <input
                    type="text"
                    value={row.values}
                    onChange={(e) => setBudgetDims((prev) =>
                      prev.map((r, i) => (i === index ? { ...r, values: e.target.value } : r)))}
                    placeholder="allowed values, comma-separated"
                    className="input-base flex-1 font-mono text-xs"
                  />
                  <button
                    type="button"
                    aria-label="Remove budget dimension"
                    onClick={() => setBudgetDims((prev) => prev.filter((_, i) => i !== index))}
                    className="rounded-md px-2 py-1 text-xs text-surface-400 hover:bg-surface-700/60 hover:text-surface-200"
                  >
                    Remove
                  </button>
                </div>
              ))}
              <button
                type="button"
                data-testid="add-budget-dimension"
                onClick={() => setBudgetDims((prev) => [...prev, { key: '', values: '' }])}
                className="rounded-md border border-surface-600/50 px-2.5 py-1 text-xs text-surface-300 hover:bg-surface-700/60"
              >
                Add dimension
              </button>
            </div>
            {errors.budgetDimensions && (
              <p className="mt-1 text-xs text-red-400">{errors.budgetDimensions}</p>
            )}
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
                const excludedBuiltins = excludedBuiltinNames(builtinToolPolicy, builtinTools);
                const isExcluded = excludedBuiltins.includes(tool.name);
                const isDeclared = tools.includes(tool.name);
                return (
                  <button
                    key={tool.name}
                    type="button"
                    onClick={() => {
                      const nextExcluded = isExcluded
                        ? excludedBuiltins.filter((name) => name !== tool.name)
                        : [...excludedBuiltins, tool.name];
                      setBuiltinToolPolicy(policyFromExcludedBuiltinNames(
                        nextExcluded,
                        builtinTools,
                        builtinToolPolicy,
                      ));
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

          <McpServersEditor value={mcpDrafts} onChange={setMcpDrafts} error={errors.mcpServers} />

          {/* Native SDK Tools */}
          <div>
            <div className="text-label">Native SDK Tools</div>
            <div className="flex gap-2 mt-1.5 mb-2">
              {(['all', 'none', 'allow', 'deny'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => {
                    setNativeToolPolicyMode(mode);
                    if (mode === 'all' || mode === 'none') setNativeToolsList([]);
                  }}
                  className={`px-2 py-1 text-xs rounded ${
                    nativeToolPolicyMode === mode
                      ? 'bg-accent/20 text-accent border border-accent/30'
                      : 'bg-surface-800 text-surface-400 border border-surface-700 hover:border-surface-600'
                  }`}
                >
                  {mode === 'all' ? 'All' : mode === 'none' ? 'None' : mode === 'allow' ? 'Allow only' : 'Deny listed'}
                </button>
              ))}
            </div>
            {(nativeToolPolicyMode === 'allow' || nativeToolPolicyMode === 'deny') && (
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
                  placeholder={`SDK tool names to ${nativeToolPolicyMode}...`}
                  className="input-base"
                />
                {errors.nativeToolPolicy && (
                  <p className="mt-1 text-xs text-red-400">{errors.nativeToolPolicy}</p>
                )}
                <TagList
                  items={nativeToolsList}
                  onRemove={(i) => setNativeToolsList(nativeToolsList.filter((_, idx) => idx !== i))}
                />
              </>
            )}
          </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex shrink-0 items-center justify-end gap-6 border-t border-surface-700/40 px-6 py-4">
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

      {!isManifestEditor && (
        <ToolPickerModal
          open={toolPickerOpen}
          onClose={() => setToolPickerOpen(false)}
          selectedTools={tools}
          onSelectionChange={setTools}
          excludedBuiltins={excludedBuiltinNames(builtinToolPolicy, builtinTools)}
          onExcludedBuiltinsChange={(names) => {
            setBuiltinToolPolicy(policyFromExcludedBuiltinNames(
              names,
              builtinTools,
              builtinToolPolicy,
            ));
          }}
        />
      )}
    </div>,
    document.body,
  );
}

function excludedBuiltinNames(
  policy: BuiltinToolPolicy,
  tools: readonly CatalogTool[],
): string[] {
  const names = tools.map((tool) => tool.name);
  switch (policy.policy) {
    case 'all':
      return [];
    case 'none':
      return names;
    case 'allow': {
      const allowed = new Set(policy.names);
      return names.filter((name) => !allowed.has(name));
    }
    case 'deny':
      return policy.names.filter((name) => names.includes(name));
  }
}

function policyFromExcludedBuiltinNames(
  excludedNames: readonly string[],
  tools: readonly CatalogTool[],
  currentPolicy: BuiltinToolPolicy,
): BuiltinToolPolicy {
  const catalogNames = tools.map((tool) => tool.name);
  const catalogNameSet = new Set(catalogNames);
  const excludedSet = new Set(excludedNames);
  const excludedCatalogNames = catalogNames.filter((name) => excludedSet.has(name));

  if (currentPolicy.policy === 'allow') {
    const names = [
      ...currentPolicy.names.filter((name) => !catalogNameSet.has(name)),
      ...catalogNames.filter((name) => !excludedSet.has(name)),
    ];
    return names.length > 0 ? { policy: 'allow', names: [...new Set(names)] } : { policy: 'none' };
  }

  if (currentPolicy.policy === 'deny') {
    const names = [
      ...currentPolicy.names.filter((name) => !catalogNameSet.has(name)),
      ...excludedCatalogNames,
    ];
    return names.length > 0 ? { policy: 'deny', names: [...new Set(names)] } : { policy: 'all' };
  }

  if (currentPolicy.policy === 'none') {
    const names = catalogNames.filter((name) => !excludedSet.has(name));
    return names.length > 0 ? { policy: 'allow', names } : { policy: 'none' };
  }

  if (excludedCatalogNames.length === 0) return { policy: 'all' };
  if (tools.length > 0 && excludedCatalogNames.length === tools.length) return { policy: 'none' };
  return { policy: 'deny', names: excludedCatalogNames };
}

function formatManifestYaml(value: unknown): string {
  if (value == null) return '';
  try {
    return serializeManifestYAML(validateManifest(value));
  } catch {
    return formatJsonLike(value);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
