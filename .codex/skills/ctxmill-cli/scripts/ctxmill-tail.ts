#!/usr/bin/env bun

type JsonRecord = Record<string, unknown>;
type Flags = Record<string, string | boolean>;
interface ParsedArgs { positionals: string[]; flags: Flags }

class UsageError extends Error { exitCode = 2 }
class TimeoutError extends Error { exitCode = 3 }
class ApiError extends Error { exitCode = 1; constructor(message: string, readonly status: number, readonly data: unknown) { super(message); } }

const SECRET_KEY_RE = /(secret|token|password|authorization|api[_-]?key|credential|private[_-]?key)/i;
const TERMINAL_STATUSES = new Set(['COMPLETED', 'ERROR', 'CANCELLED', 'TERMINATED', 'completed', 'error', 'cancelled']);
const args = parseArgs(Bun.argv.slice(2));

try {
  await run();
} catch (error) {
  emitError(error, args.flags);
}

async function run(): Promise<void> {
  const [command, first, second] = args.positionals;
  if (!command || command === 'help' || hasFlag(args.flags, 'help', 'h')) {
    console.log(helpText());
    return;
  }

  switch (command) {
    case 'stream':
      requireArg(first, 'agentId');
      await tailStream(first);
      return;
    case 'events':
      await tailEvents();
      return;
    case 'wait-event':
      await waitEvent();
      return;
    case 'wait-session':
      requireArg(first, 'agentId');
      requireArg(second, 'sessionId');
      await waitSession(first, second);
      return;
    default:
      throw new UsageError(`Unknown command: ${command}\n\n${helpText()}`);
  }
}

async function tailStream(agentId: string): Promise<void> {
  const endpoint = `/api/agents/${encodeURIComponent(agentId)}/stream`;
  const response = await fetch(buildSseGetUrl(getBaseUrl(args.flags), endpoint), {
    headers: { Accept: 'text/event-stream' },
  });
  if (!response.ok || !response.body) {
    const text = await response.text();
    throw new ApiError(`SSE stream failed with HTTP ${response.status}`, response.status, parseMaybeJson(text));
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let splitIndex = buffer.indexOf('\n\n');
    while (splitIndex !== -1) {
      const frame = buffer.slice(0, splitIndex);
      buffer = buffer.slice(splitIndex + 2);
      emitSseFrame(frame);
      splitIndex = buffer.indexOf('\n\n');
    }
  }
}

async function tailEvents(): Promise<void> {
  const intervalMs = numberFlag('interval-ms', 2000);
  let cursor = numberFlag('cursor', 0);
  const type = flagString(args.flags, 'type');
  const agentId = flagString(args.flags, 'agent', 'agent-id');

  for (;;) {
    const query = new URLSearchParams();
    query.set('limit', flagString(args.flags, 'limit') ?? '50');
    if (cursor > 0) query.set('cursor', String(cursor));
    if (type) query.set('type', type);
    if (agentId) query.set('agentId', agentId);
    const payload = await requestJson(`/api/events?${query.toString()}`);
    const events = eventArray(payload);
    for (const event of events) {
      const seq = Number(event.seq);
      if (Number.isFinite(seq)) cursor = Math.max(cursor, seq);
      emitEvent(event);
    }
    await sleep(intervalMs);
  }
}

async function waitEvent(): Promise<void> {
  const timeoutMs = numberFlag('timeout-ms', 120_000);
  const intervalMs = numberFlag('interval-ms', 2000);
  const started = Date.now();
  let cursor = numberFlag('cursor', 0);
  const type = flagString(args.flags, 'type');
  const agentId = flagString(args.flags, 'agent', 'agent-id');
  if (!type && !agentId) throw new UsageError('wait-event requires --type and/or --agent to avoid matching unrelated events');

  while (Date.now() - started < timeoutMs) {
    const query = new URLSearchParams();
    query.set('limit', flagString(args.flags, 'limit') ?? '50');
    if (cursor > 0) query.set('cursor', String(cursor));
    if (type) query.set('type', type);
    if (agentId) query.set('agentId', agentId);
    const payload = await requestJson(`/api/events?${query.toString()}`);
    for (const event of eventArray(payload)) {
      const seq = Number(event.seq);
      if (Number.isFinite(seq)) cursor = Math.max(cursor, seq);
      if (matchesPayload(event, flagString(args.flags, 'contains'))) {
        emitEvent(event);
        return;
      }
    }
    await sleep(intervalMs);
  }

  throw new TimeoutError(`Timed out after ${timeoutMs}ms waiting for event`);
}

async function waitSession(agentId: string, sessionId: string): Promise<void> {
  const timeoutMs = numberFlag('timeout-ms', 120_000);
  const intervalMs = numberFlag('interval-ms', 2000);
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const payload = await requestJson(`/api/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}`);
    const session = isRecord(payload) && isRecord(payload.session) ? payload.session : undefined;
    const status = inferSessionStatus(session);
    const line = { sessionId, agentId, status, elapsedMs: Date.now() - started, error: isRecord(session) ? session.error : undefined };
    emitLine(line);
    if (TERMINAL_STATUSES.has(status)) return;
    await sleep(intervalMs);
  }
  throw new TimeoutError(`Timed out after ${timeoutMs}ms waiting for session ${sessionId}`);
}

function inferSessionStatus(session: JsonRecord | undefined): string {
  if (!session) return 'missing';
  if (session.error) return 'ERROR';
  if (session.completedAt) return 'COMPLETED';
  return 'ACTIVE';
}

function emitSseFrame(frame: string): void {
  const lines = frame.split(/\r?\n/);
  const event = lines.find((line) => line.startsWith('event:'))?.slice('event:'.length).trim() ?? 'message';
  const dataLines = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice('data:'.length).trim());
  const dataText = dataLines.join('\n');
  const data = parseMaybeJson(dataText);
  emitLine({ event, data: shouldRedact(args.flags) ? redact(data) : data });
}

function emitEvent(event: JsonRecord): void {
  emitLine(shouldRedact(args.flags) ? redact(event) : event);
}

function emitLine(value: unknown): void {
  if (hasFlag(args.flags, 'json', 'jsonl')) {
    console.log(JSON.stringify(value));
    return;
  }
  if (isRecord(value) && typeof value.type === 'string') {
    console.log(`${stringValue(value.seq).padStart(6)} ${stringValue(value.type).padEnd(32)} ${stringValue(value.agentId)} ${stringValue(value.createdAt)}`);
    return;
  }
  console.log(typeof value === 'string' ? value : JSON.stringify(value));
}

async function requestJson(endpoint: string): Promise<unknown> {
  const response = await fetch(buildUrl(getBaseUrl(args.flags), endpoint), { headers: authHeaders({ Accept: 'application/json' }) });
  const text = await response.text();
  const data = parseMaybeJson(text);
  if (!response.ok) throw new ApiError(`GET ${endpoint} failed with HTTP ${response.status}`, response.status, data);
  return data;
}

function emitError(error: unknown, flags: Flags): never {
  const code = error instanceof UsageError ? error.exitCode : error instanceof TimeoutError ? error.exitCode : error instanceof ApiError ? error.exitCode : 1;
  const payload = error instanceof ApiError
    ? { error: error.message, status: error.status, data: shouldRedact(flags) ? redact(error.data) : error.data }
    : { error: error instanceof Error ? error.message : String(error) };
  if (hasFlag(flags, 'json', 'jsonl')) console.error(JSON.stringify(payload));
  else console.error(payload.error);
  process.exit(code);
}

function parseArgs(argv: string[]): ParsedArgs { const flags: Flags = {}; const positionals: string[] = []; for (let i = 0; i < argv.length; i += 1) { const arg = argv[i]!; if (!arg.startsWith('--')) { positionals.push(arg); continue; } const name = arg.slice(2); const eq = name.indexOf('='); if (eq !== -1) { flags[name.slice(0, eq)] = name.slice(eq + 1); continue; } const next = argv[i + 1]; if (next && !next.startsWith('--')) { flags[name] = next; i += 1; } else flags[name] = true; } return { positionals, flags }; }
function getBaseUrl(flags: Flags): string { return (flagString(flags, 'base-url') ?? process.env.CTXMILL_API_URL ?? process.env.API_BASE ?? 'http://localhost:3002').replace(/\/+$/, ''); }
function getApiToken(flags: Flags): string | undefined { const raw = flagString(flags, 'api-token', 'token') ?? process.env.CTXMILL_API_TOKEN; const token = raw?.trim(); return token ? token : undefined; }
function authHeaders(headers: Record<string, string>): Record<string, string> { const token = getApiToken(args.flags); return token ? { ...headers, Authorization: `Bearer ${token}` } : headers; }
function buildUrl(baseUrl: string, endpoint: string): string { const url = new URL(baseUrl); const [rawPath, query = ''] = endpoint.split('?'); let path = rawPath!.startsWith('/') ? rawPath! : `/${rawPath}`; const basePath = url.pathname.replace(/\/+$/, ''); if (basePath.endsWith('/api') && path.startsWith('/api/')) path = path.slice(4); url.pathname = `${basePath}${path}`.replace(/\/+/g, '/'); url.search = query ? `?${query}` : ''; return url.toString(); }
function buildSseGetUrl(baseUrl: string, endpoint: string): string { const url = new URL(buildUrl(baseUrl, endpoint)); const token = getApiToken(args.flags); if (token && !url.searchParams.has('access_token')) url.searchParams.set('access_token', token); return url.toString(); }
function flagString(flags: Flags, ...names: string[]): string | undefined { for (const name of names) { const value = flags[name]; if (typeof value === 'string') return value; if (value === true) return 'true'; } return undefined; }
function hasFlag(flags: Flags, ...names: string[]): boolean { return names.some((name) => flags[name] === true || flags[name] === 'true'); }
function numberFlag(name: string, fallback: number): number { const raw = flagString(args.flags, name); if (!raw) return fallback; const parsed = Number(raw); if (!Number.isFinite(parsed)) throw new UsageError(`--${name} must be a number`); return parsed; }
function requireArg(value: string | undefined, name: string): asserts value is string { if (!value) throw new UsageError(`Missing required ${name}`); }
function shouldRedact(flags: Flags): boolean { return !hasFlag(flags, 'no-redact'); }
function isRecord(value: unknown): value is JsonRecord { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function stringValue(value: unknown): string { return value === undefined || value === null ? '' : String(value); }
function parseMaybeJson(text: string): unknown { if (!text) return null; try { return JSON.parse(text); } catch { return text; } }
function eventArray(value: unknown): JsonRecord[] { return isRecord(value) && Array.isArray(value.events) ? value.events.filter(isRecord) : []; }
function matchesPayload(event: JsonRecord, contains: string | undefined): boolean { return contains ? JSON.stringify(event).includes(contains) : true; }
function redact(value: unknown, seen = new WeakSet<object>()): unknown { if (Array.isArray(value)) return value.map((item) => redact(item, seen)); if (!isRecord(value)) return value; if (seen.has(value)) return '[Circular]'; seen.add(value); const out: JsonRecord = {}; for (const [key, child] of Object.entries(value)) out[key] = SECRET_KEY_RE.test(key) ? '[REDACTED]' : redact(child, seen); return out; }
function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function helpText(): string { return `ctxmill-tail.ts — follow ctxmill live streams and wait for events/sessions\n\nUsage:\n  bun scripts/ctxmill-tail.ts stream <agentId> [--jsonl]\n  bun scripts/ctxmill-tail.ts events [--agent <agentId>] [--type <type>] [--cursor n]\n  bun scripts/ctxmill-tail.ts wait-event (--type <type> | --agent <agentId>) [--contains text] [--timeout-ms 120000]\n  bun scripts/ctxmill-tail.ts wait-session <agentId> <sessionId> [--timeout-ms 120000]\n\nFlags:\n  --base-url <url>       ctxmill API root\n  --api-token <token>    Bearer token (default: CTXMILL_API_TOKEN)\n  --json / --jsonl       Emit one JSON object per line\n  --interval-ms <n>      Poll interval for events/session waits (default 2000)\n  --limit <n>            Event page size (default 50)\n  --no-redact            Disable secret redaction\n`; }
