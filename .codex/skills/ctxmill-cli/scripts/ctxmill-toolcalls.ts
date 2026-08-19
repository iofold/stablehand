#!/usr/bin/env bun

import { redactSensitiveFields as redact } from '../../../../packages/ctxmill/src/cli/redaction.ts';

export {};

type JsonRecord = Record<string, unknown>;
type Flags = Record<string, string | boolean>;

interface ParsedArgs { positionals: string[]; flags: Flags }
interface ToolCallSummary {
  id: string;
  name: string;
  status: string;
  args?: unknown;
  result?: unknown;
  error?: string;
  messageId?: string;
  messageRole?: string;
  createdAt?: number;
  events: JsonRecord[];
}

class UsageError extends Error { exitCode = 2 }
class ApiError extends Error { exitCode = 1; constructor(message: string, readonly status: number, readonly data: unknown) { super(message); } }

const args = parseArgs(Bun.argv.slice(2));

try {
  if (hasFlag(args.flags, 'help', 'h')) {
    console.log(helpText());
    process.exit(0);
  }
  const output = await buildTimeline(args.flags);
  emit(output, args.flags);
} catch (error) {
  emitError(error, args.flags);
}

async function buildTimeline(flags: Flags): Promise<JsonRecord> {
  const agentId = flagString(flags, 'agent', 'agent-id') ?? args.positionals[0];
  let turnId = flagString(flags, 'turn', 'turn-id') ?? args.positionals[1];
  let conversationId = flagString(flags, 'conversation', 'conversation-id') ?? args.positionals[2];
  requireArg(agentId, 'agentId via --agent or positional arg');

  let turnDetail: unknown = null;
  if (turnId && !conversationId) {
    turnDetail = await requestJson(`/api/agents/${encodeURIComponent(agentId)}/turns/${encodeURIComponent(turnId)}`);
    if (isRecord(turnDetail) && isRecord(turnDetail.turn) && typeof turnDetail.turn.conversationId === 'string') {
      conversationId = turnDetail.turn.conversationId;
    }
  }

  if (!conversationId) {
    const summaries = await requestJson(`/api/agents/${encodeURIComponent(agentId)}/conversations/summary`);
    const conversations = isRecord(summaries) && Array.isArray(summaries.conversations) ? summaries.conversations : [];
    const latest = conversations[0];
    if (isRecord(latest) && typeof latest.id === 'string') {
      conversationId = latest.id;
      if (!turnId && typeof latest.latestTurnId === 'string') turnId = latest.latestTurnId;
    }
  }

  requireArg(conversationId, 'conversationId via --conversation, --turn, or latest conversation summary');

  const detailMessages = isRecord(turnDetail) ? turnDetail.messages : undefined;
  let messages: unknown[];
  if (Array.isArray(detailMessages)) {
    messages = detailMessages;
  } else {
    const snapshot = await requestJson(`/api/agents/${encodeURIComponent(agentId)}/conversations/${encodeURIComponent(conversationId)}/snapshot`);
    messages = isRecord(snapshot) && Array.isArray(snapshot.messages) ? snapshot.messages : [];
  }

  const events = await loadEvents(agentId, turnId, conversationId, flags);
  const toolCalls = extractToolCalls(messages, events, flags);

  return {
    agentId,
    turnId,
    conversationId,
    toolCalls,
    events,
    sourceEndpoints: [
      `/api/agents/${agentId}/conversations/${conversationId}/snapshot`,
      `/api/events?agentId=${agentId}`,
    ],
  };
}

async function loadEvents(agentId: string, turnId: string | undefined, conversationId: string | undefined, flags: Flags): Promise<JsonRecord[]> {
  const query = new URLSearchParams();
  query.set('agentId', agentId);
  query.set('limit', flagString(flags, 'events-limit') ?? flagString(flags, 'limit') ?? '200');
  const since = normalizeSince(flagString(flags, 'since'));
  if (since) query.set('since', since);
  const payload = await requestJson(`/api/events?${query.toString()}`);
  const events = isRecord(payload) && Array.isArray(payload.events) ? payload.events : [];

  return events.filter(isRecord).filter((event) => {
    if (!turnId && !conversationId) return true;
    const haystack = JSON.stringify(event);
    return Boolean((turnId && haystack.includes(turnId)) || (conversationId && haystack.includes(conversationId)));
  });
}

function extractToolCalls(messages: unknown[], events: JsonRecord[], flags: Flags): ToolCallSummary[] {
  const calls = new Map<string, ToolCallSummary>();

  for (const message of messages) {
    if (!isRecord(message)) continue;
    const messageId = stringValue(message.id);
    const role = stringValue(message.role);
    const createdAt = stringValue(message.createdAt);

    for (const toolCall of Array.isArray(message.toolCalls) ? message.toolCalls : []) {
      if (!isRecord(toolCall)) continue;
      const id = stringValue(toolCall.id) || `${messageId}:toolCalls:${calls.size}`;
      mergeCall(calls, id, {
        id,
        name: stringValue(toolCall.name),
        status: stringValue(toolCall.status),
        args: parseJsonish(toolCall.args),
        result: includeResults(flags) ? parseJsonish(toolCall.result) : summarizeValue(toolCall.result),
        error: stringValue(toolCall.error),
        messageId,
        messageRole: role,
        createdAt,
        events: [],
      });
    }

    for (const part of Array.isArray(message.parts) ? message.parts : []) {
      if (!isRecord(part) || part.type !== 'tool_call') continue;
      const id = stringValue(part.id) || `${messageId}:part:${calls.size}`;
      mergeCall(calls, id, {
        id,
        name: stringValue(part.name),
        status: stringValue(part.status),
        args: parseJsonish(part.args),
        result: includeResults(flags) ? parseJsonish(part.result) : summarizeValue(part.result),
        error: stringValue(part.error),
        messageId,
        messageRole: role,
        createdAt,
        events: [],
      });
    }

    const toolCallId = stringValue(message.toolCallId);
    if (role === 'tool' && toolCallId) {
      mergeCall(calls, toolCallId, {
        id: toolCallId,
        name: '',
        status: 'complete',
        result: includeResults(flags) ? message.content : summarizeValue(message.content),
        messageId,
        messageRole: role,
        createdAt,
        events: [],
      });
    }
  }

  for (const call of calls.values()) {
    call.events = events.filter((event) => JSON.stringify(event).includes(call.id) || (call.name !== '' && JSON.stringify(event).includes(call.name)));
    if (!call.status && call.events.some((event) => stringValue(event.type).includes('tool_result'))) call.status = 'complete';
    if (!call.status) call.status = call.error ? 'error' : 'unknown';
  }

  return Array.from(calls.values());
}

function mergeCall(calls: Map<string, ToolCallSummary>, id: string, patch: ToolCallSummary): void {
  const existing = calls.get(id);
  if (!existing) {
    calls.set(id, patch);
    return;
  }

  calls.set(id, {
    ...existing,
    ...Object.fromEntries(Object.entries(patch).filter(([_key, value]) => value !== undefined && value !== '')),
    events: existing.events,
  });
}

async function requestJson(endpoint: string): Promise<unknown> {
  const response = await fetch(buildUrl(getBaseUrl(args.flags), endpoint), { headers: authHeaders({ Accept: 'application/json' }) });
  const text = await response.text();
  const data = parseMaybeJson(text);
  if (!response.ok) throw new ApiError(`GET ${endpoint} failed with HTTP ${response.status}`, response.status, data);
  return data;
}

function emit(output: JsonRecord, flags: Flags): void {
  const data = shouldRedact(flags) ? redact(output) : output;
  if (hasFlag(flags, 'json')) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  const toolCalls = Array.isArray(output.toolCalls) ? output.toolCalls.filter(isRecord) : [];
  console.log(`agent: ${String(output.agentId ?? '')}`);
  console.log(`turn: ${String(output.turnId ?? '')}`);
  console.log(`conversation: ${String(output.conversationId ?? '')}`);
  console.log(`tool_calls: ${toolCalls.length}`);
  console.log('');
  console.log(table(toolCalls.map((call, index) => ({
    n: index + 1,
    id: stringValue(call.id),
    name: stringValue(call.name),
    status: stringValue(call.status),
    events: Array.isArray(call.events) ? call.events.length : 0,
    error: stringValue(call.error),
    args: summarizeValue(call.args),
    result: summarizeValue(call.result),
  })), [['n', '#', 4], ['id', 'ID', 16], ['name', 'NAME', 30], ['status', 'STATUS', 12], ['events', 'EVENTS', 6], ['error', 'ERROR', 32], ['args', 'ARGS', 50], ['result', 'RESULT', 60]]));
}

function emitError(error: unknown, flags: Flags): never {
  const exitCode = error instanceof UsageError ? error.exitCode : error instanceof ApiError ? error.exitCode : 1;
  const payload = error instanceof ApiError
    ? { error: error.message, status: error.status, data: shouldRedact(flags) ? redact(error.data) : error.data }
    : { error: error instanceof Error ? error.message : String(error) };
  if (hasFlag(flags, 'json')) console.error(JSON.stringify(payload, null, 2));
  else console.error(payload.error);
  process.exit(exitCode);
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags: Flags = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) { positionals.push(arg); continue; }
    const name = arg.slice(2);
    const eq = name.indexOf('=');
    if (eq !== -1) { flags[name.slice(0, eq)] = name.slice(eq + 1); continue; }
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { flags[name] = next; i += 1; } else flags[name] = true;
  }
  return { positionals, flags };
}

function getBaseUrl(flags: Flags): string { return (flagString(flags, 'base-url') ?? process.env.CTXMILL_API_URL ?? process.env.API_BASE ?? 'http://localhost:3002').replace(/\/+$/, ''); }
function getApiToken(flags: Flags): string | undefined { const raw = flagString(flags, 'api-token', 'token') ?? process.env.CTXMILL_API_TOKEN; const token = raw?.trim(); return token ? token : undefined; }
function authHeaders(headers: Record<string, string>): Record<string, string> { const token = getApiToken(args.flags); return token ? { ...headers, Authorization: `Bearer ${token}` } : headers; }
function buildUrl(baseUrl: string, endpoint: string): string {
  const url = new URL(baseUrl);
  const [pathRaw, query = ''] = endpoint.split('?');
  let path = pathRaw!.startsWith('/') ? pathRaw! : `/${pathRaw}`;
  const basePath = url.pathname.replace(/\/+$/, '');
  if (basePath.endsWith('/api') && path.startsWith('/api/')) path = path.slice(4);
  url.pathname = `${basePath}${path}`.replace(/\/+/g, '/');
  url.search = query ? `?${query}` : '';
  return url.toString();
}
function flagString(flags: Flags, ...names: string[]): string | undefined { for (const name of names) { const value = flags[name]; if (typeof value === 'string') return value; if (value === true) return 'true'; } return undefined; }
function hasFlag(flags: Flags, ...names: string[]): boolean { return names.some((name) => flags[name] === true || flags[name] === 'true'); }
function requireArg(value: string | undefined, name: string): asserts value is string { if (!value) throw new UsageError(`Missing required ${name}`); }
function shouldRedact(flags: Flags): boolean { return !hasFlag(flags, 'no-redact'); }
function includeResults(flags: Flags): boolean { return hasFlag(flags, 'include-results', 'full-results'); }
function isRecord(value: unknown): value is JsonRecord { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function stringValue(value: unknown): string { return value === undefined || value === null ? '' : String(value); }
function parseMaybeJson(text: string): unknown { if (!text) return null; try { return JSON.parse(text); } catch { return text; } }
function parseJsonish(value: unknown): unknown { return typeof value === 'string' ? parseMaybeJson(value) : value; }
function summarizeValue(value: unknown, max = 140): string { const text = typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value); return text.length <= max ? text : `${text.slice(0, max - 1)}…`; }
function normalizeSince(value: string | undefined): string | undefined { if (!value) return undefined; if (/^\d+$/.test(value)) return value; const parsed = Date.parse(value); if (Number.isFinite(parsed)) return String(parsed); const relative = value.match(/^now-(\d+)(s|m|h|d)$/); if (!relative) throw new UsageError('--since must be epoch ms, ISO datetime, or now-<n>s|m|h|d'); const amount = Number(relative[1]); const unit = relative[2]; const multiplier = unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000; return String(Date.now() - amount * multiplier); }
function table(rows: Array<Record<string, unknown>>, columns: Array<[string, string, number?]>): string { if (rows.length === 0) return '(none)'; const rendered = rows.map((row) => columns.map(([key, _label, max]) => summarizeValue(row[key], max ?? 40))); const widths = columns.map(([_key, label], i) => Math.max(label.length, ...rendered.map((row) => row[i]!.length))); return [columns.map(([_key, label], i) => label.padEnd(widths[i]!)).join('  '), widths.map((w) => '-'.repeat(w)).join('  '), ...rendered.map((row) => row.map((cell, i) => cell.padEnd(widths[i]!)).join('  '))].join('\n'); }
function helpText(): string { return `ctxmill-toolcalls.ts — extract ctxmill tool-call timeline\n\nUsage:\n  bun scripts/ctxmill-toolcalls.ts --agent <agentId> [--turn <turnId> | --conversation <conversationId>]\n\nFlags:\n  --base-url <url>       ctxmill API root\n  --api-token <token>    Bearer token (default: CTXMILL_API_TOKEN)\n  --agent <agentId>      Agent id\n  --turn <turnId>        Execution turn id; used to discover conversation id\n  --conversation <id>    Conversation id\n  --since <time>         Epoch ms, ISO datetime, or now-5m for event lookup\n  --events-limit <n>     Event lookup limit (default 200)\n  --include-results      Include full tool results instead of short summaries\n  --json                 Emit JSON\n  --no-redact            Disable secret redaction\n`; }
