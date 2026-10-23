export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  json: unknown;
  form: Record<string, string> | null;
}

export interface FakeTurnScript {
  /** Statuses returned by successive polls; the last one sticks. */
  statuses: Array<'QUEUED' | 'RUNNING' | 'COMPLETED' | 'ERROR'>;
  answer: string;
  /** Cost coverage per poll; the last one sticks. */
  coverage?: Array<'complete' | 'pending'>;
  costUsd?: number;
}

type Handler = (request: RecordedRequest, url: URL) => { status: number; body?: unknown; headers?: Record<string, string> } | null;

/** An in-memory stand-in for the parts of the Stablehand API the example calls. */
export class FakeApi {
  requests: RecordedRequest[] = [];
  agents: Array<{ id: string; name: string; manifest: Record<string, unknown> | null; body: Record<string, unknown> }> = [];
  budgets: Array<{ id: string; name: string; doc: unknown }> = [];
  keys: Array<{ id: string; name: string; status: string; capabilities: string[] }> = [];
  artifacts: Array<{ id: string; agentId: string; name: string; kind: string; metadata: unknown; content: string }> = [];
  events: Array<{ type: string; turnId?: string; payload: Record<string, unknown> }> = [];
  turnScripts: FakeTurnScript[] = [];
  /** Respond to turn starts with this error instead (e.g. budget_exceeded). */
  turnStartError: { status: number; body: unknown } | null = null;
  /** Errors returned once each, in order, before turn starts succeed. */
  turnStartRefusals: Array<{ status: number; body: unknown; headers?: Record<string, string> }> = [];
  private turns = new Map<string, { script: FakeTurnScript; polls: number; agentId: string; messages?: unknown[] }>();

  /** Replace what the turn detail returns as messages (e.g. a tool result the orchestrator wrote). */
  setMessages(turnId: string, messages: Array<{ role: string; content: string; toolCallId?: string }>): void {
    const turn = this.turns.get(turnId);
    if (!turn) throw new Error(`no fake turn ${turnId}`);
    turn.messages = messages;
  }
  private nextId = 1;
  private readonly extra: Handler[] = [];

  on(handler: Handler): void {
    this.extra.push(handler);
  }

  private id(prefix: string): string {
    const id = `${prefix}-${this.nextId}`;
    this.nextId += 1;
    return id;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? 'GET';
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    let json: unknown = null;
    let form: Record<string, string> | null = null;
    if (typeof init?.body === 'string') json = JSON.parse(init.body);
    if (init?.body instanceof FormData) {
      form = {};
      for (const [key, value] of init.body.entries()) form[key] = typeof value === 'string' ? value : await value.text();
    }
    const request: RecordedRequest = { method, path: url.pathname, headers, json, form };
    this.requests.push(request);
    const response = this.extra.map((handler) => handler(request, url)).find((entry) => entry !== null) ?? this.route(request, url);
    return new Response(response.body === undefined ? '' : typeof response.body === 'string' ? response.body : JSON.stringify(response.body), {
      status: response.status,
      headers: response.headers ?? {},
    });
  };

  private route(request: RecordedRequest, url: URL): { status: number; body?: unknown; headers?: Record<string, string> } {
    const { method, path } = request;
    const body = (request.json ?? {}) as Record<string, unknown>;
    let match: RegExpExecArray | null;

    if (method === 'GET' && path === '/api/agents') return { status: 200, body: this.agents.map(({ id, name, manifest }) => ({ id, name, manifest })) };
    if (method === 'POST' && path === '/api/agents') {
      const agent = { id: this.id('agent'), name: String(body.name), manifest: (body.manifest ?? null) as Record<string, unknown> | null, body };
      this.agents.push(agent);
      return { status: 201, body: { id: agent.id, name: agent.name } };
    }
    if ((match = /^\/api\/agents\/([^/]+)$/.exec(path))) {
      const agent = this.agents.find((entry) => entry.id === match![1]);
      if (!agent) return { status: 404, body: { error: 'not found' } };
      if (method === 'GET') return { status: 200, body: { id: agent.id, name: agent.name, manifest: agent.manifest } };
      if (method === 'PATCH') {
        Object.assign(agent, { body: { ...agent.body, ...body }, manifest: (body.manifest ?? agent.manifest) as Record<string, unknown> | null });
        return { status: 200, body: { id: agent.id, name: agent.name } };
      }
    }
    if ((match = /^\/api\/agents\/([^/]+)\/turns$/.exec(path)) && method === 'POST') {
      if (this.turnStartError) return this.turnStartError;
      const refusal = this.turnStartRefusals.shift();
      if (refusal) return refusal;
      const script = this.turnScripts.shift() ?? { statuses: ['COMPLETED'], answer: 'ok' };
      const turnId = this.id('turn');
      this.turns.set(turnId, { script, polls: 0, agentId: match[1]! });
      return { status: 201, body: { turnId, conversationId: this.id('conv') } };
    }
    if ((match = /^\/api\/agents\/([^/]+)\/turns\/([^/]+)$/.exec(path)) && method === 'GET') {
      const turn = this.turns.get(match[2]!);
      if (!turn) return { status: 404, body: { error: 'Turn not found' } };
      const pick = <T>(list: T[], index: number): T => list[Math.min(index, list.length - 1)]!;
      const status = pick(turn.script.statuses, turn.polls);
      const coverage = turn.script.coverage ? pick(turn.script.coverage, turn.polls) : 'complete';
      turn.polls += 1;
      const done = status === 'COMPLETED' || status === 'ERROR';
      return {
        status: 200,
        body: {
          turn: {
            id: match[2],
            status,
            error: status === 'ERROR' ? 'boom' : null,
            usage: done ? {
              inputTokens: 300,
              outputTokens: 40,
              totalTokens: 340,
              cost: { totalUsd: coverage === 'complete' ? turn.script.costUsd ?? 0.002 : null, knownUsd: 0, coverage },
            } : null,
          },
          messages: turn.messages ?? (done ? [
            { role: 'user', content: 'task' },
            { role: 'assistant', content: turn.script.answer },
            { role: 'assistant', content: '' },
          ] : []),
        },
      };
    }
    if (/^\/api\/agents\/[^/]+\/turns\/[^/]+\/cancel$/.test(path)) return { status: 200, body: { ok: true } };
    if (method === 'GET' && path === '/api/budgets') return { status: 200, body: { policies: this.budgets } };
    if (method === 'POST' && path === '/api/budgets') {
      const policy = { id: this.id('budget'), name: String(body.name), doc: body.doc };
      this.budgets.push(policy);
      return { status: 201, body: policy };
    }
    if ((match = /^\/api\/budgets\/([^/]+)$/.exec(path)) && method === 'PATCH') {
      const policy = this.budgets.find((entry) => entry.id === match![1]);
      if (policy) policy.doc = body.doc;
      return { status: 200, body: policy };
    }
    if (method === 'GET' && path === '/api/keys') return { status: 200, body: { keys: this.keys } };
    if (method === 'POST' && path === '/api/keys') {
      const key = { id: this.id('key'), name: String(body.name), status: 'active', capabilities: body.capabilities as string[] };
      this.keys.push(key);
      return { status: 201, body: { ...key, token: 'cmk_FAKE0000000000000000000000000000000000000000' } };
    }
    if (method === 'POST' && path === '/api/artifacts/upload') {
      const form = request.form ?? {};
      const artifact = {
        id: this.id('artifact'),
        agentId: form.agentId ?? '',
        name: form.name ?? '',
        kind: form.kind ?? '',
        metadata: form.metadata ? JSON.parse(form.metadata) : null,
        content: form.file ?? '',
      };
      this.artifacts.push(artifact);
      return { status: 201, body: { id: artifact.id } };
    }
    if (method === 'GET' && path === '/api/artifacts') {
      const agentId = url.searchParams.get('agentId');
      const list = this.artifacts.filter((artifact) => !agentId || artifact.agentId === agentId);
      return { status: 200, body: { artifacts: list.map(({ id, name, kind }) => ({ id, name, kind })), total: list.length } };
    }
    if ((match = /^\/api\/artifacts\/([^/]+)\/download$/.exec(path))) {
      const artifact = this.artifacts.find((entry) => entry.id === match![1]);
      return artifact ? { status: 200, body: artifact.content } : { status: 404, body: { error: 'Artifact not found' } };
    }
    if (method === 'POST' && path === '/api/triggers/emit') {
      this.events.push({ type: String(body.type), payload: body.payload as Record<string, unknown> });
      return { status: 201, body: { ok: true } };
    }
    if (method === 'GET' && path === '/api/events') {
      const type = url.searchParams.get('type');
      const turnId = url.searchParams.get('turnId');
      const events = this.events
        .filter((event) => (!type || event.type === type) && (!turnId || event.turnId === turnId))
        .map((event) => ({ type: event.type, payload: JSON.stringify(event.payload) }));
      return { status: 200, body: { events } };
    }
    return { status: 404, body: { error: `no fake route for ${method} ${path}` } };
  }

  calls(method: string, pattern: RegExp): RecordedRequest[] {
    return this.requests.filter((request) => request.method === method && pattern.test(request.path));
  }
}
