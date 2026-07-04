#!/usr/bin/env bun

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

type JsonRecord = Record<string, unknown>;
type Flags = Record<string, string | boolean>;
interface ParsedArgs { positionals: string[]; flags: Flags }
interface FetchResult { name: string; endpoint: string; ok: boolean; data: unknown; error?: string }

class UsageError extends Error { exitCode = 2 }
const SECRET_KEY_RE = /(secret|token|password|authorization|api[_-]?key|credential|private[_-]?key)/i;
const args = parseArgs(Bun.argv.slice(2));

try {
  if (hasFlag(args.flags, 'help', 'h')) {
    console.log(helpText());
    process.exit(0);
  }
  const outDir = await createBundle(args.flags);
  console.log(`ctxmill debug bundle written: ${outDir}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(error instanceof UsageError ? error.exitCode : 1);
}

async function createBundle(flags: Flags): Promise<string> {
  const agentId = flagString(flags, 'agent', 'agent-id') ?? args.positionals[0];
  const sessionId = flagString(flags, 'session', 'session-id') ?? args.positionals[1];
  let conversationId = flagString(flags, 'conversation', 'conversation-id') ?? args.positionals[2];
  requireArg(agentId, 'agentId via --agent or positional arg');

  const outDir = flagString(flags, 'out') ?? `.ctxmill/debug/${new Date().toISOString().replace(/[:.]/g, '-')}`;
  await mkdir(outDir, { recursive: true });

  const manifest: JsonRecord = {
    generatedAt: new Date().toISOString(),
    baseUrl: getBaseUrl(flags),
    agentId,
    sessionId,
    conversationId,
    warnings: [],
    files: [],
  };

  const results: FetchResult[] = [];
  await collect(results, 'health', '/api/health');
  await collect(results, 'config', '/api/config');
  await collect(results, 'sandbox-metrics', '/api/sandbox/metrics');
  await collect(results, 'agent', `/api/agents/${encodeURIComponent(agentId)}`);
  await collect(results, 'sessions', `/api/agents/${encodeURIComponent(agentId)}/sessions`);
  await collect(results, 'conversations', `/api/agents/${encodeURIComponent(agentId)}/conversations/summary`);
  await collect(results, 'interrupts', `/api/agents/${encodeURIComponent(agentId)}/interrupts?include_resolved=true`);
  await collect(results, 'events', `/api/events?agentId=${encodeURIComponent(agentId)}&limit=${encodeURIComponent(flagString(flags, 'events-limit') ?? '200')}${sinceQuery(flags)}`);

  if (sessionId) {
    const session = await collect(results, 'session', `/api/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}`);
    if (!conversationId && isRecord(session.data) && isRecord(session.data.session) && typeof session.data.session.conversationId === 'string') {
      conversationId = session.data.session.conversationId;
      manifest.conversationId = conversationId;
    }
    await collect(results, 'artifacts', `/api/artifacts?sessionId=${encodeURIComponent(sessionId)}`);
  } else {
    await collect(results, 'artifacts', `/api/artifacts?agentId=${encodeURIComponent(agentId)}&limit=100&offset=0`);
  }

  if (!conversationId) {
    const conversations = results.find((result) => result.name === 'conversations')?.data;
    const list = isRecord(conversations) && Array.isArray(conversations.conversations) ? conversations.conversations : [];
    const latest = list[0];
    if (isRecord(latest) && typeof latest.id === 'string') {
      conversationId = latest.id;
      manifest.conversationId = conversationId;
    }
  }

  if (conversationId) {
    await collect(results, 'messages', `/api/agents/${encodeURIComponent(agentId)}/conversations/${encodeURIComponent(conversationId)}/messages`);
  } else {
    (manifest.warnings as string[]).push('No conversationId discovered; messages/toolcalls omitted.');
  }

  const redactedResults = results.map((result) => ({ ...result, data: shouldRedact(flags) ? redact(result.data) : result.data }));
  for (const result of redactedResults) {
    await writeJson(outDir, `${result.name}.json`, result);
    (manifest.files as string[]).push(`${result.name}.json`);
    if (!result.ok) (manifest.warnings as string[]).push(`${result.name}: ${result.error ?? 'failed'}`);
  }

  const messages = results.find((result) => result.name === 'messages')?.data;
  const events = results.find((result) => result.name === 'events')?.data;
  const toolcalls = extractToolCalls(Array.isArray(messages) ? messages : [], eventArray(events));
  const toolcallsData = shouldRedact(flags) ? redact(toolcalls) : toolcalls;
  await writeJson(outDir, 'toolcalls.json', { agentId, sessionId, conversationId, toolCalls: toolcallsData });
  (manifest.files as string[]).push('toolcalls.json');

  await writeFile(join(outDir, 'summary.md'), buildSummary({ agentId, sessionId, conversationId, results: redactedResults, toolcalls }));
  (manifest.files as string[]).push('summary.md');
  await writeJson(outDir, 'manifest.json', manifest);
  return outDir;
}

async function collect(results: FetchResult[], name: string, endpoint: string): Promise<FetchResult> {
  try {
    const data = await requestJson(endpoint);
    const result = { name, endpoint, ok: true, data };
    results.push(result);
    return result;
  } catch (error) {
    const result = { name, endpoint, ok: false, data: null, error: error instanceof Error ? error.message : String(error) };
    results.push(result);
    return result;
  }
}

function buildSummary(input: { agentId: string; sessionId?: string; conversationId?: string; results: FetchResult[]; toolcalls: JsonRecord[] }): string {
  const agent = input.results.find((result) => result.name === 'agent')?.data;
  const sessionData = input.results.find((result) => result.name === 'session')?.data;
  const interrupts = input.results.find((result) => result.name === 'interrupts')?.data;
  const events = eventArray(input.results.find((result) => result.name === 'events')?.data);
  const messages = input.results.find((result) => result.name === 'messages')?.data;
  const failed = input.results.filter((result) => !result.ok);
  const pendingInterrupts = isRecord(interrupts) && Array.isArray(interrupts.interrupts)
    ? interrupts.interrupts.filter((item) => isRecord(item) && item.status === 'pending')
    : [];
  const session = isRecord(sessionData) && isRecord(sessionData.session) ? sessionData.session : undefined;
  const errorCalls = input.toolcalls.filter((call) => stringValue(call.status).toLowerCase() === 'error' || stringValue(call.error));

  return `# ctxmill Debug Bundle\n\n` +
    `Generated: ${new Date().toISOString()}\n\n` +
    `## Identity\n\n` +
    `- Agent: ${stringValue(isRecord(agent) ? agent.name : '')} (${input.agentId})\n` +
    `- Harness: ${stringValue(isRecord(agent) ? agent.harness : '')}\n` +
    `- Session: ${input.sessionId ?? ''}\n` +
    `- Conversation: ${input.conversationId ?? ''}\n\n` +
    `## Session\n\n` +
    `- Started: ${stringValue(isRecord(session) ? session.startedAt : '')}\n` +
    `- Completed: ${stringValue(isRecord(session) ? session.completedAt : '')}\n` +
    `- Error: ${stringValue(isRecord(session) ? session.error : '')}\n` +
    `- Messages: ${Array.isArray(messages) ? messages.length : 0}\n\n` +
    `## Signals\n\n` +
    `- Tool calls: ${input.toolcalls.length}\n` +
    `- Tool errors: ${errorCalls.length}\n` +
    `- Pending interrupts: ${pendingInterrupts.length}\n` +
    `- Events captured: ${events.length}\n` +
    `- Failed fetches: ${failed.length}\n\n` +
    `## Recent events\n\n` +
    `${events.slice(0, 12).map((event) => `- ${stringValue(event.seq)} ${stringValue(event.type)} ${stringValue(event.createdAt)}`).join('\n') || '(none)'}\n\n` +
    `## Tool errors\n\n` +
    `${errorCalls.map((call) => `- ${stringValue(call.name)} (${stringValue(call.id)}): ${stringValue(call.error)}`).join('\n') || '(none)'}\n\n` +
    `## Failed fetches\n\n` +
    `${failed.map((result) => `- ${result.name}: ${result.error}`).join('\n') || '(none)'}\n`;
}

function extractToolCalls(messages: unknown[], events: JsonRecord[]): JsonRecord[] {
  const calls = new Map<string, JsonRecord>();
  for (const message of messages) {
    if (!isRecord(message)) continue;
    const messageId = stringValue(message.id);
    for (const toolCall of Array.isArray(message.toolCalls) ? message.toolCalls : []) {
      if (!isRecord(toolCall)) continue;
      const id = stringValue(toolCall.id) || `${messageId}:${calls.size}`;
      calls.set(id, { ...(calls.get(id) ?? {}), id, name: stringValue(toolCall.name), status: stringValue(toolCall.status), args: toolCall.args, error: stringValue(toolCall.error), messageId });
    }
    for (const part of Array.isArray(message.parts) ? message.parts : []) {
      if (!isRecord(part) || part.type !== 'tool_call') continue;
      const id = stringValue(part.id) || `${messageId}:${calls.size}`;
      calls.set(id, { ...(calls.get(id) ?? {}), id, name: stringValue(part.name), status: stringValue(part.status), args: part.args, error: stringValue(part.error), messageId });
    }
    const toolCallId = stringValue(message.toolCallId);
    if (toolCallId && message.role === 'tool') {
      calls.set(toolCallId, { ...(calls.get(toolCallId) ?? {}), id: toolCallId, status: 'complete', result: stringValue(message.content), messageId });
    }
  }
  return Array.from(calls.values()).map((call) => ({ ...call, events: events.filter((event) => JSON.stringify(event).includes(stringValue(call.id))) }));
}

async function requestJson(endpoint: string): Promise<unknown> {
  const response = await fetch(buildUrl(getBaseUrl(args.flags), endpoint), { headers: authHeaders({ Accept: 'application/json' }) });
  const text = await response.text();
  const data = parseMaybeJson(text);
  if (!response.ok) throw new Error(`GET ${endpoint} failed with HTTP ${response.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  return data;
}

async function writeJson(dir: string, name: string, data: unknown): Promise<void> {
  await writeFile(join(dir, name), JSON.stringify(data, null, 2));
}

function parseArgs(argv: string[]): ParsedArgs { const flags: Flags = {}; const positionals: string[] = []; for (let i = 0; i < argv.length; i += 1) { const arg = argv[i]!; if (!arg.startsWith('--')) { positionals.push(arg); continue; } const name = arg.slice(2); const eq = name.indexOf('='); if (eq !== -1) { flags[name.slice(0, eq)] = name.slice(eq + 1); continue; } const next = argv[i + 1]; if (next && !next.startsWith('--')) { flags[name] = next; i += 1; } else flags[name] = true; } return { positionals, flags }; }
function getBaseUrl(flags: Flags): string { return (flagString(flags, 'base-url') ?? process.env.CTXMILL_API_URL ?? process.env.API_BASE ?? 'http://localhost:3002').replace(/\/+$/, ''); }
function getApiToken(flags: Flags): string | undefined { const raw = flagString(flags, 'api-token', 'token') ?? process.env.CTXMILL_API_TOKEN; const token = raw?.trim(); return token ? token : undefined; }
function authHeaders(headers: Record<string, string>): Record<string, string> { const token = getApiToken(args.flags); return token ? { ...headers, Authorization: `Bearer ${token}` } : headers; }
function buildUrl(baseUrl: string, endpoint: string): string { const url = new URL(baseUrl); const [rawPath, query = ''] = endpoint.split('?'); let path = rawPath!.startsWith('/') ? rawPath! : `/${rawPath}`; const basePath = url.pathname.replace(/\/+$/, ''); if (basePath.endsWith('/api') && path.startsWith('/api/')) path = path.slice(4); url.pathname = `${basePath}${path}`.replace(/\/+/g, '/'); url.search = query ? `?${query}` : ''; return url.toString(); }
function flagString(flags: Flags, ...names: string[]): string | undefined { for (const name of names) { const value = flags[name]; if (typeof value === 'string') return value; if (value === true) return 'true'; } return undefined; }
function hasFlag(flags: Flags, ...names: string[]): boolean { return names.some((name) => flags[name] === true || flags[name] === 'true'); }
function requireArg(value: string | undefined, name: string): asserts value is string { if (!value) throw new UsageError(`Missing required ${name}`); }
function shouldRedact(flags: Flags): boolean { return !hasFlag(flags, 'no-redact'); }
function isRecord(value: unknown): value is JsonRecord { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function stringValue(value: unknown): string { return value === undefined || value === null ? '' : String(value); }
function parseMaybeJson(text: string): unknown { if (!text) return null; try { return JSON.parse(text); } catch { return text; } }
function eventArray(value: unknown): JsonRecord[] { return isRecord(value) && Array.isArray(value.events) ? value.events.filter(isRecord) : []; }
function sinceQuery(flags: Flags): string { const since = flagString(flags, 'since'); if (!since) return ''; if (/^\d+$/.test(since)) return `&since=${encodeURIComponent(since)}`; const parsed = Date.parse(since); return Number.isFinite(parsed) ? `&since=${encodeURIComponent(String(parsed))}` : ''; }
function redact(value: unknown, seen = new WeakSet<object>()): unknown { if (Array.isArray(value)) return value.map((item) => redact(item, seen)); if (!isRecord(value)) return value; if (seen.has(value)) return '[Circular]'; seen.add(value); const out: JsonRecord = {}; for (const [key, child] of Object.entries(value)) out[key] = SECRET_KEY_RE.test(key) ? '[REDACTED]' : redact(child, seen); return out; }
function helpText(): string { return `ctxmill-bundle.ts — collect a ctxmill debug bundle\n\nUsage:\n  bun scripts/ctxmill-bundle.ts --agent <agentId> [--session <sessionId>] [--conversation <conversationId>] [--out <dir>]\n\nFlags:\n  --base-url <url>       ctxmill API root\n  --api-token <token>    Bearer token (default: CTXMILL_API_TOKEN)\n  --agent <agentId>      Agent id\n  --session <sessionId>  Turn/run id\n  --conversation <id>    Conversation id\n  --events-limit <n>     Number of recent events (default 200)\n  --out <dir>            Output directory (default .ctxmill/debug/<timestamp>)\n  --no-redact            Disable secret redaction\n`; }
