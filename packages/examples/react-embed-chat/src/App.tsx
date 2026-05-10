import {
  CtxmillComposer,
  CtxmillHITL,
  CtxmillProvider,
  CtxmillThread,
  useCtxmillChat,
  type CtxmillA2UIComponents,
} from '@ctxmill/react';
import { useMemo, useState } from 'react';

const defaultApiBase = import.meta.env.VITE_CTXMILL_API_BASE || '/api';
const defaultAgentId = import.meta.env.VITE_CTXMILL_AGENT_ID || '';

function CustomerCard(props: Record<string, unknown>) {
  return (
    <div className="customer-card">
      <div>
        <div className="eyebrow">Customer</div>
        <h3>{String(props.name ?? 'Acme Finance')}</h3>
      </div>
      <dl>
        <div>
          <dt>Plan</dt>
          <dd>{String(props.plan ?? 'Enterprise')}</dd>
        </div>
        <div>
          <dt>Health</dt>
          <dd>{String(props.health ?? 'Watching')}</dd>
        </div>
        <div>
          <dt>ARR</dt>
          <dd>{String(props.arr ?? '$128k')}</dd>
        </div>
      </dl>
    </div>
  );
}

function ChatSurface({ agentId, apiBase, components }: { agentId: string; apiBase: string; components: CtxmillA2UIComponents }) {
  const chat = useCtxmillChat({ agentId, apiBase });
  const examples = [
    'Show a MetricCard using a2ui-render for active incidents and explain the signal.',
    'Use a2ui-render to show a BarChart of revenue by month, then summarize the trend.',
    'Ask for human approval before continuing with a production deployment.',
  ];

  return (
    <section className="chat-shell" aria-label="Embedded CTXMill chat">
      <div className="chat-topbar">
        <div>
          <div className="eyebrow">Agent</div>
          <h1>{agentId}</h1>
        </div>
        <div className={chat.isRunning ? 'status running' : 'status idle'}>
          {chat.isRunning ? 'Running' : 'Idle'}
        </div>
      </div>

      {chat.messages.length === 0 ? (
        <div className="prompt-rack">
          {examples.map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => void chat.sendMessage(example)}
              disabled={chat.isRunning}
            >
              {example}
            </button>
          ))}
        </div>
      ) : null}

      <div className="thread-frame">
        <CtxmillThread messages={chat.messages} components={components} />
      </div>

      {chat.pendingHitl ? (
        <CtxmillHITL request={chat.pendingHitl} onResolve={chat.resolveHitl} />
      ) : null}

      {chat.error ? <div className="error-strip">{chat.error}</div> : null}

      <CtxmillComposer
        onSend={chat.sendMessage}
        disabled={chat.isRunning || Boolean(chat.pendingHitl)}
        placeholder="Ask for a chart, a table, or an approval step..."
      />
    </section>
  );
}

export function App() {
  const [agentId, setAgentId] = useState(defaultAgentId);
  const [apiBase, setApiBase] = useState(defaultApiBase);
  const components = useMemo<CtxmillA2UIComponents>(() => ({
    CustomerCard,
    'crm.CustomerCard': CustomerCard,
  }), []);

  return (
    <CtxmillProvider apiBase={apiBase} components={components}>
      <main className="app-shell">
        <aside className="control-panel">
          <div>
            <div className="eyebrow">CTXMill</div>
            <h2>React embed console</h2>
          </div>

          <label>
            <span>API base</span>
            <input value={apiBase} onChange={(event) => setApiBase(event.currentTarget.value)} />
          </label>

          <label>
            <span>Agent ID</span>
            <input value={agentId} onChange={(event) => setAgentId(event.currentTarget.value)} placeholder="agent uuid" />
          </label>

          <div className="checklist">
            <span>AG-UI stream</span>
            <span>HITL card</span>
            <span>A2UI registry</span>
            <span>Reconnect-ready run IDs</span>
          </div>
        </aside>

        {agentId.trim() ? (
          <ChatSurface agentId={agentId.trim()} apiBase={apiBase} components={components} />
        ) : (
          <section className="empty-panel">
            <h1>Set an agent ID</h1>
            <p>The chat surface mounts after an agent is selected.</p>
          </section>
        )}
      </main>
    </CtxmillProvider>
  );
}
