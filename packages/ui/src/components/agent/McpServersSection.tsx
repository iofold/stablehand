import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, Loader2, Plug, RefreshCw, ShieldCheck, Unplug } from 'lucide-react';
import {
  connectMcpServer,
  disconnectMcpServer,
  fetchMcpServers,
  refreshMcpServer,
  type McpServerConnectResponse,
  type McpServerStatus,
} from '@/lib/api';
import { cn } from '@/lib/utils';

const STATE_LABELS: Record<McpServerStatus['state'], { label: string; className: string }> = {
  ready: { label: 'Ready', className: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/20' },
  needs_auth: { label: 'Needs sign-in', className: 'bg-amber-500/15 text-amber-300 border-amber-500/20' },
  error: { label: 'Not reachable', className: 'bg-red-500/15 text-red-300 border-red-500/20' },
  connecting: { label: 'Connecting', className: 'bg-surface-700/40 text-surface-300 border-surface-600/40' },
};

const AUTH_LABELS: Record<McpServerStatus['authType'], string> = {
  none: 'No sign-in',
  bearer: 'Token from a secret',
  header: 'Header from a secret',
  oauth: 'OAuth sign-in',
};

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * The agent's MCP servers as the orchestrator sees them: state, the tools
 * each one offers under plain names, and the OAuth connect flow. The sign-in
 * URL is shown with its host and opened only when the person clicks it.
 */
export function McpServersSection({ agentId }: { agentId: string }) {
  const [servers, setServers] = useState<McpServerStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingSignIn, setPendingSignIn] = useState<{ server: string; started: McpServerConnectResponse } | null>(null);

  const load = useCallback(async () => {
    try {
      setServers(await fetchMcpServers(agentId));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    void load();
  }, [load]);

  // While a sign-in is open in another tab, check back until it lands.
  useEffect(() => {
    if (!pendingSignIn) return;
    const timer = window.setInterval(() => {
      void fetchMcpServers(agentId).then((next) => {
        setServers(next);
        if (next.find((server) => server.name === pendingSignIn.server)?.connected) {
          setPendingSignIn(null);
        }
      }).catch((err: unknown) => {
        console.debug('[McpServersSection] status poll failed:', err);
      });
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [agentId, pendingSignIn]);

  const run = async (server: string, action: () => Promise<void>) => {
    setBusy(server);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return <p className="animate-pulse text-sm text-surface-400">Loading MCP servers...</p>;
  }
  if (servers.length === 0) return null;

  return (
    <section data-testid="mcp-servers-section" className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-surface-200">MCP servers</h3>
        <p className="mt-1 text-xs text-surface-400">
          Stablehand calls these servers for the agent and keeps their tokens. The agent never sees a token.
        </p>
      </div>
      {error && (
        <div className="rounded-lg border border-red-700/30 bg-red-900/10 px-4 py-2 text-sm text-red-300">{error}</div>
      )}
      <div className="space-y-3">
        {servers.map((server) => {
          const state = STATE_LABELS[server.state];
          const signIn = pendingSignIn?.server === server.name ? pendingSignIn.started : null;
          return (
            <div
              key={server.name}
              data-testid="mcp-server-card"
              className="space-y-3 rounded-lg border border-surface-700 bg-surface-800 px-4 py-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <h4 className="font-mono text-sm font-bold text-surface-200">{server.name}</h4>
                <span className="text-xs text-surface-400">{hostOf(server.url)}</span>
                <span className={cn('rounded border px-1.5 py-0.5 text-[11px]', state.className)}>{state.label}</span>
                <span className="text-[11px] text-surface-500">{AUTH_LABELS[server.authType]}</span>
                <div className="ml-auto flex flex-wrap gap-2">
                  {server.authType === 'oauth' && (
                    <button
                      type="button"
                      disabled={busy === server.name}
                      onClick={() => run(server.name, async () => {
                        const started = await connectMcpServer(agentId, server.name);
                        setPendingSignIn({ server: server.name, started });
                      })}
                      className="btn-secondary px-2.5 py-1 text-xs"
                    >
                      <Plug className="h-3.5 w-3.5" />
                      {server.connected ? 'Reconnect' : 'Connect'}
                    </button>
                  )}
                  {server.authType === 'oauth' && server.connected && (
                    <button
                      type="button"
                      disabled={busy === server.name}
                      onClick={() => run(server.name, async () => {
                        await disconnectMcpServer(agentId, server.name);
                        await load();
                      })}
                      className="btn-secondary px-2.5 py-1 text-xs"
                    >
                      <Unplug className="h-3.5 w-3.5" />
                      Disconnect
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={busy === server.name}
                    onClick={() => run(server.name, async () => {
                      setServers(await refreshMcpServer(agentId, server.name));
                    })}
                    className="btn-secondary px-2.5 py-1 text-xs"
                    aria-label={`Refresh ${server.name}`}
                  >
                    {busy === server.name
                      ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      : <RefreshCw className="h-3.5 w-3.5" />}
                    Refresh
                  </button>
                </div>
              </div>

              {server.message && <p className="text-xs text-surface-300">{server.message}</p>}

              {signIn && (
                <div data-testid="mcp-sign-in" className="rounded-md border border-accent-500/30 bg-accent-500/5 px-3 py-2 text-xs text-surface-200">
                  <p>
                    Sign in at <span className="font-semibold">{signIn.host}</span>. The link works for 10 minutes;
                    this card updates when the sign-in lands.
                  </p>
                  <p className="mt-1 break-all font-mono text-[11px] text-surface-400">{signIn.authorizationUrl}</p>
                  <a
                    href={signIn.authorizationUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-2 inline-flex items-center gap-1 text-accent-300 underline underline-offset-2"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    Open sign-in page
                  </a>
                </div>
              )}

              {server.tools.length > 0 && (
                <ul className="flex flex-wrap gap-1.5">
                  {server.tools.map((tool) => (
                    <li
                      key={tool.name}
                      title={tool.name}
                      className="inline-flex items-center gap-1 rounded-md border border-violet-500/20 bg-violet-500/10 px-2 py-0.5 text-xs text-violet-200"
                    >
                      {tool.displayName}
                      {tool.requiresApproval && (
                        <span className="inline-flex items-center gap-0.5 text-[10px] text-orange-300">
                          <ShieldCheck className="h-3 w-3" />
                          asks first
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
