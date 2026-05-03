import { useEffect, useState, useCallback } from 'react';
import type { ReactNode } from 'react';
import {
  Settings,
  Server,
  Database,
  Loader2,
  HardDrive,
  Timer,
  Layers,
  Box,
  type LucideIcon,
} from 'lucide-react';
import { fetchConfig, fetchSettings, updateSettings } from '@/lib/api';
import type { SystemSettings } from '@/lib/api';

interface ConfigData {
  system?: {
    version?: string;
    uptime?: number;
    dbPath?: string;
  };
  agentDefaults?: {
    harness?: string;
    model?: string;
    temperature?: number;
    maxTokens?: number;
  };
  [key: string]: unknown;
}

function formatUptime(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h`;
}

function RestartBadge() {
  return (
    <span className="inline-flex items-center rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-400 ring-1 ring-inset ring-amber-500/25">Restart required</span>
  );
}

function SettingsSection({
  icon: Icon,
  title,
  description,
  restartRequired = false,
  wide = false,
  settingsLoading,
  settings,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  restartRequired?: boolean;
  wide?: boolean;
  settingsLoading: boolean;
  settings: SystemSettings | null;
  children: ReactNode;
}) {
  return (
    <div className={`card p-0 ${wide ? 'lg:col-span-2' : ''}`}>
      <div className="flex items-center gap-3 border-b border-surface-700 px-5 py-4">
        <Icon className="h-5 w-5 text-accent-400" />
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-surface-100">{title}</h3>
            {restartRequired && <RestartBadge />}
          </div>
          <p className="text-xs text-surface-400">{description}</p>
        </div>
      </div>
      {settingsLoading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 text-accent-400 animate-spin" />
        </div>
      ) : !settings ? (
        <div className="px-5 py-4 text-sm text-red-400">Failed to load system settings.</div>
      ) : (
        <div className="divide-y divide-surface-700/50">{children}</div>
      )}
    </div>
  );
}

export function SettingsPage() {
  const [config, setConfig] = useState<ConfigData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [settings, setSettings] = useState<SystemSettings | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  // Draft values in MB (what the user types)
  const [draftTarMb, setDraftTarMb] = useState('');
  const [draftCheckpointMb, setDraftCheckpointMb] = useState('');
  const [draftUploadMb, setDraftUploadMb] = useState('');
  // Session Lifecycle (stored as ms, displayed as seconds)
  const [draftIdleSec, setDraftIdleSec] = useState('');
  const [draftTurnSec, setDraftTurnSec] = useState('');
  const [draftReconcileSec, setDraftReconcileSec] = useState('');
  // Concurrency (stored as-is)
  const [draftMaxContainers, setDraftMaxContainers] = useState('');
  const [draftQueueSec, setDraftQueueSec] = useState('');
  const [draftMaxRunsPerAgent, setDraftMaxRunsPerAgent] = useState('');
  const [draftTriggerDepth, setDraftTriggerDepth] = useState('');
  // Container Resources
  const [draftCpus, setDraftCpus] = useState('');
  const [draftMemoryMb, setDraftMemoryMb] = useState('');
  const [draftPidsLimit, setDraftPidsLimit] = useState('');
  const [draftTimeoutSec, setDraftTimeoutSec] = useState('');

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    fetchConfig()
      .then((data) => {
        if (mounted) setConfig(data);
      })
      .catch(() => {
        if (mounted) setError('Configuration not available');
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    setSettingsLoading(true);
    fetchSettings()
      .then((s) => {
        if (!mounted) return;
        setSettings(s);
        setDraftTarMb(String(Math.round(s.maxWorkspaceTarBytes / (1024 * 1024))));
        setDraftCheckpointMb(String(Math.round(s.maxCheckpointBytes / (1024 * 1024))));
        setDraftUploadMb(String(Math.round(s.maxTarUploadBytes / (1024 * 1024))));
        setDraftIdleSec(String(Math.round(s.idleTimeoutMs / 1000)));
        setDraftTurnSec(String(Math.round(s.turnTimeoutMs / 1000)));
        setDraftReconcileSec(String(Math.round(s.reconciliationIntervalMs / 1000)));
        setDraftMaxContainers(String(s.maxGlobalContainers));
        setDraftQueueSec(String(Math.round(s.queueTimeoutMs / 1000)));
        setDraftMaxRunsPerAgent(String(s.maxConcurrentSessionsPerAgent));
        setDraftTriggerDepth(String(s.maxTriggerDepth));
        setDraftCpus(String(s.defaultCpus));
        setDraftMemoryMb(String(s.defaultMemoryMb));
        setDraftPidsLimit(String(s.defaultPidsLimit));
        setDraftTimeoutSec(String(s.defaultTimeoutSec));
      })
      .catch((err) => { console.error('Failed to load settings:', err); setSettingsLoading(false); })
      .finally(() => { if (mounted) setSettingsLoading(false); });
    return () => { mounted = false; };
  }, []);

  const handleSaveSettings = useCallback(async () => {
    if (!window.confirm('Save all settings? Some changes may require a restart to take effect.')) return;
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(false);
    try {
      const MB = 1024 * 1024;
      const S = 1000;
      const updated = await updateSettings({
        maxWorkspaceTarBytes:      Math.round(Number(draftTarMb) * MB),
        maxCheckpointBytes:        Math.round(Number(draftCheckpointMb) * MB),
        maxTarUploadBytes:         Math.round(Number(draftUploadMb) * MB),
        idleTimeoutMs:             Math.round(Number(draftIdleSec) * S),
        turnTimeoutMs:             Math.round(Number(draftTurnSec) * S),
        reconciliationIntervalMs:  Math.round(Number(draftReconcileSec) * S),
        maxGlobalContainers:       Math.round(Number(draftMaxContainers)),
        queueTimeoutMs:            Math.round(Number(draftQueueSec) * S),
        maxConcurrentSessionsPerAgent: Math.round(Number(draftMaxRunsPerAgent)),
        maxTriggerDepth:           Math.round(Number(draftTriggerDepth)),
        defaultCpus:               Number(draftCpus),
        defaultMemoryMb:           Math.round(Number(draftMemoryMb)),
        defaultPidsLimit:          Math.round(Number(draftPidsLimit)),
        defaultTimeoutSec:         Math.round(Number(draftTimeoutSec)),
      });
      setSettings(updated);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err) {
      setSaveError(String(err));
    } finally {
      setSaving(false);
    }
  }, [
    draftTarMb, draftCheckpointMb, draftUploadMb,
    draftIdleSec, draftTurnSec, draftReconcileSec,
    draftMaxContainers, draftQueueSec, draftMaxRunsPerAgent, draftTriggerDepth,
    draftCpus, draftMemoryMb, draftPidsLimit, draftTimeoutSec,
  ]);

  return (
    <div className="flex min-h-screen flex-col bg-surface-950">
      <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-5 space-y-6">
        {/* Header */}
        <div>
          <div className="flex items-center gap-3">
            <Settings className="h-6 w-6 text-surface-400" />
            <div>
              <h2 className="text-2xl font-semibold tracking-tight text-surface-200">
                Settings
              </h2>
              <p className="mt-1.5 text-sm text-surface-400 max-w-lg">
                System configuration and defaults.
              </p>
            </div>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-6 w-6 text-accent-400 animate-spin" />
          </div>
        ) : error && !config ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <Settings className="h-8 w-8 text-surface-400 mb-3" />
            <p className="text-sm text-surface-400">{error}</p>
            <p className="text-xs text-surface-400 mt-1">
              The configuration API may not be available yet.
            </p>
          </div>
        ) : (
          <div className="grid gap-6 lg:grid-cols-2">
            {/* System Info */}
            <div className="card p-0">
              <div className="flex items-center gap-3 border-b border-surface-700 px-5 py-4">
                <Server className="h-5 w-5 text-accent-400" />
                <div>
                  <h3 className="text-sm font-semibold text-surface-100">System Info</h3>
                  <p className="text-xs text-surface-400">Runtime and environment details</p>
                </div>
              </div>
              <div className="divide-y divide-surface-700/50">
                <ConfigRow label="Version" value={config?.system?.version} />
                <ConfigRow
                  label="Uptime"
                  value={config?.system?.uptime != null ? formatUptime(config.system.uptime) : undefined}
                />
                <ConfigRow label="Database Path" value={config?.system?.dbPath} mono />
              </div>
            </div>

            {/* Agent Defaults */}
            <div className="card p-0 lg:col-span-2">
              <div className="flex items-center gap-3 border-b border-surface-700 px-5 py-4">
                <Database className="h-5 w-5 text-accent-400" />
                <div>
                  <h3 className="text-sm font-semibold text-surface-100">Agent Defaults</h3>
                  <p className="text-xs text-surface-400">Default configuration for new agents</p>
                </div>
              </div>
              <div className="divide-y divide-surface-700/50">
                <ConfigRow label="Default Harness" value={config?.agentDefaults?.harness} />
                <ConfigRow label="Default Model" value={config?.agentDefaults?.model} />
                <ConfigRow
                  label="Temperature"
                  value={config?.agentDefaults?.temperature != null ? String(config.agentDefaults.temperature) : undefined}
                />
                <ConfigRow
                  label="Max Tokens"
                  value={config?.agentDefaults?.maxTokens != null ? String(config.agentDefaults.maxTokens) : undefined}
                />
              </div>
            </div>

            <SettingsSection
              icon={HardDrive}
              title="Workspace Limits"
              description="Size limits for workspace snapshots and uploads"
              wide
              settingsLoading={settingsLoading}
              settings={settings}
            >
              <LimitRow label="Max Workspace Snapshot" description="Maximum size of the workspace tar snapshot captured on suspend" value={draftTarMb} onChange={setDraftTarMb} min={1} max={1024} />
              <LimitRow label="Max Checkpoint State" description="Maximum size of the harness state checkpoint JSON" value={draftCheckpointMb} onChange={setDraftCheckpointMb} min={1} max={100} />
              <LimitRow label="Max Workspace Upload" description="Maximum total size of a workspace tarball uploaded via the Files tab (ADR 010)" value={draftUploadMb} onChange={setDraftUploadMb} min={1} max={1024} />
              <ReadonlyLimitRow
                label="Max Per-File (Workspace)"
                description="Per-file cap inside an uploaded workspace archive. Enforced by ADR 010 server-side."
                value="5"
                unit="MB"
                testId="setting-max-per-file"
              />
              <ReadonlyLimitRow
                label="Workspace Archive Format"
                description="Only .tar.gz / .tgz archives are accepted; symlinks and known executable types are rejected."
                value=".tar.gz"
                testId="setting-workspace-format"
              />
            </SettingsSection>

            <SettingsSection
              icon={Timer}
              title="Session Lifecycle"
              description="Container checkpoint and lifecycle timings"
              restartRequired
              wide
              settingsLoading={settingsLoading}
              settings={settings}
            >
              <LimitRow label="Idle Timeout" description="Seconds before an idle session is checkpointed (also governs HITL wait)" value={draftIdleSec} onChange={setDraftIdleSec} unit="s" min={10} max={3600} />
              <LimitRow label="Turn Timeout" description="Max seconds for a single agent turn" value={draftTurnSec} onChange={setDraftTurnSec} unit="s" min={10} max={3600} />
              <LimitRow label="Reconciliation Interval" description="Seconds between container state reconciliation sweeps" value={draftReconcileSec} onChange={setDraftReconcileSec} unit="s" min={10} max={3600} />
            </SettingsSection>

            <SettingsSection
              icon={Layers}
              title="Concurrency"
              description="Container and session concurrency limits"
              restartRequired
              settingsLoading={settingsLoading}
              settings={settings}
            >
              <LimitRow label="Max Global Containers" description="Max concurrent sandbox containers" value={draftMaxContainers} onChange={setDraftMaxContainers} unit="" min={1} max={200} />
              <LimitRow label="Queue Timeout" description="Seconds a session waits for a container slot" value={draftQueueSec} onChange={setDraftQueueSec} unit="s" min={1} max={300} />
              <LimitRow label="Max Sessions Per Agent" description="Max concurrent sessions per agent" value={draftMaxRunsPerAgent} onChange={setDraftMaxRunsPerAgent} unit="" min={1} max={50} />
              <LimitRow label="Max Trigger Depth" description="Max event chain cascade depth" value={draftTriggerDepth} onChange={setDraftTriggerDepth} unit="" min={1} max={20} />
            </SettingsSection>

            <SettingsSection
              icon={Box}
              title="Container Resources"
              description="Default resource limits for sandbox containers"
              restartRequired
              settingsLoading={settingsLoading}
              settings={settings}
            >
              <LimitRow label="Default CPU" description="Default CPU cores per container" value={draftCpus} onChange={setDraftCpus} unit="cores" step={0.5} min={0.25} max={8} />
              <LimitRow label="Default Memory" description="Default memory per container" value={draftMemoryMb} onChange={setDraftMemoryMb} unit="MB" min={64} max={8192} />
              <LimitRow label="Default PID Limit" description="Default process limit per container" value={draftPidsLimit} onChange={setDraftPidsLimit} unit="" min={32} max={4096} />
              <LimitRow label="Default Session Timeout" description="Default session timeout in seconds" value={draftTimeoutSec} onChange={setDraftTimeoutSec} unit="s" min={10} max={3600} />
            </SettingsSection>
          </div>
        )}
        
        {/* Shared Save Button */}
        {!loading && (!error || config) && (
          <div className="flex items-center justify-between pt-2">
            <div className="text-xs text-surface-400">
              {saveSuccess && <span className="text-green-400">Settings saved</span>}
              {saveError && <span className="text-red-400">Save failed: {saveError}</span>}
              {!saveSuccess && !saveError && (
                <span>Changes marked <span className="inline-flex items-center rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-400 ring-1 ring-inset ring-amber-500/25">Restart required</span> take effect after orchestrator restart</span>
              )}
            </div>
            <button
              type="button"
              onClick={handleSaveSettings}
              disabled={saving || settingsLoading}
              className="inline-flex items-center gap-1.5 rounded-lg bg-accent-600 px-4 py-2 text-sm font-medium text-white hover:bg-accent-500 transition-colors disabled:opacity-40"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {saving ? 'Saving…' : 'Save all settings'}
            </button>
          </div>
        )}
      </main>
    </div>
  );
}

function ConfigRow({
  label,
  value,
  mono,
}: {
  label: string;
  value?: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between px-5 py-3">
      <span className="text-xs text-surface-400">{label}</span>
      <span
        className={
          value
            ? `text-sm text-surface-200 ${mono ? 'font-mono text-xs' : ''}`
            : 'text-xs text-surface-400 italic'
        }
      >
        {value || 'Not configured'}
      </span>
    </div>
  );
}

function ReadonlyLimitRow({
  label,
  description,
  value,
  unit,
  testId,
}: {
  label: string;
  description: string;
  value: string;
  unit?: string;
  testId?: string;
}) {
  return (
    <div className="flex items-center justify-between px-5 py-3 gap-4" data-testid={testId}>
      <div className="min-w-0">
        <p className="text-xs font-medium text-surface-200">{label}</p>
        <p className="text-[11px] text-surface-400 mt-0.5">{description}</p>
      </div>
      <div className="flex items-center gap-1.5 flex-shrink-0">
        <span className="text-xs text-surface-300 font-mono tabular-nums">{value}</span>
        {unit && <span className="text-xs text-surface-400 w-8">{unit}</span>}
      </div>
    </div>
  );
}

function LimitRow({
  label,
  description,
  value,
  onChange,
  unit = 'MB',
  step,
  min,
  max,
}: {
  label: string;
  description: string;
  value: string;
  onChange: (v: string) => void;
  unit?: string;
  step?: number;
  min?: number;
  max?: number;
}) {
  return (
    <div className="flex items-center justify-between px-5 py-3 gap-4">
      <div className="min-w-0">
        <p className="text-xs font-medium text-surface-200">{label}</p>
        <p className="text-[11px] text-surface-400 mt-0.5">{description}</p>
      </div>
      <div className="flex items-center gap-1.5 flex-shrink-0">
        <input
          type="number"
          min={min ?? 0}
          max={max}
          value={value}
          step={step}
          onChange={(e) => onChange(e.target.value)}
          className="w-20 rounded-lg border border-surface-600/40 bg-surface-800/60 px-2 py-1 text-sm text-surface-200 text-right focus:outline-none focus:border-accent-500/50 focus:ring-1 focus:ring-accent-500/30"
        />
        {unit && <span className="text-xs text-surface-400 w-8">{unit}</span>}
      </div>
    </div>
  );
}
