import {
  CtxmillComposer,
  CtxmillHITL,
  CtxmillProvider,
  CtxmillThread,
  useCtxmillChat,
  type CtxmillA2UIComponents,
  type CtxmillRunPhase,
} from '@ctxmill/react';
import { AgentListResponseSchema, type Agent } from '@ctxmill/contracts';
import { KeyRound, LogOut, MessageSquarePlus, Plug, Square } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { chartComponents } from './charts';

const STORAGE_KEY = 'ctxmill-console-connection';
const DEFAULT_API_BASE = 'https://stablehand.staging.example.com/api';

const PHASE_CHIP_LABELS: Partial<Record<CtxmillRunPhase, string>> = {
  submitted: 'Sending',
  provisioning: 'Starting sandbox',
  thinking: 'Thinking',
  tool: 'Running tools',
  streaming: 'Streaming',
};

interface Connection {
  apiBase: string;
  token: string;
}

function loadConnection(): Connection | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Connection>;
    if (typeof parsed.apiBase === 'string' && typeof parsed.token === 'string') {
      return { apiBase: parsed.apiBase, token: parsed.token };
    }
  } catch {
    // fall through to null
  }
  return null;
}

function TokenGate({ onConnect }: { onConnect: (connection: Connection, agents: Agent[]) => void }) {
  const [apiBase, setApiBase] = useState(DEFAULT_API_BASE);
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const connect = useCallback(async (candidate: Connection) => {
    setChecking(true);
    setError(null);
    try {
      const base = candidate.apiBase.replace(/\/+$/, '');
      const res = await fetch(`${base}/agents`, {
        headers: { Authorization: `Bearer ${candidate.token}` },
      });
      if (res.status === 401) {
        throw new Error('Invalid token.');
      }
      if (!res.ok) {
        throw new Error(`API responded ${res.status}.`);
      }
      const agents = AgentListResponseSchema.parse(await res.json());
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ apiBase: base, token: candidate.token }));
      onConnect({ apiBase: base, token: candidate.token }, agents);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setChecking(false);
    }
  }, [onConnect]);

  // Resume a stored connection silently on load.
  useEffect(() => {
    const stored = loadConnection();
    if (stored) {
      setApiBase(stored.apiBase);
      setToken(stored.token);
      void connect(stored);
    }
  }, [connect]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-950 p-6">
      <form
        className="w-full max-w-md space-y-4 rounded-2xl border border-surface-700 bg-surface-800/60 p-8"
        onSubmit={(event) => {
          event.preventDefault();
          if (!token.trim()) {
            setError('Enter the API token.');
            return;
          }
          void connect({ apiBase, token: token.trim() });
        }}
      >
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-600/20 border border-accent-500/30">
            <KeyRound className="h-5 w-5 text-accent-300" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-surface-100">CTXMill Console</h1>
            <p className="text-xs text-surface-400">Connect to a CTXMill deployment to chat with its agents.</p>
          </div>
        </div>

        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-surface-300">API base URL</span>
          <input
            type="url"
            value={apiBase}
            onChange={(event) => setApiBase(event.currentTarget.value)}
            className="w-full rounded-lg border border-surface-600/40 bg-surface-900 px-3 py-2 text-sm text-surface-200 focus:outline-none focus:border-accent-500/60"
          />
        </label>

        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-surface-300">API token</span>
          <input
            type="password"
            value={token}
            onChange={(event) => setToken(event.currentTarget.value)}
            placeholder="CTXMILL_API_TOKEN"
            className="w-full rounded-lg border border-surface-600/40 bg-surface-900 px-3 py-2 font-mono text-sm text-surface-200 focus:outline-none focus:border-accent-500/60"
          />
        </label>

        {error && <p role="alert" className="text-xs text-red-300">{error}</p>}

        <button
          type="submit"
          disabled={checking}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-500 disabled:opacity-50"
        >
          <Plug className="h-4 w-4" />
          {checking ? 'Connecting…' : 'Connect'}
        </button>

        <p className="text-[11px] leading-relaxed text-surface-500">
          The token stays in this browser (localStorage) and is sent only to the API base above.
          Nothing is embedded in this page.
        </p>
      </form>
    </div>
  );
}

function ChatSurface({
  agent,
  connection,
  components,
}: {
  agent: Agent;
  connection: Connection;
  components: CtxmillA2UIComponents;
}) {
  // Remounting on threadKey gives a fresh conversation without a reload.
  const [threadKey, setThreadKey] = useState(0);
  return (
    <ChatSurfaceInner
      key={`${agent.id}-${threadKey}`}
      agent={agent}
      connection={connection}
      components={components}
      onNewConversation={() => setThreadKey((k) => k + 1)}
    />
  );
}

function ChatSurfaceInner({
  agent,
  connection,
  components,
  onNewConversation,
}: {
  agent: Agent;
  connection: Connection;
  components: CtxmillA2UIComponents;
  onNewConversation: () => void;
}) {
  const chat = useCtxmillChat({
    agentId: agent.id,
    apiBase: connection.apiBase,
    headers: () => ({ Authorization: `Bearer ${connection.token}` }),
  });

  const examples = [
    'Use a2ui-render to show a BarChart of quarterly revenue (make up plausible numbers), then summarize the trend.',
    'Show a MetricCard for active sandbox sessions and explain the number.',
    'Use a2ui-render to display a TableView of the top 5 open tasks with owner and due date.',
  ];

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-surface-700 px-5 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-surface-100">{agent.name}</h2>
          <p className="truncate text-[11px] text-surface-400">
            {agent.harness}
            {agent.description ? ` · ${agent.description}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className={chat.isRunning
            ? 'inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 border border-emerald-500/30 px-2 py-0.5 text-[11px] font-medium text-emerald-400'
            : 'inline-flex items-center gap-1.5 rounded-full bg-surface-700/40 border border-surface-600/50 px-2 py-0.5 text-[11px] font-medium text-surface-300'}
          >
            {chat.isRunning ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" /> : null}
            {PHASE_CHIP_LABELS[chat.runPhase] ?? 'Idle'}
          </span>
          {chat.isRunning ? (
            <button
              type="button"
              onClick={chat.stop}
              className="inline-flex items-center gap-1.5 rounded-lg border border-surface-600/60 bg-surface-800 px-2.5 py-1.5 text-xs font-medium text-surface-300 transition-colors hover:bg-surface-700 hover:text-surface-100"
            >
              <Square className="h-3 w-3" />
              Stop
            </button>
          ) : null}
          <button
            type="button"
            onClick={onNewConversation}
            className="inline-flex items-center gap-1.5 rounded-lg bg-surface-700 px-3 py-1.5 text-xs font-medium text-surface-100 transition-colors hover:bg-surface-600"
          >
            <MessageSquarePlus className="h-3.5 w-3.5" />
            New conversation
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {chat.messages.length === 0 ? (
          <div className="mx-auto mt-10 max-w-lg space-y-2">
            <p className="text-center text-sm text-surface-400">Try one of these:</p>
            {examples.map((example) => (
              <button
                key={example}
                type="button"
                onClick={() => void chat.sendMessage(example)}
                disabled={chat.isRunning}
                className="block w-full rounded-lg border border-surface-700/60 bg-surface-800/50 px-4 py-3 text-left text-sm text-surface-300 transition-colors hover:bg-surface-800 disabled:opacity-50"
              >
                {example}
              </button>
            ))}
          </div>
        ) : (
          <CtxmillThread
            messages={chat.messages}
            components={components}
            isRunning={chat.isRunning}
            phase={chat.runPhase}
            activeMessageId={chat.activeAssistantMessageId}
          />
        )}
      </div>

      {chat.pendingHitl ? (
        <div className="px-5 pb-2">
          <CtxmillHITL request={chat.pendingHitl} onResolve={chat.resolveHitl} />
        </div>
      ) : null}

      {chat.error ? (
        <div className="mx-5 mb-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {chat.error}
        </div>
      ) : null}

      <div className="border-t border-surface-700 px-5 py-3">
        <CtxmillComposer
          onSend={chat.sendMessage}
          disabled={chat.isRunning || Boolean(chat.pendingHitl)}
          placeholder="Ask for a chart, a table, or an approval step…"
        />
      </div>
    </section>
  );
}

export function App() {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const components = useMemo(() => chartComponents(), []);

  const handleConnect = useCallback((conn: Connection, agentList: Agent[]) => {
    setConnection(conn);
    setAgents(agentList);
    setSelectedId((prev) => prev ?? agentList[0]?.id ?? null);
  }, []);

  const disconnect = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setConnection(null);
    setAgents([]);
    setSelectedId(null);
  }, []);

  if (!connection) {
    return <TokenGate onConnect={handleConnect} />;
  }

  const selected = agents.find((agent) => agent.id === selectedId) ?? null;

  return (
    <CtxmillProvider
      apiBase={connection.apiBase}
      headers={() => ({ Authorization: `Bearer ${connection.token}` })}
      components={components}
    >
      <main className="flex h-screen bg-surface-950 text-surface-200">
        <aside className="flex w-64 flex-shrink-0 flex-col border-r border-surface-700">
          <div className="flex items-center justify-between border-b border-surface-700 px-4 py-3">
            <div>
              <p className="text-[10px] uppercase tracking-wider text-surface-500">CTXMill</p>
              <h1 className="text-sm font-semibold text-surface-100">Console</h1>
            </div>
            <button
              type="button"
              onClick={disconnect}
              title="Disconnect"
              aria-label="Disconnect"
              className="rounded-lg p-1.5 text-surface-400 transition-colors hover:bg-surface-800 hover:text-surface-200"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
          <p className="truncate border-b border-surface-700/50 px-4 py-2 font-mono text-[10px] text-surface-500" title={connection.apiBase}>
            {connection.apiBase}
          </p>
          <nav className="min-h-0 flex-1 overflow-y-auto p-2">
            {agents.map((agent) => (
              <button
                key={agent.id}
                type="button"
                onClick={() => setSelectedId(agent.id)}
                className={`mb-1 block w-full rounded-lg px-3 py-2 text-left transition-colors ${
                  agent.id === selectedId
                    ? 'bg-accent-600/20 border border-accent-500/30'
                    : 'border border-transparent hover:bg-surface-800'
                }`}
              >
                <p className="truncate text-sm font-medium text-surface-200">{agent.name}</p>
                <p className="truncate text-[11px] text-surface-500">{agent.harness}</p>
              </button>
            ))}
            {agents.length === 0 && (
              <p className="px-3 py-2 text-xs text-surface-500">No agents on this deployment.</p>
            )}
          </nav>
        </aside>

        {selected ? (
          <ChatSurface agent={selected} connection={connection} components={components} />
        ) : (
          <section className="flex flex-1 items-center justify-center">
            <p className="text-sm text-surface-400">Pick an agent to start chatting.</p>
          </section>
        )}
      </main>
    </CtxmillProvider>
  );
}
