import {
  StablehandAgUiClient,
  createStablehandId,
  createUserMessage,
  type StablehandA2UIBlock,
  type StablehandClientOptions,
  type StablehandInterruptRequest,
} from '@stablehand/client';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from 'react';

import {
  createInitialChatState,
  reduceStablehandChatState,
  toStablehandMessages,
  type StablehandA2UIPart,
  type StablehandChatMessage,
  type StablehandChatPart,
  type StablehandChatState,
  type StablehandRunPhase,
  type StablehandToolCallPart,
} from './state.js';

type A2UIComponent = ComponentType<Record<string, unknown>>;
export type StablehandA2UIComponents = Record<string, A2UIComponent>;

interface StablehandContextValue {
  client?: StablehandAgUiClient;
  components: StablehandA2UIComponents;
}

const StablehandContext = createContext<StablehandContextValue>({ components: {} });

const palette = {
  panel: '#171b1f',
  panelRaised: '#20262b',
  border: '#333c43',
  text: '#ecf2ee',
  muted: '#9aa6a0',
  accent: '#6fd3a2',
  warn: '#f3b35b',
  danger: '#ff7b7b',
};

const styles: Record<string, CSSProperties> = {
  shell: {
    display: 'flex',
    minHeight: 520,
    flexDirection: 'column',
    background: palette.panel,
    color: palette.text,
    border: `1px solid ${palette.border}`,
    borderRadius: 8,
    overflow: 'hidden',
    fontFamily: 'ui-sans-serif, system-ui, sans-serif',
  },
  thread: {
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    padding: 20,
  },
  message: {
    marginBottom: 18,
  },
  userBubble: {
    marginLeft: 'auto',
    maxWidth: '76%',
    padding: '10px 12px',
    borderRadius: 8,
    background: '#293239',
    border: `1px solid ${palette.border}`,
    color: palette.text,
    whiteSpace: 'pre-wrap',
  },
  assistantBubble: {
    maxWidth: '86%',
    paddingLeft: 14,
    borderLeft: `2px solid ${palette.accent}`,
  },
  composer: {
    display: 'flex',
    gap: 10,
    padding: 14,
    borderTop: `1px solid ${palette.border}`,
    background: palette.panelRaised,
  },
  input: {
    flex: 1,
    minHeight: 42,
    resize: 'vertical',
    border: `1px solid ${palette.border}`,
    borderRadius: 8,
    background: '#111518',
    color: palette.text,
    padding: '10px 12px',
  },
  button: {
    border: `1px solid ${palette.border}`,
    borderRadius: 8,
    background: palette.accent,
    color: '#08110d',
    padding: '0 14px',
    fontWeight: 700,
    cursor: 'pointer',
  },
  secondaryButton: {
    border: `1px solid ${palette.border}`,
    borderRadius: 8,
    background: '#111518',
    color: palette.text,
    padding: '9px 12px',
    fontWeight: 700,
    cursor: 'pointer',
  },
  card: {
    border: `1px solid ${palette.border}`,
    borderRadius: 8,
    background: palette.panelRaised,
    padding: 14,
    marginTop: 10,
  },
};

// Keyframes for the streaming caret, thinking dots, and running-tool pulse.
// Rendered as a <style> tag by StablehandThread; duplicate tags are harmless.
const ANIMATION_CSS = `
@keyframes stablehand-caret-blink { 0%, 55% { opacity: 1; } 56%, 100% { opacity: 0; } }
@keyframes stablehand-dot-bounce { 0%, 80%, 100% { transform: translateY(0); opacity: .45; } 40% { transform: translateY(-3px); opacity: 1; } }
@keyframes stablehand-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
`;

function StreamingCaret() {
  return (
    <span
      aria-hidden
      style={{
        display: 'inline-block',
        width: 8,
        height: 15,
        marginLeft: 2,
        verticalAlign: 'text-bottom',
        borderRadius: 2,
        background: palette.accent,
        animation: 'stablehand-caret-blink 1s steps(1) infinite',
      }}
    />
  );
}

const PHASE_LABELS: Partial<Record<StablehandRunPhase, string>> = {
  submitted: 'Sending…',
  provisioning: 'Starting sandbox…',
  thinking: 'Thinking…',
  tool: 'Running tools…',
};

function ThinkingIndicator({ phase }: { phase: StablehandRunPhase }) {
  const label = PHASE_LABELS[phase] ?? 'Working…';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: palette.muted, paddingLeft: 14 }}>
      <span style={{ display: 'inline-flex', gap: 4 }}>
        {[0, 1, 2].map((dot) => (
          <span
            key={dot}
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: palette.accent,
              animation: `stablehand-dot-bounce 1.2s ease-in-out ${dot * 0.16}s infinite`,
            }}
          />
        ))}
      </span>
      <span style={{ fontSize: 13 }}>{label}</span>
    </div>
  );
}

function isRecordArray(value: unknown): value is Array<Record<string, unknown>> {
  return Array.isArray(value) && value.every((entry) => entry !== null && typeof entry === 'object' && !Array.isArray(entry));
}

function valueToText(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value == null) return '';
  return JSON.stringify(value);
}

function MetricCard(props: Record<string, unknown>) {
  return (
    <div style={styles.card}>
      <div style={{ color: palette.muted, fontSize: 12, marginBottom: 6 }}>{valueToText(props.title ?? 'Metric')}</div>
      <div style={{ fontSize: 28, fontWeight: 800 }}>{valueToText(props.value)}</div>
      {props.description ? <div style={{ color: palette.muted, marginTop: 8 }}>{valueToText(props.description)}</div> : null}
    </div>
  );
}

function TableView(props: Record<string, unknown>) {
  const rows = isRecordArray(props.data) ? props.data : [];
  const columns = Array.isArray(props.columns)
    ? props.columns.map((column) => valueToText(column)).filter(Boolean)
    : Object.keys(rows[0] ?? {});
  return (
    <div style={{ ...styles.card, overflowX: 'auto' }}>
      {props.title ? <div style={{ fontWeight: 700, marginBottom: 10 }}>{valueToText(props.title)}</div> : null}
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column} style={{ textAlign: 'left', color: palette.muted, borderBottom: `1px solid ${palette.border}`, padding: '6px 8px' }}>
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {columns.map((column) => (
                <td key={column} style={{ borderBottom: `1px solid ${palette.border}`, padding: '7px 8px' }}>
                  {valueToText(row[column])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BarChart(props: Record<string, unknown>) {
  const rows = isRecordArray(props.data) ? props.data : [];
  const xKey = typeof props.xKey === 'string' ? props.xKey : 'name';
  const yKey = typeof props.yKey === 'string' ? props.yKey : 'value';
  const values = rows.map((row) => Number(row[yKey])).filter((value) => Number.isFinite(value));
  const max = Math.max(1, ...values);
  return (
    <div style={styles.card}>
      {props.title ? <div style={{ fontWeight: 700, marginBottom: 12 }}>{valueToText(props.title)}</div> : null}
      <div style={{ display: 'grid', gap: 8 }}>
        {rows.map((row, index) => {
          const value = Number(row[yKey]);
          const width = Number.isFinite(value) ? `${Math.max(4, (value / max) * 100)}%` : '4%';
          return (
            <div key={index} style={{ display: 'grid', gridTemplateColumns: '96px 1fr 56px', gap: 8, alignItems: 'center' }}>
              <span style={{ color: palette.muted, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis' }}>{valueToText(row[xKey])}</span>
              <span style={{ height: 12, borderRadius: 999, background: '#101417', overflow: 'hidden' }}>
                <span style={{ display: 'block', width, height: '100%', background: palette.accent }} />
              </span>
              <span style={{ color: palette.text, fontVariantNumeric: 'tabular-nums', fontSize: 12 }}>{Number.isFinite(value) ? value : ''}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const defaultComponents: StablehandA2UIComponents = {
  MetricCard,
  TableView,
  BarChart,
  LineChart: BarChart,
  AreaChart: BarChart,
  TimeSeriesChart: BarChart,
};

export function StablehandProvider({
  client,
  apiBase,
  headers,
  credentials,
  components,
  children,
}: {
  client?: StablehandAgUiClient;
  apiBase?: string;
  headers?: StablehandClientOptions['headers'];
  credentials?: StablehandClientOptions['credentials'];
  components?: StablehandA2UIComponents;
  children: ReactNode;
}) {
  const resolvedClient = useMemo(
    () => client ?? new StablehandAgUiClient({ apiBase, headers, credentials }),
    [apiBase, client, credentials, headers],
  );
  const value = useMemo(
    () => ({ client: resolvedClient, components: { ...defaultComponents, ...components } }),
    [components, resolvedClient],
  );
  return <StablehandContext.Provider value={value}>{children}</StablehandContext.Provider>;
}

export function useStablehandA2UIComponents(extra?: StablehandA2UIComponents): StablehandA2UIComponents {
  const context = useContext(StablehandContext);
  return useMemo(() => ({ ...defaultComponents, ...context.components, ...extra }), [context.components, extra]);
}

export function StablehandA2UI({ block, components }: { block: StablehandA2UIBlock; components?: StablehandA2UIComponents }) {
  const registry = useStablehandA2UIComponents(components);
  const Component = registry[block.component] ?? registry[`charts:${block.component}`] ?? registry[`stablehand.charts:${block.component}`];
  if (!Component) {
    return (
      <div style={styles.card}>
        <div style={{ color: palette.warn, marginBottom: 8 }}>Unknown A2UI component: {block.component}</div>
        <pre style={{ whiteSpace: 'pre-wrap', margin: 0, color: palette.muted }}>{JSON.stringify(block.props, null, 2)}</pre>
      </div>
    );
  }
  return <Component {...block.props} />;
}

function ToolCall({ part }: { part: StablehandToolCallPart }) {
  const running = part.status === 'running';
  return (
    <details style={styles.card} open={running}>
      <summary style={{ cursor: 'pointer', color: part.status === 'error' ? palette.danger : palette.accent }}>
        {running ? (
          <span
            aria-hidden
            style={{
              display: 'inline-block',
              width: 8,
              height: 8,
              marginRight: 8,
              borderRadius: '50%',
              background: palette.warn,
              animation: 'stablehand-pulse 1.1s ease-in-out infinite',
            }}
          />
        ) : null}
        {part.name} {part.status}
      </summary>
      {part.args ? <pre style={{ whiteSpace: 'pre-wrap', color: palette.muted }}>{part.args}</pre> : null}
      {part.result ? <pre style={{ whiteSpace: 'pre-wrap', color: palette.text }}>{part.result}</pre> : null}
    </details>
  );
}

function MessagePart({
  part,
  components,
  streaming,
}: {
  part: StablehandChatPart;
  components?: StablehandA2UIComponents;
  streaming?: boolean;
}) {
  if (part.type === 'text') {
    return (
      <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
        {part.content}
        {streaming ? <StreamingCaret /> : null}
      </div>
    );
  }
  if (part.type === 'tool_call') {
    return <ToolCall part={part} />;
  }
  return <StablehandA2UI block={(part as StablehandA2UIPart).block} components={components} />;
}

export function StablehandThread({
  messages,
  components,
  isRunning,
  phase = 'idle',
  activeMessageId,
}: {
  messages: StablehandChatMessage[];
  components?: StablehandA2UIComponents;
  /** Show run-in-progress feedback (thinking indicator, streaming caret). */
  isRunning?: boolean;
  phase?: StablehandRunPhase;
  /** The assistant message currently receiving streamed text. */
  activeMessageId?: string | null;
}) {
  const endRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);

  // Follow the stream only while the user is already at the bottom; an
  // IntersectionObserver on the end sentinel tracks whether they scrolled
  // away, so we never yank them back down mid-read.
  useEffect(() => {
    const el = endRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) stickToBottomRef.current = entry.isIntersecting;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const lastMessage = messages[messages.length - 1];
  const lastContentLength = lastMessage ? lastMessage.content.length + lastMessage.parts.length : 0;
  useEffect(() => {
    if (!stickToBottomRef.current) return;
    endRef.current?.scrollIntoView({ block: 'nearest' });
  }, [messages.length, lastContentLength, isRunning, phase]);

  const showThinking = Boolean(isRunning) && phase !== 'streaming' && phase !== 'idle';

  return (
    <div style={styles.thread}>
      <style>{ANIMATION_CSS}</style>
      {messages.map((message) => {
        const streamingThis = phase === 'streaming' && message.id === activeMessageId;
        const lastTextIndex = streamingThis
          ? message.parts.reduce((last, part, index) => (part.type === 'text' ? index : last), -1)
          : -1;
        return (
          <div key={message.id} style={styles.message}>
            {message.role === 'user' ? (
              <div style={styles.userBubble}>{message.content}</div>
            ) : (
              <div style={styles.assistantBubble}>
                {message.parts.map((part, index) => (
                  <MessagePart
                    key={`${message.id}-${index}`}
                    part={part}
                    components={components}
                    streaming={index === lastTextIndex}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
      {showThinking ? <ThinkingIndicator phase={phase} /> : null}
      <div ref={endRef} />
    </div>
  );
}

export function StablehandHITL({
  request,
  onResolve,
  disabled,
}: {
  request: StablehandInterruptRequest;
  // ctx-iqzy: 'submit' was removed server-side; approve/reject only.
  onResolve: (action: 'approve' | 'reject', data?: unknown) => void | Promise<void>;
  disabled?: boolean;
}) {
  const reason = typeof request.args.reason === 'string' ? request.args.reason : request.toolName;
  return (
    <div style={{ ...styles.card, borderColor: palette.warn, margin: '0 14px 14px' }}>
      <div style={{ color: palette.warn, fontWeight: 800, marginBottom: 6 }}>Human approval required</div>
      <div style={{ marginBottom: 10 }}>{reason}</div>
      <pre style={{ whiteSpace: 'pre-wrap', color: palette.muted, maxHeight: 160, overflow: 'auto' }}>
        {JSON.stringify(request.args.details ?? request.args, null, 2)}
      </pre>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" style={styles.button} disabled={disabled} onClick={() => void onResolve('approve')}>
          Approve
        </button>
        <button type="button" style={styles.secondaryButton} disabled={disabled} onClick={() => void onResolve('reject')}>
          Reject
        </button>
      </div>
    </div>
  );
}

export function StablehandComposer({
  onSend,
  disabled,
  placeholder = 'Ask the agent...',
}: {
  onSend: (content: string) => void | Promise<void>;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [value, setValue] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const content = value.trim();
    if (!content || disabled) return;
    setValue('');
    await onSend(content);
  };
  return (
    <form style={styles.composer} onSubmit={(event) => void submit(event)}>
      <textarea
        value={value}
        onChange={(event) => setValue(event.currentTarget.value)}
        placeholder={placeholder}
        disabled={disabled}
        style={styles.input}
      />
      <button type="submit" style={styles.button} disabled={disabled || value.trim().length === 0}>
        Send
      </button>
    </form>
  );
}

export interface UseStablehandChatOptions extends StablehandClientOptions {
  agentId: string;
  threadId?: string;
  client?: StablehandAgUiClient;
}

export function useStablehandChat(options: UseStablehandChatOptions) {
  const context = useContext(StablehandContext);
  const { agentId, apiBase, client: providedClient, credentials, headers, threadId } = options;
  const client = useMemo(
    () => providedClient ?? context.client ?? new StablehandAgUiClient({ apiBase, credentials, headers }),
    [apiBase, context.client, credentials, headers, providedClient],
  );
  const [state, dispatch] = useReducer(reduceStablehandChatState, undefined, () => createInitialChatState(threadId));
  const stateRef = useRef<StablehandChatState>(state);
  const abortRef = useRef<AbortController | null>(null);
  const identityRef = useRef({ agentId, threadId });
  const identityVersionRef = useRef(0);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    const previous = identityRef.current;
    if (previous.agentId === agentId && previous.threadId === threadId) {
      return;
    }

    identityRef.current = { agentId, threadId };
    identityVersionRef.current += 1;
    const activeController = abortRef.current;
    abortRef.current = null;
    activeController?.abort();

    const nextState = createInitialChatState(threadId);
    stateRef.current = nextState;
    dispatch({ type: 'reset', threadId: nextState.threadId });
  }, [agentId, threadId]);

  useEffect(() => () => {
    identityVersionRef.current += 1;
    const activeController = abortRef.current;
    abortRef.current = null;
    activeController?.abort();
  }, []);

  const stop = useCallback(() => {
    const activeController = abortRef.current;
    if (!activeController) return;
    abortRef.current = null;
    activeController.abort();
    dispatch({ type: 'run_settled' });
  }, []);

  const sendMessage = useCallback(async (content: string) => {
    const userMessage = createUserMessage(content);
    dispatch({ type: 'append_user_message', message: userMessage });
    const runId = createStablehandId('turn');
    const controller = new AbortController();
    const identityVersion = identityVersionRef.current;
    abortRef.current?.abort();
    abortRef.current = controller;

    const isActiveRun = () => (
      identityVersionRef.current === identityVersion
      && abortRef.current === controller
    );

    try {
      const messages = [...toStablehandMessages(stateRef.current.messages), userMessage];
      for await (const event of client.streamAgentRun({
        agentId,
        threadId: stateRef.current.threadId,
        runId,
        messages,
        signal: controller.signal,
      })) {
        if (isActiveRun() && !controller.signal.aborted) {
          dispatch({ type: 'stream_event', event });
        }
      }
    } catch (err) {
      if (isActiveRun() && !controller.signal.aborted) {
        dispatch({ type: 'set_error', error: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      // Covers stop()/aborts and streams that close without RUN_FINISHED —
      // otherwise isRunning wedges true and the composer stays disabled.
      if (isActiveRun()) {
        dispatch({ type: 'run_settled' });
        abortRef.current = null;
      }
    }
  }, [agentId, client]);

  const resolveHitl = useCallback(async (action: 'approve' | 'reject', data?: unknown) => {
    const request = stateRef.current.pendingHitl;
    if (!request) return;
    await client.resolveInterrupt({
      agentId: request.agentId,
      interruptId: request.interruptId,
      action,
      data,
    });
    dispatch({ type: 'hitl_resolved', interruptId: request.interruptId });
  }, [agentId, client]);

  return {
    ...state,
    sendMessage,
    resolveHitl,
    stop,
  };
}

export function StablehandChat({
  agentId,
  threadId,
  client,
  apiBase,
  headers,
  credentials,
  components,
  placeholder,
}: UseStablehandChatOptions & {
  components?: StablehandA2UIComponents;
  placeholder?: string;
}) {
  const chat = useStablehandChat({ agentId, threadId, client, apiBase, headers, credentials });
  return (
    <div style={styles.shell}>
      <StablehandThread
        messages={chat.messages}
        components={components}
        isRunning={chat.isRunning}
        phase={chat.runPhase}
        activeMessageId={chat.activeAssistantMessageId}
      />
      {chat.pendingHitl ? <StablehandHITL request={chat.pendingHitl} onResolve={chat.resolveHitl} /> : null}
      {chat.error ? <div style={{ color: palette.danger, padding: '0 14px 14px' }}>{chat.error}</div> : null}
      <StablehandComposer onSend={chat.sendMessage} disabled={chat.isRunning || Boolean(chat.pendingHitl)} placeholder={placeholder} />
    </div>
  );
}
