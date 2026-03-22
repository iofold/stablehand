import { useEffect, useState } from 'react';
import {
  Settings,
  Server,
  Cpu,
  Database,
  Loader2,
} from 'lucide-react';
import { fetchConfig } from '@/lib/api';

interface ConfigData {
  llm?: {
    provider?: string;
    model?: string;
    baseUrl?: string;
  };
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

export function SettingsPage() {
  const [config, setConfig] = useState<ConfigData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
            {/* LLM Configuration */}
            <div className="card p-0">
              <div className="flex items-center gap-3 border-b border-surface-700 px-5 py-4">
                <Cpu className="h-5 w-5 text-accent-400" />
                <div>
                  <h3 className="text-sm font-semibold text-surface-100">LLM Configuration</h3>
                  <p className="text-xs text-surface-400">Language model provider settings</p>
                </div>
              </div>
              <div className="divide-y divide-surface-700/50">
                <ConfigRow label="Provider" value={config?.llm?.provider} />
                <ConfigRow label="Model" value={config?.llm?.model} />
                <ConfigRow label="Base URL" value={config?.llm?.baseUrl} mono />
              </div>
            </div>

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
