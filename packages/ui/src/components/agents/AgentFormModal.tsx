import { useState, useEffect, useCallback, type KeyboardEvent } from 'react';
import { X } from 'lucide-react';
import { useAgentsStore, type Agent } from '@/stores/agents';
import { cn } from '@/lib/utils';

interface AgentFormModalProps {
  open: boolean;
  onClose: () => void;
  agent?: Agent | null;
}

const MODEL_OPTIONS = [
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
  'openai/gpt-5-mini',
  'openai/gpt-4.1-mini',
] as const;

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
          key={`${item}-${i}`}
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
  const { createAgent, updateAgent, agents: allAgents } = useAgentsStore();

  const [name, setName] = useState('');
  const [model, setModel] = useState<string>(MODEL_OPTIONS[0]);
  const [description, setDescription] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [tools, setTools] = useState<string[]>([]);
  const [toolInput, setToolInput] = useState('');
  const [skills, setSkills] = useState<string[]>([]);
  const [skillInput, setSkillInput] = useState('');
  const [subagents, setSubagents] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const isEditing = Boolean(agent);

  // Populate form when editing
  useEffect(() => {
    if (agent) {
      setName(agent.name);
      setModel(agent.model);
      setDescription(agent.description ?? '');
      setSystemPrompt(agent.systemPrompt ?? '');
      setTools(agent.tools ?? []);
      setSkills(agent.skills ?? (agent.metadata?.skills as string[]) ?? []);
      setSubagents(agent.subagents ?? []);
    } else {
      setName('');
      setModel(MODEL_OPTIONS[0]);
      setDescription('');
      setSystemPrompt('');
      setTools([]);
      setSkills([]);
      setSubagents([]);
    }
    setToolInput('');
    setSkillInput('');
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
    if (!model) errs.model = 'Model is required';
    if (!systemPrompt.trim()) errs.systemPrompt = 'System prompt is required';
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleSave = async () => {
    if (!validate()) return;
    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        model,
        systemPrompt: systemPrompt.trim(),
        tools,
        description: description.trim() || undefined,
        metadata: (subagents.length > 0 || skills.length > 0)
          ? { ...(subagents.length > 0 ? { subagents } : {}), ...(skills.length > 0 ? { skills } : {}) }
          : undefined,
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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-surface-950/80 animate-fade-in"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="relative w-full max-w-lg mx-4 rounded-lg border border-surface-700 bg-surface-850 animate-slide-up"
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
            <label className="text-label">
              Name
            </label>
            <input
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

          {/* Model */}
          <div>
            <label className="text-label">
              Model
            </label>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className={cn('input-base mt-1.5', errors.model && 'border-red-500/60')}
            >
              {MODEL_OPTIONS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            {errors.model && (
              <p className="mt-1 text-xs text-red-400">{errors.model}</p>
            )}
          </div>

          {/* Description */}
          <div>
            <label className="text-label">
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description..."
              rows={2}
              className="input-base mt-1.5 resize-none"
            />
          </div>

          {/* System Prompt */}
          <div>
            <label className="text-label">
              System Prompt
            </label>
            <textarea
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

          {/* Tools */}
          <div>
            <label className="text-label">
              Tools
            </label>
            <input
              type="text"
              value={toolInput}
              onChange={(e) => setToolInput(e.target.value)}
              onKeyDown={(e) =>
                handleTagKeyDown(e, toolInput, tools, setTools, setToolInput)
              }
              onBlur={() =>
                handleTagBlur(toolInput, tools, setTools, setToolInput)
              }
              placeholder="Type tool names, comma-separated..."
              className="input-base mt-1.5"
            />
            <TagList
              items={tools}
              onRemove={(i) => setTools(tools.filter((_, idx) => idx !== i))}
              color="brand"
            />
          </div>

          {/* Skills */}
          <div>
            <label className="text-label">
              Skills
            </label>
            <input
              type="text"
              value={skillInput}
              onChange={(e) => setSkillInput(e.target.value)}
              onKeyDown={(e) =>
                handleTagKeyDown(e, skillInput, skills, setSkills, setSkillInput)
              }
              onBlur={() =>
                handleTagBlur(skillInput, skills, setSkills, setSkillInput)
              }
              placeholder="Type skill names, comma-separated..."
              className="input-base mt-1.5"
            />
            <TagList
              items={skills}
              onRemove={(i) => setSkills(skills.filter((_, idx) => idx !== i))}
              color="brand"
            />
          </div>

          {/* Subagents */}
          <div>
            <label className="text-label">
              Subagents
            </label>
            <select
              className="input-base mt-1.5"
              value=""
              onChange={(e) => {
                if (e.target.value && !subagents.includes(e.target.value)) {
                  setSubagents([...subagents, e.target.value]);
                }
                e.target.value = '';
              }}
            >
              <option value="">Select an agent...</option>
              {allAgents
                .filter((a) => (agent ? a.id !== agent.id : true))
                .filter((a) => !subagents.includes(a.id))
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({a.status})
                  </option>
                ))}
            </select>
            <TagList
              items={subagents.map((id) => {
                const found = allAgents.find((a) => a.id === id);
                return found ? found.name : id;
              })}
              onRemove={(i) =>
                setSubagents(subagents.filter((_, idx) => idx !== i))
              }
              color="accent"
            />
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
    </div>
  );
}
