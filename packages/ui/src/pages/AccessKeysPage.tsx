import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Ban,
  Check,
  Clipboard,
  KeyRound,
  Loader2,
  Plus,
  ShieldCheck,
  ShieldX,
  X,
} from 'lucide-react';
import {
  CAPABILITY_VERBS,
  CapabilitySchema,
  type ApiKey,
  type ApiKeyCreateInput,
  type CapabilityVerb,
} from '@stablehand/contracts';

import {
  createApiKey,
  fetchApiKeys,
  fetchConfig,
  revokeApiKey,
} from '@/lib/api';
import { PageShell } from '@/components/ui/PageShell';
import { SettingsNav } from '@/components/settings/SettingsNav';
import { cn } from '@/lib/utils';

const CAPABILITY_COPY: Readonly<Record<CapabilityVerb, {
  label: string;
  receipt: string;
  detail: string;
}>> = {
  'agents:read': {
    label: 'Read agents',
    receipt: 'Read agents and conversation history',
    detail: 'Includes prompts, harness configuration, turns, and live streams.',
  },
  'agents:write': {
    label: 'Manage agents',
    receipt: 'Create, edit, and hard-delete agents',
    detail: 'Deletion cascades through agent-owned runtime data.',
  },
  'conversations:write': {
    label: 'Run agents',
    receipt: 'Start and cancel agent turns',
    detail: 'Runs may invoke configured tools, secrets, and paid models.',
  },
  'events:read': {
    label: 'Read events',
    receipt: 'Read the persisted event log',
    detail: 'Includes event payloads across the deployment.',
  },
  'interrupts:read': {
    label: 'Read approvals',
    receipt: 'Read pending and resolved approvals',
    detail: 'Includes tool names, arguments, and resolution state.',
  },
  'interrupts:resolve': {
    label: 'Resolve approvals',
    receipt: 'Approve or reject interrupted tools',
    detail: 'Can resume agent work with external side effects.',
  },
  'feedback:write': {
    label: 'Submit feedback',
    receipt: 'Submit message feedback',
    detail: 'Can attach ratings and comments to agent messages.',
  },
  'artifacts:read': {
    label: 'Read artifacts',
    receipt: 'Read artifacts and create download links',
    detail: 'Signed download links remain valid until their own expiry.',
  },
  'artifacts:write': {
    label: 'Upload artifacts',
    receipt: 'Register and upload artifacts',
    detail: 'Does not grant artifact deletion.',
  },
  'webhooks:manage': {
    label: 'Manage webhooks',
    receipt: 'Create and manage agent webhooks',
    detail: 'Webhook destinations can receive future event payloads.',
  },
  'schedules:manage': {
    label: 'Manage schedules',
    receipt: 'Create and manage scheduled events',
    detail: 'Schedules persist after this key is revoked.',
  },
  'triggers:emit': {
    label: 'Emit custom events',
    receipt: 'Emit custom events',
    detail: 'Events may activate configured agent triggers.',
  },
};

const ALWAYS_BLOCKED = [
  'Secrets and workspace files',
  'Access-key administration',
  'Budgets, analytics, and runtime settings',
  'Manual sandbox lifecycle controls',
  'Trigger definition management',
  'Artifact deletion',
] as const;

const PRESETS = [
  {
    id: 'artifact',
    label: 'Artifact consumer',
    detail: 'Read artifacts and manage delivery webhooks.',
    capabilities: ['artifacts:read', 'webhooks:manage'] as CapabilityVerb[],
  },
  {
    id: 'runner',
    label: 'Agent runner',
    detail: 'Inspect agents, then start or cancel turns.',
    capabilities: ['agents:read', 'conversations:write'] as CapabilityVerb[],
  },
  {
    id: 'events',
    label: 'Event reader',
    detail: 'Read the event log without mutation access.',
    capabilities: ['events:read'] as CapabilityVerb[],
  },
  {
    id: 'custom',
    label: 'Custom',
    detail: 'Choose each capability explicitly.',
    capabilities: [] as CapabilityVerb[],
  },
] as const;

type PresetId = (typeof PRESETS)[number]['id'];
type ExpirationChoice = 'never' | '7d' | '30d' | '90d' | 'custom';

function dateTime(value: number | null, fallback: string): string {
  if (value === null) return fallback;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function statusStyle(status: ApiKey['status']): string {
  if (status === 'active') return 'border-green-500/30 bg-green-500/10 text-green-300';
  if (status === 'expired') return 'border-amber-500/30 bg-amber-500/10 text-amber-300';
  return 'border-surface-600 bg-surface-800 text-surface-400';
}

function namespaceGrant(namespace: string): string | null {
  const trimmed = namespace.trim();
  const candidate = `triggers:emit:custom.${trimmed}.*`;
  return CapabilitySchema.safeParse(candidate).success ? candidate : null;
}

export function AccessKeysPage() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [authenticationMode, setAuthenticationMode] = useState<'enforced' | 'disabled' | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createdSecret, setCreatedSecret] = useState<{ name: string; token: string } | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [config, response] = await Promise.all([fetchConfig(), fetchApiKeys()]);
      setAuthenticationMode(config.authentication.mode);
      setKeys(response.keys);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to load access keys');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCreated = (created: ApiKey, token: string): void => {
    setKeys((current) => [created, ...current.filter((key) => key.id !== created.id)]);
    setCreateOpen(false);
    setCreatedSecret({ name: created.name, token });
  };

  const handleRevoke = async (key: ApiKey): Promise<void> => {
    const confirmed = window.confirm(
      `Revoke ${key.name}? New API requests and streams will stop. `
      + 'Existing turns, webhooks, schedules, artifacts, and signed URLs are not removed.',
    );
    if (!confirmed) return;
    setRevokingId(key.id);
    setError(null);
    try {
      const revoked = await revokeApiKey(key.id);
      setKeys((current) => current.map((candidate) =>
        candidate.id === revoked.id ? revoked : candidate));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to revoke access key');
    } finally {
      setRevokingId(null);
    }
  };

  const authDisabled = authenticationMode === 'disabled';

  return (
    <div className="flex min-h-screen flex-col bg-surface-950">
      <main className="mx-auto w-full max-w-7xl flex-1 space-y-6 px-4 py-5 sm:px-6">
        <PageShell
          title="Settings"
          description="Operator controls for runtime configuration and API access."
          icon={<KeyRound className="h-6 w-6 text-surface-400" />}
          actions={(
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              disabled={loading || authDisabled}
              className="btn-primary"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              Create access key
            </button>
          )}
        />
        <SettingsNav />

        <section className="overflow-hidden rounded-xl border border-surface-700 bg-surface-900/70">
          <div className="grid gap-5 border-b border-surface-700 px-5 py-5 md:grid-cols-[1fr_auto] md:items-center">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-accent-400">
                Extension credentials
              </p>
              <h2 className="mt-1 text-lg font-semibold text-surface-100">Scoped access keys</h2>
              <p className="mt-1 max-w-2xl text-sm text-surface-400">
                Give an extension only the API surface it needs. Capabilities are deployment-wide,
                not restricted to one agent or resource.
              </p>
            </div>
            <div className="rounded-lg border border-surface-700 bg-surface-950 px-4 py-3 text-xs text-surface-400">
              <span className="block font-medium text-surface-200">Master token required</span>
              Keys can never create, list, or revoke other keys.
            </div>
          </div>

          {authDisabled ? (
            <div className="mx-5 mt-5 flex gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <div>
                <p className="font-medium">API authentication is disabled</p>
                <p className="mt-0.5 text-xs text-amber-200/75">
                  Configure STABLEHAND_API_TOKEN before creating keys; scoped credentials have no effect in open mode.
                </p>
              </div>
            </div>
          ) : null}

          {error ? (
            <div className="mx-5 mt-5 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
              {error}
            </div>
          ) : null}

          {loading ? (
            <div className="flex items-center justify-center gap-2 py-20 text-sm text-surface-400">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading access keys
            </div>
          ) : keys.length === 0 ? (
            <div className="px-5 py-16 text-center">
              <KeyRound className="mx-auto h-8 w-8 text-surface-600" />
              <p className="mt-3 text-sm font-medium text-surface-200">No scoped keys yet</p>
              <p className="mt-1 text-xs text-surface-400">Create one when an extension is ready to connect.</p>
            </div>
          ) : (
            <div className="overflow-x-auto max-sm:overflow-visible">
              <table className="w-full text-left sm:min-w-[980px] max-sm:block">
                <thead className="bg-surface-950/60 text-[10px] uppercase tracking-[0.14em] text-surface-500 max-sm:hidden">
                  <tr>
                    <th className="px-5 py-3 font-medium">Identity</th>
                    <th className="px-4 py-3 font-medium">Capabilities</th>
                    <th className="px-4 py-3 font-medium">Expires</th>
                    <th className="px-4 py-3 font-medium">Created</th>
                    <th className="px-4 py-3 font-medium">Last authenticated</th>
                    <th className="px-5 py-3 text-right font-medium">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-700/70 max-sm:block">
                  {keys.map((key) => (
                    <tr
                      key={key.id}
                      className="align-top transition-colors hover:bg-surface-800/35 max-sm:grid max-sm:grid-cols-2 max-sm:gap-x-4 max-sm:gap-y-3 max-sm:px-5 max-sm:py-4"
                    >
                      <td className="px-5 py-4 max-sm:col-span-2 max-sm:p-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-sm text-surface-100 max-sm:break-all">{key.name}</span>
                          <span className={cn(
                            'rounded-full border px-2 py-0.5 text-[10px] font-semibold capitalize',
                            statusStyle(key.status),
                          )}>
                            {key.status[0].toUpperCase() + key.status.slice(1)}
                          </span>
                        </div>
                        <p className="mt-1 max-w-xs text-xs text-surface-500">{key.note || 'No note'}</p>
                      </td>
                      <td className="px-4 py-4 max-sm:col-span-2 max-sm:p-0">
                        <span className="mb-2 hidden text-[10px] font-medium uppercase tracking-[0.14em] text-surface-500 max-sm:block">
                          Capabilities
                        </span>
                        <div className="flex max-w-md flex-wrap gap-1.5">
                          {key.capabilities.map((capability) => (
                            <span
                              key={capability}
                              className="rounded border border-accent-500/20 bg-accent-500/5 px-1.5 py-0.5 font-mono text-[10px] text-accent-300 max-sm:break-all"
                            >
                              {capability}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-4 py-4 text-xs text-surface-300 max-sm:p-0">
                        <span className="mb-1 hidden text-[10px] font-medium uppercase tracking-[0.14em] text-surface-500 max-sm:block">
                          Expires
                        </span>
                        <span>{dateTime(key.expiresAt, 'Never')}</span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-4 text-xs text-surface-400 max-sm:p-0">
                        <span className="mb-1 hidden text-[10px] font-medium uppercase tracking-[0.14em] text-surface-500 max-sm:block">
                          Created
                        </span>
                        <span>{dateTime(key.createdAt, 'Unknown')}</span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-4 text-xs text-surface-400 max-sm:p-0">
                        <span className="mb-1 hidden text-[10px] font-medium uppercase tracking-[0.14em] text-surface-500 max-sm:block">
                          Last authenticated
                        </span>
                        <span>{dateTime(key.lastUsedAt, 'Never authenticated')}</span>
                      </td>
                      <td className="px-5 py-4 text-right max-sm:flex max-sm:items-end max-sm:justify-end max-sm:p-0">
                        <button
                          type="button"
                          onClick={() => void handleRevoke(key)}
                          disabled={key.status === 'revoked' || revokingId === key.id}
                          className="rounded-md border border-red-500/25 px-2.5 py-1.5 text-xs font-medium text-red-300 transition-colors hover:bg-red-500/10 disabled:cursor-not-allowed disabled:border-surface-700 disabled:text-surface-600 max-sm:px-3 max-sm:py-2"
                        >
                          {revokingId === key.id ? 'Revoking…' : key.status === 'revoked' ? 'Revoked' : 'Revoke'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>

      {createOpen ? (
        <CreateKeyDialog
          onClose={() => setCreateOpen(false)}
          onCreated={handleCreated}
        />
      ) : null}
      {createdSecret ? (
        <OneTimeSecretDialog
          secret={createdSecret}
          onClose={() => setCreatedSecret(null)}
        />
      ) : null}
    </div>
  );
}

function CreateKeyDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (key: ApiKey, token: string) => void;
}) {
  const [presetId, setPresetId] = useState<PresetId>('artifact');
  const [selected, setSelected] = useState<CapabilityVerb[]>(['artifacts:read', 'webhooks:manage']);
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [expiration, setExpiration] = useState<ExpirationChoice>('never');
  const [customExpiration, setCustomExpiration] = useState('');
  const [emitMode, setEmitMode] = useState<'all' | 'namespace'>('all');
  const [eventNamespace, setEventNamespace] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const capabilities = useMemo(() => selected.map((capability) => {
    if (capability !== 'triggers:emit' || emitMode === 'all') return capability;
    return namespaceGrant(eventNamespace) ?? 'triggers:emit';
  }), [emitMode, eventNamespace, selected]);

  const choosePreset = (id: PresetId): void => {
    const preset = PRESETS.find((candidate) => candidate.id === id);
    setPresetId(id);
    setSelected([...(preset?.capabilities ?? [])]);
    setEmitMode('all');
    setEventNamespace('');
    setError(null);
  };

  const toggleCapability = (capability: CapabilityVerb): void => {
    setSelected((current) => current.includes(capability)
      ? current.filter((candidate) => candidate !== capability)
      : [...current, capability]);
    setPresetId('custom');
  };

  const expiresAt = (): number | null => {
    if (expiration === 'never') return null;
    if (expiration === 'custom') return new Date(customExpiration).getTime();
    const days = Number(expiration.slice(0, -1));
    return Date.now() + days * 24 * 60 * 60 * 1000;
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setError(null);
    if (selected.includes('triggers:emit') && emitMode === 'namespace' && !namespaceGrant(eventNamespace)) {
      setError('Namespace must start with a lowercase letter or number and use only a-z, 0-9, dot, dash, or underscore.');
      return;
    }
    if (capabilities.length === 0) {
      setError('Select at least one capability.');
      return;
    }
    const expirationValue = expiresAt();
    if (expiration === 'custom' && (!Number.isFinite(expirationValue) || expirationValue! <= Date.now())) {
      setError('Choose a custom expiration in the future.');
      return;
    }

    const input: ApiKeyCreateInput = {
      name: name.trim(),
      capabilities,
      expiresAt: expirationValue,
      ...(note.trim() ? { note: note.trim() } : {}),
    };
    setSubmitting(true);
    try {
      const created = await createApiKey(input);
      const { token, ...key } = created;
      onCreated(key, token);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to create access key');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-key-title"
        className="max-h-[92vh] w-full max-w-5xl overflow-y-auto rounded-xl border border-surface-700 bg-surface-900 shadow-2xl shadow-black/60"
      >
        <div className="flex items-start justify-between border-b border-surface-700 px-5 py-4">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-accent-400">Least privilege</p>
            <h2 id="create-key-title" className="mt-1 text-lg font-semibold text-surface-100">Create scoped key</h2>
            <p className="mt-1 text-xs text-surface-400">The secret is shown once after creation.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="p-1 text-surface-400 hover:text-surface-100">
            <X className="h-5 w-5" />
          </button>
        </div>

        <form aria-label="Create access key" onSubmit={(event) => void handleSubmit(event)}>
          <div className="grid lg:grid-cols-[1.1fr_0.9fr]">
            <div className="space-y-5 border-b border-surface-700 p-5 lg:border-b-0 lg:border-r">
              <fieldset>
                <legend className="text-label">Starting point</legend>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => choosePreset(preset.id)}
                      className={cn(
                        'rounded-lg border p-3 text-left transition-colors',
                        presetId === preset.id
                          ? 'border-accent-400/50 bg-accent-500/10'
                          : 'border-surface-700 bg-surface-950/50 hover:border-surface-600',
                      )}
                    >
                      <span className="block text-xs font-semibold text-surface-200">{preset.label}</span>
                      <span className="mt-1 block text-[11px] leading-4 text-surface-500">{preset.detail}</span>
                    </button>
                  ))}
                </div>
              </fieldset>

              <div className="grid gap-4 sm:grid-cols-2">
                <label className="text-xs font-medium text-surface-300" htmlFor="access-key-name">
                  Key name
                  <input
                    id="access-key-name"
                    required
                    autoFocus
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="artifact-gallery-prod"
                    className="input-base mt-1.5 font-mono"
                  />
                </label>
                <label className="text-xs font-medium text-surface-300" htmlFor="access-key-note">
                  Note <span className="font-normal text-surface-500">optional</span>
                  <input
                    id="access-key-note"
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                    placeholder="Owner or deployment"
                    className="input-base mt-1.5"
                  />
                </label>
              </div>

              <fieldset>
                <legend className="text-label">Capabilities</legend>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {CAPABILITY_VERBS.map((capability) => (
                    <label
                      key={capability}
                      className="flex cursor-pointer gap-2.5 rounded-lg border border-surface-700 bg-surface-950/45 p-2.5 hover:border-surface-600"
                    >
                      <input
                        id={`capability-${capability.replace(':', '-')}`}
                        type="checkbox"
                        checked={selected.includes(capability)}
                        onChange={() => toggleCapability(capability)}
                        className="mt-0.5 h-3.5 w-3.5 accent-teal-500"
                      />
                      <span>
                        <span className="block text-xs font-medium text-surface-200">{CAPABILITY_COPY[capability].label}</span>
                        <span className="mt-0.5 block text-[10px] leading-4 text-surface-500">{CAPABILITY_COPY[capability].detail}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>

              {selected.includes('triggers:emit') ? (
                <div className="rounded-lg border border-surface-700 bg-surface-950/60 p-3">
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => setEmitMode('all')}
                      className={cn('rounded-md px-2.5 py-1 text-xs', emitMode === 'all' ? 'bg-accent-500 text-surface-950' : 'bg-surface-800 text-surface-300')}
                    >
                      All custom events
                    </button>
                    <button
                      type="button"
                      onClick={() => setEmitMode('namespace')}
                      className={cn('rounded-md px-2.5 py-1 text-xs', emitMode === 'namespace' ? 'bg-accent-500 text-surface-950' : 'bg-surface-800 text-surface-300')}
                    >
                      Limit namespace
                    </button>
                  </div>
                  {emitMode === 'namespace' ? (
                    <label className="mt-3 block text-xs text-surface-400" htmlFor="event-namespace">
                      Namespace after <code className="text-accent-300">custom.</code>
                      <div className="mt-1 flex items-center rounded-md border border-surface-700 bg-surface-900 font-mono text-xs focus-within:border-accent-500">
                        <span className="pl-3 text-surface-500">custom.</span>
                        <input
                          id="event-namespace"
                          value={eventNamespace}
                          onChange={(event) => setEventNamespace(event.target.value)}
                          placeholder="gallery"
                          className="min-w-0 flex-1 bg-transparent px-0.5 py-2 text-surface-100 outline-none"
                        />
                        <span className="pr-3 text-surface-500">.*</span>
                      </div>
                    </label>
                  ) : null}
                </div>
              ) : null}

              <fieldset>
                <legend className="text-label">Expiration</legend>
                <div className="mt-2 flex flex-wrap gap-2">
                  {([
                    ['never', 'Never'],
                    ['7d', '7 days'],
                    ['30d', '30 days'],
                    ['90d', '90 days'],
                    ['custom', 'Custom'],
                  ] as const).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setExpiration(value)}
                      className={cn(
                        'rounded-md border px-2.5 py-1.5 text-xs transition-colors',
                        expiration === value
                          ? 'border-accent-400/50 bg-accent-500/10 text-accent-200'
                          : 'border-surface-700 text-surface-400 hover:text-surface-200',
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {expiration === 'custom' ? (
                  <input
                    type="datetime-local"
                    aria-label="Custom expiration"
                    value={customExpiration}
                    onChange={(event) => setCustomExpiration(event.target.value)}
                    className="input-base mt-2 max-w-xs"
                  />
                ) : null}
              </fieldset>
            </div>

            <PermissionReceipt
              capabilities={capabilities}
              emitMode={emitMode}
              eventNamespace={eventNamespace}
            />
          </div>

          {error ? (
            <p className="mx-5 mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</p>
          ) : null}
          <div className="flex items-center justify-end gap-3 border-t border-surface-700 px-5 py-4">
            <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
            <button type="submit" disabled={submitting} className="btn-primary">
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
              {submitting ? 'Creating…' : 'Create key'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function PermissionReceipt({
  capabilities,
  emitMode,
  eventNamespace,
}: {
  capabilities: string[];
  emitMode: 'all' | 'namespace';
  eventNamespace: string;
}) {
  return (
    <aside className="bg-surface-950/55 p-5">
      <div className="flex items-center gap-2">
        <Clipboard className="h-4 w-4 text-accent-400" />
        <h3 className="text-sm font-semibold text-surface-100">Permission receipt</h3>
      </div>
      <p className="mt-1 text-[11px] leading-4 text-surface-500">
        Review the effective boundary before minting the credential.
      </p>

      <div className="mt-5 grid gap-5 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold text-green-300">
            <ShieldCheck className="h-4 w-4" /> Allowed
          </div>
          <ul className="mt-2 space-y-2">
            {capabilities.length === 0 ? (
              <li className="rounded-md border border-dashed border-surface-700 px-3 py-2 text-[11px] text-surface-500">Nothing selected</li>
            ) : capabilities.map((capability) => {
              const verb = capability.startsWith('triggers:emit:')
                ? 'triggers:emit'
                : capability as CapabilityVerb;
              const scopedEmit = verb === 'triggers:emit' && emitMode === 'namespace';
              return (
                <li key={capability} className="rounded-md border border-green-500/15 bg-green-500/5 px-3 py-2">
                  <span className="flex items-start gap-2 text-[11px] text-surface-200">
                    <Check className="mt-0.5 h-3 w-3 shrink-0 text-green-400" />
                    {scopedEmit && namespaceGrant(eventNamespace)
                      ? `Only custom.${eventNamespace.trim()}.* events`
                      : CAPABILITY_COPY[verb].receipt}
                  </span>
                  <code className="mt-1 block break-all pl-5 text-[9px] text-green-400/70">{capability}</code>
                </li>
              );
            })}
          </ul>
        </div>

        <div>
          <div className="flex items-center gap-2 text-xs font-semibold text-surface-300">
            <ShieldX className="h-4 w-4" /> Always blocked
          </div>
          <ul className="mt-2 space-y-2">
            {ALWAYS_BLOCKED.map((item) => (
              <li key={item} className="flex items-start gap-2 text-[11px] leading-4 text-surface-500">
                <Ban className="mt-0.5 h-3 w-3 shrink-0 text-surface-600" /> {item}
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="mt-5 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-[11px] leading-4 text-amber-200/80">
        Revocation blocks new requests and closes authenticated streams within about 15 seconds.
        It does not cancel running turns or delete resources already created.
      </div>
    </aside>
  );
}

function OneTimeSecretDialog({
  secret,
  onClose,
}: {
  secret: { name: string; token: string };
  onClose: () => void;
}) {
  const [copied, setCopied] = useState<'token' | 'env' | null>(null);

  const copy = async (kind: 'token' | 'env', value: string): Promise<void> => {
    await navigator.clipboard.writeText(value);
    setCopied(kind);
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
      <div role="dialog" aria-modal="true" aria-labelledby="one-time-token-title" className="w-full max-w-xl rounded-xl border border-accent-500/35 bg-surface-900 shadow-2xl shadow-black/70">
        <div className="border-b border-surface-700 px-5 py-4">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-accent-500/30 bg-accent-500/10 text-accent-300">
              <KeyRound className="h-5 w-5" />
            </span>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-accent-400">Created</p>
              <h2 id="one-time-token-title" className="text-base font-semibold text-surface-100">Save {secret.name} now</h2>
            </div>
          </div>
        </div>
        <div className="space-y-4 p-5">
          <div className="flex gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            This token cannot be retrieved again. It is cleared from this page when you close the dialog.
          </div>
          <SecretCopyRow
            label="Token"
            value={secret.token}
            copied={copied === 'token'}
            onCopy={() => void copy('token', secret.token)}
          />
          <SecretCopyRow
            label="Environment variable"
            value={`STABLEHAND_API_TOKEN=${secret.token}`}
            copied={copied === 'env'}
            onCopy={() => void copy('env', `STABLEHAND_API_TOKEN=${secret.token}`)}
          />
        </div>
        <div className="flex justify-end border-t border-surface-700 px-5 py-4">
          <button type="button" onClick={onClose} className="btn-primary">I saved it</button>
        </div>
      </div>
    </div>
  );
}

function SecretCopyRow({
  label,
  value,
  copied,
  onCopy,
}: {
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div>
      <p className="text-label">{label}</p>
      <div className="mt-1.5 flex items-center gap-2 rounded-lg border border-surface-700 bg-surface-950 p-2">
        <code className="min-w-0 flex-1 break-all px-1 text-xs text-surface-200">{value}</code>
        <button type="button" onClick={onCopy} className="btn-secondary shrink-0 px-2.5 py-1.5 text-xs">
          {copied ? <Check className="h-3.5 w-3.5" /> : <Clipboard className="h-3.5 w-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}
