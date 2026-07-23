import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Zap,
  Plus,
  Pencil,
  Trash2,
  X,
  Loader2,
  Filter,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAgentsStore } from '@/stores/agents';
import {
  fetchTriggers,
  createTrigger,
  updateTrigger,
  deleteTrigger,
  fetchEventTypes,
  type Trigger,
} from '@/lib/api';
import { AlertBanner } from '@/components/ui/AlertBanner';
import { PageShell } from '@/components/ui/PageShell';
import { StatsRow } from '@/components/ui/StatsRow';

interface TriggerFormData {
  agentId: string;
  eventType: string;
  taskTemplate: string;
  selector: string;
  enabled: boolean;
}

const EMPTY_FORM: TriggerFormData = {
  agentId: '',
  eventType: '',
  taskTemplate: '',
  selector: '',
  enabled: true,
};

export function TriggersPage() {
  const agents = useAgentsStore((s) => s.agents);
  const fetchAgents = useAgentsStore((s) => s.fetchAgents);

  const [triggers, setTriggers] = useState<Trigger[]>([]);
  const [eventTypes, setEventTypes] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [eventTypesError, setEventTypesError] = useState<string | null>(null);

  // Filters
  const [agentFilter, setAgentFilter] = useState<string>('');
  const [typeFilter, setTypeFilter] = useState<string>('');

  // Modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [editingTrigger, setEditingTrigger] = useState<Trigger | null>(null);
  const [form, setForm] = useState<TriggerFormData>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Delete confirmation
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Per-row inline error (id -> message). Cleared on row interaction or reload.
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});

  const agentNameMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const a of agents) map[a.id] = a.name;
    return map;
  }, [agents]);

  const loadTriggers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchTriggers(agentFilter || undefined);
      const list = Array.isArray(data) ? data : [];
      setTriggers(list);
      // A successful refresh clears any stale per-row errors for rows that
      // are still present; rows that disappear no longer need surfacing.
      setRowErrors((prev) => {
        const next: Record<string, string> = {};
        const ids = new Set(list.map((t) => t.id));
        for (const [id, msg] of Object.entries(prev)) {
          if (ids.has(id)) next[id] = msg;
        }
        return next;
      });
    } catch (err) {
      setError('Failed to load triggers.');
      console.debug('[Triggers] Load failed:', err);
    } finally {
      setLoading(false);
    }
  }, [agentFilter]);

  const loadEventTypes = useCallback(async () => {
    setEventTypesError(null);

    try {
      const data = await fetchEventTypes();
      setEventTypes(data.types);
    } catch (err) {
      console.debug('[Triggers] Event types load failed:', err);
      setEventTypes([]);
      setEventTypesError('Event type suggestions are unavailable.');
    }
  }, []);

  useEffect(() => {
    if (agents.length === 0) fetchAgents();
    void loadEventTypes();
  }, [agents.length, fetchAgents, loadEventTypes]);

  useEffect(() => {
    loadTriggers();
  }, [loadTriggers]);

  // Filtered triggers
  const filteredTriggers = useMemo(() => {
    let result = triggers;
    if (typeFilter) {
      result = result.filter((t) => t.eventType === typeFilter);
    }
    return result;
  }, [triggers, typeFilter]);

  // Stats
  const stats = useMemo(() => {
    const active = triggers.filter((t) => t.enabled).length;
    const inactive = triggers.length - active;
    const types = new Set(triggers.map((t) => t.eventType)).size;
    return { total: triggers.length, active, inactive, types };
  }, [triggers]);

  // Unique event types from triggers
  const triggerEventTypes = useMemo(() => {
    const types = new Set(triggers.map((t) => t.eventType));
    return Array.from(types).sort();
  }, [triggers]);

  const openCreateModal = () => {
    setEditingTrigger(null);
    setForm(EMPTY_FORM);
    setFormError(null);
    setActionError(null);
    setModalOpen(true);
  };

  const openEditModal = (trigger: Trigger) => {
    setEditingTrigger(trigger);
    setForm({
      agentId: trigger.agentId,
      eventType: trigger.eventType,
      taskTemplate: trigger.taskTemplate,
      selector: trigger.selector ? JSON.stringify(trigger.selector, null, 2) : '',
      enabled: trigger.enabled,
    });
    setFormError(null);
    setActionError(null);
    setModalOpen(true);
  };

  const closeModal = () => {
    setModalOpen(false);
    setEditingTrigger(null);
    setForm(EMPTY_FORM);
    setFormError(null);
  };

  const handleSave = async () => {
    if (!form.agentId || !form.eventType || !form.taskTemplate) {
      setFormError('Agent, event type, and task template are required.');
      return;
    }

    let selector: Record<string, unknown> | null | undefined = editingTrigger ? null : undefined;
    if (form.selector.trim()) {
      try {
        const parsed: unknown = JSON.parse(form.selector);
        if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
          setFormError('Selector must be a JSON object.');
          return;
        }
        selector = parsed as Record<string, unknown>;
      } catch {
        setFormError('Selector must be valid JSON.');
        return;
      }
    }

    setSaving(true);
    setFormError(null);
    setActionError(null);

    try {
      if (editingTrigger) {
        await updateTrigger(editingTrigger.id, {
          eventType: form.eventType,
          taskTemplate: form.taskTemplate,
          selector,
          enabled: form.enabled,
        });
      } else {
        await createTrigger({
          agentId: form.agentId,
          eventType: form.eventType,
          taskTemplate: form.taskTemplate,
          selector: selector ?? undefined,
          enabled: form.enabled,
        });
      }
      closeModal();
      await loadTriggers();
    } catch (err) {
      const fallback = editingTrigger ? 'Failed to update trigger.' : 'Failed to create trigger.';
      setFormError(err instanceof Error && err.message ? err.message : fallback);
      console.debug('[Triggers] Save failed:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    // Optimistic remove. Snapshot the previous list so we can roll back on
    // failure — otherwise users perceive the row as deleted but it reappears
    // after the next list refresh, masking the real failure.
    const previous = triggers;
    setRowErrors((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setTriggers((current) => current.filter((trigger) => trigger.id !== id));
    setDeletingId(null);

    try {
      await deleteTrigger(id);
      // Refresh quietly to pick up any server-side reconciliation.
      await loadTriggers();
    } catch (err) {
      // Roll back the optimistic delete and surface the failure inline.
      setTriggers(previous);
      setRowErrors((prev) => ({ ...prev, [id]: 'Failed to delete trigger.' }));
      setActionError('Failed to delete trigger.');
      console.debug('[Triggers] Delete failed:', err);
    }
  };

  const handleToggleEnabled = async (trigger: Trigger) => {
    const previous = triggers;
    const nextEnabled = !trigger.enabled;
    setRowErrors((prev) => {
      const next = { ...prev };
      delete next[trigger.id];
      return next;
    });
    // Optimistically flip the toggle locally.
    setTriggers((current) => current.map((entry) => (
      entry.id === trigger.id ? { ...entry, enabled: nextEnabled } : entry
    )));

    try {
      await updateTrigger(trigger.id, { enabled: nextEnabled });
      await loadTriggers();
    } catch (err) {
      // Roll back the optimistic toggle.
      setTriggers(previous);
      setRowErrors((prev) => ({ ...prev, [trigger.id]: 'Failed to update trigger status.' }));
      setActionError('Failed to update trigger status.');
      console.debug('[Triggers] Toggle failed:', err);
    }
  };

  const hasActiveFilters = agentFilter || typeFilter;
  const hasLoadedTriggers = triggers.length > 0;

  return (
    <div className="flex min-h-screen flex-col bg-surface-950">
      <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-5 space-y-6">
        <div>
          <PageShell
            title="Event Triggers"
            description="Configure automated responses to event bus activity."
            actions={(
              <button type="button" onClick={openCreateModal} className="btn-primary">
                <Plus className="h-4 w-4" />
                Create Trigger
              </button>
            )}
          />

          <StatsRow
            items={[
              { label: 'Total Triggers', value: loading ? '--' : stats.total },
              { label: 'Active', value: loading ? '--' : stats.active },
              { label: 'Inactive', value: loading ? '--' : stats.inactive },
              { label: 'Event Types', value: loading ? '--' : stats.types },
            ]}
          />
        </div>

        {error && hasLoadedTriggers && (
          <AlertBanner
            tone="error"
            message={error}
            actionLabel="Retry"
            onAction={() => void loadTriggers()}
            testId="triggers-retry-button"
          />
        )}

        {eventTypesError && (
          <AlertBanner
            tone="warning"
            message={eventTypesError}
            actionLabel="Retry"
            onAction={() => void loadEventTypes()}
            testId="triggers-type-retry-button"
          />
        )}

        {actionError && (
          <AlertBanner
            tone="error"
            message={actionError}
            actionLabel="Dismiss"
            onAction={() => setActionError(null)}
            testId="triggers-action-error-dismiss"
          />
        )}

        {/* Filter bar */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1.5 text-xs text-surface-400">
            <Filter className="h-3.5 w-3.5" />
            <span>Filters</span>
          </div>

          <select
            value={agentFilter}
            onChange={(e) => setAgentFilter(e.target.value)}
            className="rounded-lg border border-surface-700 bg-surface-800 px-3 py-1.5 text-xs text-surface-200 focus:outline-none focus:ring-1 focus:ring-accent-500/50"
          >
            <option value="">All agents</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>

          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="rounded-lg border border-surface-700 bg-surface-800 px-3 py-1.5 text-xs text-surface-200 focus:outline-none focus:ring-1 focus:ring-accent-500/50"
          >
            <option value="">All event types</option>
            {(triggerEventTypes.length > 0 ? triggerEventTypes : eventTypes).map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>

          {hasActiveFilters && (
            <button
              type="button"
              onClick={() => {
                setAgentFilter('');
                setTypeFilter('');
              }}
              className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-surface-400 hover:text-surface-200 transition-colors"
            >
              <X className="h-3 w-3" />
              Clear
            </button>
          )}
        </div>

        {/* Content */}
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-6 w-6 text-accent-400 animate-spin" />
          </div>
        ) : error && !hasLoadedTriggers ? (
          <div className="flex flex-col items-center justify-center gap-4 py-20 text-center">
            <Zap className="h-8 w-8 text-red-300" />
            <div className="space-y-1">
              <p className="text-sm text-red-200">{error}</p>
              <p className="text-xs text-surface-400">
                Trigger configuration is unavailable until the API responds.
              </p>
            </div>
            <button
              type="button"
              data-testid="triggers-retry-button"
              onClick={() => void loadTriggers()}
              className="btn-secondary"
            >
              Retry
            </button>
          </div>
        ) : filteredTriggers.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <Zap className="h-8 w-8 text-surface-400 mb-3" />
            <p className="text-sm text-surface-400">No triggers found</p>
            <p className="text-xs text-surface-400 mt-1">
              Create a trigger to automate responses to events.
            </p>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {filteredTriggers.map((trigger) => (
              <div
                key={trigger.id}
                data-testid="trigger-card"
                data-trigger-id={trigger.id}
                className="card p-4 space-y-3"
              >
                {rowErrors[trigger.id] && (
                  <div
                    role="alert"
                    data-testid="trigger-row-error"
                    className="rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-[11px] text-red-300 flex items-center justify-between gap-2"
                  >
                    <span>{rowErrors[trigger.id]}</span>
                    <button
                      type="button"
                      onClick={() => setRowErrors((prev) => {
                        const next = { ...prev };
                        delete next[trigger.id];
                        return next;
                      })}
                      className="text-red-200 hover:text-red-100 text-[11px]"
                      aria-label="Dismiss row error"
                    >
                      ×
                    </button>
                  </div>
                )}
                {/* Header row */}
                <div className="flex items-start justify-between">
                  <div className="space-y-1 min-w-0 flex-1">
                    <p className="text-sm font-semibold text-surface-100 truncate">
                      {trigger.eventType}
                    </p>
                    <p className="text-xs text-surface-400 truncate">
                      {agentNameMap[trigger.agentId] || trigger.agentId.slice(0, 8)}
                    </p>
                  </div>
                  {/* Toggle */}
                  <button
                    type="button"
                    onClick={() => handleToggleEnabled(trigger)}
                    className={cn(
                      'relative inline-flex h-5 w-9 flex-shrink-0 rounded-full border-2 border-transparent transition-colors cursor-pointer',
                      trigger.enabled ? 'bg-accent-600' : 'bg-surface-600',
                    )}
                  >
                    <span
                      className={cn(
                        'pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transition-transform',
                        trigger.enabled ? 'translate-x-4' : 'translate-x-0',
                      )}
                    />
                  </button>
                </div>

                {/* Task template */}
                <div>
                  <p className="text-label mb-1">Task Template</p>
                  <p className="text-xs text-surface-300 line-clamp-2 font-mono bg-surface-850 rounded px-2 py-1.5 border border-surface-700">
                    {trigger.taskTemplate}
                  </p>
                </div>

                {/* Status badge */}
                <div className="flex items-center justify-between">
                  <span
                    className={cn(
                      'inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-medium',
                      trigger.enabled
                        ? 'bg-green-500/10 border-green-500/20 text-green-400'
                        : 'bg-surface-700/30 border-surface-600/30 text-surface-400',
                    )}
                  >
                    {trigger.enabled ? 'Enabled' : 'Disabled'}
                  </span>

                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => openEditModal(trigger)}
                      className="rounded-md p-1.5 text-surface-400 transition-colors hover:text-surface-200 hover:bg-surface-700"
                      title="Edit trigger"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    {deletingId === trigger.id ? (
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => handleDelete(trigger.id)}
                          className="rounded-md px-2 py-1 text-[11px] font-medium text-red-400 bg-red-500/10 hover:bg-red-500/20 transition-colors"
                        >
                          Confirm
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeletingId(null)}
                          className="rounded-md px-2 py-1 text-[11px] font-medium text-surface-400 hover:text-surface-200 transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setDeletingId(trigger.id)}
                        className="rounded-md p-1.5 text-surface-400 transition-colors hover:text-red-400 hover:bg-red-500/10"
                        title="Delete trigger"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      {/* Create/Edit Modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/60"
            onClick={closeModal}
          />
          {/* Modal */}
          <div className="relative w-full max-w-lg mx-4 rounded-lg border border-surface-700 bg-surface-850 shadow-xl">
            <div className="flex items-center justify-between border-b border-surface-700 px-6 py-4">
              <h3 className="text-lg font-semibold text-surface-100">
                {editingTrigger ? 'Edit Trigger' : 'Create Trigger'}
              </h3>
              <button
                type="button"
                onClick={closeModal}
                className="rounded-md p-1 text-surface-400 hover:text-surface-200 transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="px-6 py-4 space-y-4">
              {formError && (
                <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
                  {formError}
                </div>
              )}

              {/* Agent */}
              <div>
                <label className="text-label mb-1.5 block">Agent</label>
                <select
                  value={form.agentId}
                  onChange={(e) => setForm({ ...form, agentId: e.target.value })}
                  disabled={!!editingTrigger}
                  className="input-base"
                >
                  <option value="">Select agent...</option>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </div>

              {/* Event Type */}
              <div>
                <label className="text-label mb-1.5 block">Event Type</label>
                <input
                  type="text"
                  value={form.eventType}
                  onChange={(e) => setForm({ ...form, eventType: e.target.value })}
                  placeholder="e.g. turn.completed"
                  className="input-base"
                />
              </div>

              {/* Task Template */}
              <div>
                <label className="text-label mb-1.5 block">Task Template</label>
                <textarea
                  value={form.taskTemplate}
                  onChange={(e) => setForm({ ...form, taskTemplate: e.target.value })}
                  placeholder="Task to execute when event fires..."
                  rows={3}
                  className="input-base resize-none"
                />
              </div>

              {/* Selector (JSON) */}
              <div>
                <label className="text-label mb-1.5 block">Selector (JSON, optional)</label>
                <textarea
                  value={form.selector}
                  onChange={(e) => setForm({ ...form, selector: e.target.value })}
                  placeholder='{"key": "value"}'
                  rows={2}
                  className="input-base resize-none font-mono text-xs"
                />
              </div>

              {/* Enabled toggle */}
              <div className="flex items-center justify-between">
                <label className="text-label">Enabled</label>
                <button
                  type="button"
                  onClick={() => setForm({ ...form, enabled: !form.enabled })}
                  className={cn(
                    'relative inline-flex h-5 w-9 flex-shrink-0 rounded-full border-2 border-transparent transition-colors cursor-pointer',
                    form.enabled ? 'bg-accent-600' : 'bg-surface-600',
                  )}
                >
                  <span
                    className={cn(
                      'pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transition-transform',
                      form.enabled ? 'translate-x-4' : 'translate-x-0',
                    )}
                  />
                </button>
              </div>
            </div>

            <div className="flex items-center justify-end gap-3 border-t border-surface-700 px-6 py-4">
              <button type="button" onClick={closeModal} className="btn-secondary">
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="btn-primary"
              >
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                {editingTrigger ? 'Update' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
