import { useCallback, useEffect, useState } from 'react';
import { KeyRound, Trash2, AlertTriangle, X } from 'lucide-react';
import { fetchSecretKeys, setSecret, deleteSecret } from '@/lib/api';

export interface AgentSecretsTabProps {
  agentId: string;
}

export function AgentSecretsTab({ agentId }: AgentSecretsTabProps) {
  const [keys, setKeys] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadKeys = useCallback(async () => {
    try {
      setError(null);
      const data = await fetchSecretKeys(agentId);
      setKeys(data.keys ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setKeys([]);
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    void loadKeys();
  }, [loadKeys]);

  const handleAdd = async () => {
    if (!newKey.trim() || newValue.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      await setSecret(agentId, newKey, newValue);
      await loadKeys();
      setNewKey('');
      setNewValue('');
      setShowForm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (key: string) => {
    setDeleting(true);
    setError(null);
    try {
      await deleteSecret(agentId, key);
      await loadKeys();
      setConfirmDelete(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="h-6 w-6 border-2 border-accent-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div data-testid="secrets-tab" className="space-y-6">
      {/* Warning banner */}
      <div className="flex items-start gap-3 rounded-lg border border-amber-700/30 bg-amber-900/10 px-4 py-3">
        <AlertTriangle className="h-4 w-4 text-amber-400 mt-0.5 shrink-0" />
        <p className="text-sm text-amber-300/90">
          Secret values are encrypted at rest. Values cannot be retrieved after saving.
          Per-agent secrets override environment variables during agent execution.
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-700/30 bg-red-900/10 px-4 py-2 text-sm text-red-300">
          {error}
        </div>
      )}

      {/* Header with add button */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-accent-400" />
          <h3 className="text-sm font-semibold text-surface-200">
            Secrets ({keys.length})
          </h3>
        </div>
        <button
          type="button"
          onClick={() => setShowForm(!showForm)}
          className="text-xs text-accent-400 hover:text-accent-300 transition-colors"
        >
          {showForm ? 'Cancel' : '+ Add Secret'}
        </button>
      </div>

      {/* Add secret form */}
      {showForm && (
        <div className="rounded-lg border border-accent-500/20 bg-surface-800/60 p-4 space-y-3">
          <input
            type="text"
            placeholder="KEY_NAME (e.g. OPENAI_API_KEY)"
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            className="w-full rounded-lg border border-surface-600/50 bg-surface-900/50 px-3 py-2 text-sm text-surface-200 font-mono placeholder:text-surface-400 focus:outline-none focus:border-accent-500/50"
            data-testid="secret-key-input"
          />
          <textarea
            placeholder="Secret value"
            value={newValue}
            onChange={(e) => setNewValue(e.target.value)}
            rows={4}
            spellCheck={false}
            className="w-full resize-y rounded-lg border border-surface-600/50 bg-surface-900/50 px-3 py-2 font-mono text-sm text-surface-200 placeholder:text-surface-400 focus:outline-none focus:border-accent-500/50"
            data-testid="secret-value-input"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleAdd}
              disabled={saving || !newKey.trim() || newValue.length === 0}
              className="rounded-lg bg-accent-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-accent-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              data-testid="save-secret-button"
            >
              {saving ? 'Saving...' : 'Save Secret'}
            </button>
            <button
              type="button"
              onClick={() => { setShowForm(false); setNewKey(''); setNewValue(''); }}
              className="rounded-lg border border-surface-600 px-4 py-1.5 text-xs font-medium text-surface-300 hover:border-surface-500 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Secret keys list */}
      {keys.length === 0 ? (
        <div className="text-center py-12">
          <KeyRound className="h-8 w-8 text-surface-500 mx-auto mb-3" />
          <p className="text-surface-400 font-medium">No secrets configured</p>
          <p className="text-surface-400 text-sm mt-1">
            Add per-agent secrets to override environment variables.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {keys.map((key) => (
            <div
              key={key}
              data-testid="secret-row"
              className="flex items-center justify-between border border-surface-700 rounded-lg bg-surface-800 px-4 py-3 transition-colors hover:border-surface-600"
            >
              {confirmDelete === key ? (
                <div className="flex items-center gap-3 w-full">
                  <p className="text-sm text-surface-300 flex-1">
                    Delete <span className="font-mono font-medium text-surface-200">{key}</span>?
                  </p>
                  <button
                    type="button"
                    onClick={() => handleDelete(key)}
                    disabled={deleting}
                    className="rounded-lg bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {deleting ? 'Deleting...' : 'Confirm'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(null)}
                    className="text-surface-400 hover:text-surface-300 transition-colors"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-3 min-w-0">
                    <KeyRound className="h-3.5 w-3.5 text-surface-400 shrink-0" />
                    <span className="font-mono text-sm font-medium text-surface-200 truncate">{key}</span>
                    <span className="text-xs text-surface-500 font-mono">********</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(key)}
                    title="Delete secret"
                    className="p-1 text-surface-400 hover:text-red-400 transition-colors shrink-0"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
