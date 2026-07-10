export type CtxmillMessageRole = 'developer' | 'system' | 'assistant' | 'user' | 'tool';

export interface CtxmillMessage {
  id: string;
  role: CtxmillMessageRole;
  content?: string;
  name?: string;
  toolCallId?: string;
}

export interface CtxmillTool {
  name: string;
  description: string;
  parameters: unknown;
}

export interface CtxmillContextEntry {
  description: string;
  value: string;
}

export interface CtxmillRunInput {
  agentId: string;
  threadId?: string;
  runId?: string;
  messages: CtxmillMessage[];
  tools?: CtxmillTool[];
  context?: CtxmillContextEntry[];
  state?: unknown;
  forwardedProps?: unknown;
  signal?: AbortSignal;
}

export interface CtxmillA2UIBlock {
  id: string;
  component: string;
  props: Record<string, unknown>;
}

export interface CtxmillHitlRequest {
  id: string;
  runId?: string;
  threadId?: string;
  agentId?: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export type CtxmillStreamEvent =
  | { type: 'MESSAGES_SNAPSHOT'; runId: string; threadId: string; messages: CtxmillMessage[]; [key: string]: unknown }
  | { type: 'RUN_STARTED'; runId: string; threadId: string; timestamp?: number; [key: string]: unknown }
  | { type: 'TEXT_MESSAGE_START'; runId: string; threadId: string; messageId: string; role: 'assistant'; timestamp?: number; [key: string]: unknown }
  | { type: 'TEXT_MESSAGE_CONTENT'; runId: string; threadId: string; messageId: string; delta?: string; content?: string; timestamp?: number; [key: string]: unknown }
  | { type: 'TEXT_MESSAGE_END'; runId: string; threadId: string; messageId: string; timestamp?: number; [key: string]: unknown }
  | { type: 'TOOL_CALL_START'; runId: string; threadId: string; toolCallId: string; toolCallName?: string; toolName?: string; timestamp?: number; [key: string]: unknown }
  | { type: 'TOOL_CALL_ARGS'; runId: string; threadId: string; toolCallId: string; delta?: string; args?: unknown; timestamp?: number; [key: string]: unknown }
  | { type: 'TOOL_CALL_END'; runId: string; threadId: string; toolCallId: string; toolCallName?: string; result?: unknown; timestamp?: number; [key: string]: unknown }
  | { type: 'RUN_FINISHED'; runId: string; threadId: string; status?: string; timestamp?: number; [key: string]: unknown }
  | { type: 'RUN_ERROR'; runId: string; threadId: string; message?: string; status?: string; timestamp?: number; [key: string]: unknown }
  | { type: 'CUSTOM'; name?: string; subtype?: string; runId?: string; threadId?: string; timestamp?: number; [key: string]: unknown };

export type CtxmillHeadersProvider = HeadersInit | (() => HeadersInit | Promise<HeadersInit>);

export interface CtxmillClientOptions {
  apiBase?: string;
  headers?: CtxmillHeadersProvider;
  credentials?: RequestCredentials;
  fetch?: typeof fetch;
}

export interface ResolveInterruptInput {
  agentId: string;
  interruptId: string;
  action: 'approve' | 'reject' | 'submit';
  data?: unknown;
}

function joinUrl(base: string, path: string): string {
  const normalizedBase = base.endsWith('/') ? base.slice(0, -1) : base;
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function resolveHeaders(provider: CtxmillHeadersProvider | undefined): Promise<HeadersInit> {
  if (!provider) return {};
  if (typeof provider === 'function') {
    return provider();
  }
  return provider;
}

async function readErrorBody(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  if (!text) return '';
  try {
    const parsed = JSON.parse(text) as unknown;
    if (isRecord(parsed)) {
      const message = parsed.error ?? parsed.message ?? parsed.detail;
      if (typeof message === 'string') return message;
    }
  } catch {
    // fall through to raw text
  }
  return text;
}

function parseSSEBlock(block: string): string | null {
  const dataLines: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
  }
  return dataLines.length > 0 ? dataLines.join('\n') : null;
}

export async function* parseSSE(stream: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

      let separatorIndex = buffer.indexOf('\n\n');
      while (separatorIndex >= 0) {
        const block = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);
        const data = parseSSEBlock(block);
        if (data) {
          yield JSON.parse(data) as unknown;
        }
        separatorIndex = buffer.indexOf('\n\n');
      }
    }

    buffer += decoder.decode().replace(/\r\n/g, '\n');
    const data = parseSSEBlock(buffer.trim());
    if (data) {
      yield JSON.parse(data) as unknown;
    }
  } finally {
    reader.releaseLock();
  }
}

export function createCtxmillId(prefix: string): string {
  const cryptoLike = globalThis.crypto;
  const value = cryptoLike?.randomUUID ? cryptoLike.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${value}`;
}

export function createUserMessage(content: string): CtxmillMessage {
  return {
    id: createCtxmillId('msg'),
    role: 'user',
    content,
  };
}

export function getA2UIBlock(event: CtxmillStreamEvent): CtxmillA2UIBlock | null {
  if (event.type !== 'CUSTOM') return null;
  if (event.name !== 'ctxmill.a2ui.render' && event.subtype !== 'a2ui_render') return null;
  const block = event.block;
  if (!isRecord(block) || typeof block.component !== 'string') return null;
  return {
    id: typeof block.id === 'string' ? block.id : createCtxmillId('a2ui'),
    component: block.component,
    props: isRecord(block.props) ? block.props : {},
  };
}

export function getHitlRequest(event: CtxmillStreamEvent): CtxmillHitlRequest | null {
  if (event.type !== 'CUSTOM') return null;
  if (event.name !== 'ctxmill.hitl.requested' && event.subtype !== 'hitl_pause') return null;
  const interruptId = event.interruptId;
  const toolCallId = event.toolCallId;
  const toolName = event.toolName;
  if (typeof interruptId !== 'string' || typeof toolCallId !== 'string' || typeof toolName !== 'string') {
    return null;
  }
  return {
    id: interruptId,
    runId: typeof event.runId === 'string' ? event.runId : undefined,
    threadId: typeof event.threadId === 'string' ? event.threadId : undefined,
    agentId: typeof event.agentId === 'string' ? event.agentId : undefined,
    toolCallId,
    toolName,
    args: isRecord(event.args) ? event.args : {},
  };
}

export class CtxmillClient {
  private readonly apiBase: string;
  private readonly headerProvider?: CtxmillHeadersProvider;
  private readonly credentials?: RequestCredentials;
  private readonly fetchImpl: typeof fetch;

  constructor(options: CtxmillClientOptions = {}) {
    this.apiBase = options.apiBase ?? '/api';
    this.headerProvider = options.headers;
    this.credentials = options.credentials;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async *streamAgentRun(input: CtxmillRunInput): AsyncGenerator<CtxmillStreamEvent> {
    const headers = new Headers(await resolveHeaders(this.headerProvider));
    headers.set('Content-Type', 'application/json');

    const runId = input.runId ?? createCtxmillId('run');
    const response = await this.fetchImpl(
      joinUrl(this.apiBase, `/ag-ui/${encodeURIComponent(input.agentId)}/run`),
      {
        method: 'POST',
        headers,
        credentials: this.credentials,
        signal: input.signal,
        body: JSON.stringify({
          ...(input.threadId ? { threadId: input.threadId } : {}),
          runId,
          messages: input.messages,
          ...(input.tools ? { tools: input.tools } : {}),
          ...(input.context ? { context: input.context } : {}),
          ...(input.state !== undefined ? { state: input.state } : {}),
          ...(input.forwardedProps !== undefined ? { forwardedProps: input.forwardedProps } : {}),
        }),
      },
    );

    if (!response.ok) {
      const detail = await readErrorBody(response);
      throw new Error(detail ? `CTXMill run failed: ${response.status} ${detail}` : `CTXMill run failed: ${response.status}`);
    }
    if (!response.body) {
      throw new Error('CTXMill run failed: response has no stream body');
    }

    for await (const event of parseSSE(response.body)) {
      if (isRecord(event) && typeof event.type === 'string') {
        yield event as CtxmillStreamEvent;
      }
    }
  }

  async resolveInterrupt(input: ResolveInterruptInput): Promise<unknown> {
    const headers = new Headers(await resolveHeaders(this.headerProvider));
    headers.set('Content-Type', 'application/json');

    const response = await this.fetchImpl(
      joinUrl(this.apiBase, `/agents/${encodeURIComponent(input.agentId)}/interrupt`),
      {
        method: 'POST',
        headers,
        credentials: this.credentials,
        body: JSON.stringify({
          action: input.action,
          sessionId: input.interruptId,
          ...(input.data !== undefined ? { data: input.data } : {}),
        }),
      },
    );

    if (!response.ok) {
      const detail = await readErrorBody(response);
      throw new Error(detail ? `CTXMill interrupt resolution failed: ${response.status} ${detail}` : `CTXMill interrupt resolution failed: ${response.status}`);
    }

    return response.json().catch(() => undefined);
  }
}

export function createCtxmillClient(options?: CtxmillClientOptions): CtxmillClient {
  return new CtxmillClient(options);
}
