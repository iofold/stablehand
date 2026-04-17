#!/usr/bin/env bun

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

type JsonRecord = Record<string, unknown>;
type Flags = Record<string, string | boolean>;

interface ParsedArgs {
  positionals: string[];
  flags: Flags;
}

interface RequestMeta {
  method: string;
  endpoint: string;
  url: string;
}

interface CommandResult {
  command: string;
  meta: RequestMeta;
  data: unknown;
  warnings: string[];
  pretty: (data: unknown) => string;
}

class UsageError extends Error {
  exitCode = 2;
}

class ApiError extends Error {
  exitCode = 1;
  constructor(message: string, readonly status: number, readonly data: unknown, readonly meta: RequestMeta) {
    super(message);
  }
}

const SECRET_KEY_RE = /(secret|token|password|authorization|api[_-]?key|credential|private[_-]?key)/i;
const TERMINAL_STATUSES = new Set(['COMPLETED', 'ERROR', 'CANCELLED', 'TERMINATED', 'completed', 'error', 'cancelled']);

const parsed = parseArgs(Bun.argv.slice(2));

try {
  const result = await run(parsed);
  await emitResult(result, parsed.flags);
} catch (error) {
  await emitError(error, parsed.flags);
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags: Flags = {};
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('--') || arg === '--') {
      positionals.push(arg);
      continue;
    }

    const withoutPrefix = arg.slice(2);
    const eq = withoutPrefix.indexOf('=');
    if (eq !== -1) {
      flags[withoutPrefix.slice(0, eq)] = withoutPrefix.slice(eq + 1);
      continue;
    }

    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[withoutPrefix] = next;
      i += 1;
    } else {
      flags[withoutPrefix] = true;
    }
  }

  return { positionals, flags };
}

async function run(args: ParsedArgs): Promise<CommandResult> {
  const [group, action, third, fourth] = args.positionals;
  if (!group || group === 'help' || hasFlag(args.flags, 'help', 'h')) {
    return localResult('help', helpText(), () => helpText());
  }

  switch (group) {
    case 'health':
      return getCommand('health', 'GET', '/api/health', formatHealth, args.flags);
    case 'config':
      return getCommand('config', 'GET', '/api/config', formatJsonSummary, args.flags);
    case 'sandbox':
      if (action === 'metrics') return getCommand('sandbox metrics', 'GET', '/api/sandbox/metrics', formatSandboxMetrics, args.flags);
      break;
    case 'agents':
      return agentCommand(action, third, args.flags);
    case 'sessions':
      return sessionCommand(action, third, fourth, args.flags);
    case 'runs':
      return sessionCommand(action, third, fourth, args.flags, 'runs');
    case 'conversations':
      return conversationCommand(action, third, fourth, args.flags);
    case 'interrupts':
      return interruptCommand(action, third, args.flags);
    case 'events':
      return eventCommand(action, third, args.flags);
    case 'tools':
      return toolCommand(action, third, args.flags);
    case 'artifacts':
      return artifactCommand(action, third, args.flags);
    case 'files':
      return fileCommand(action, third, args.flags);
    case 'triggers':
      return triggerCommand(action, third, args.flags);
    default:
      break;
  }

  throw new UsageError(`Unknown command: ${args.positionals.join(' ') || '<none>'}\n\n${helpText()}`);
}

async function agentCommand(action: string | undefined, id: string | undefined, flags: Flags): Promise<CommandResult> {
  switch (action) {
    case 'list':
    case undefined:
      return getCommand('agents list', 'GET', '/api/agents', formatAgents, flags);
    case 'get':
      requireArg(id, 'agentId');
      return getCommand('agents get', 'GET', `/api/agents/${encodeURIComponent(id)}`, formatAgent, flags);
    case 'versions':
      requireArg(id, 'agentId');
      return getCommand('agents versions', 'GET', `/api/agents/${encodeURIComponent(id)}/versions`, formatJsonSummary, flags);
    default:
      throw new UsageError(`Unknown agents command: ${action}`);
  }
}

async function sessionCommand(action: string | undefined, agentId: string | undefined, sessionId: string | undefined, flags: Flags, noun = 'sessions'): Promise<CommandResult> {
  switch (action) {
    case 'list':
    case undefined:
      requireArg(agentId, 'agentId');
      return getCommand(`${noun} list`, 'GET', `/api/agents/${encodeURIComponent(agentId)}/sessions`, formatSessions, flags);
    case 'active': {
      const endpoint = hasFlag(flags, 'sandbox') ? '/api/sessions?format=sandbox' : '/api/sessions';
      return getCommand(`${noun} active`, 'GET', endpoint, formatActiveSessions, flags);
    }
    case 'get':
      requireArg(agentId, 'agentId');
      requireArg(sessionId, 'sessionId');
      return getCommand(`${noun} get`, 'GET', `/api/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}`, formatSessionDetail, flags);
    case 'cancel':
      requireArg(agentId, 'agentId');
      requireArg(sessionId, 'sessionId');
      return requestCommand(`${noun} cancel`, 'POST', `/api/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}/cancel`, undefined, formatJsonSummary, flags);
    default:
      throw new UsageError(`Unknown ${noun} command: ${action}`);
  }
}

async function conversationCommand(action: string | undefined, agentId: string | undefined, convId: string | undefined, flags: Flags): Promise<CommandResult> {
  requireArg(agentId, 'agentId');
  switch (action) {
    case 'list':
    case undefined:
      return getCommand('conversations list', 'GET', `/api/agents/${encodeURIComponent(agentId)}/conversations`, formatConversations, flags);
    case 'summary':
      return getCommand('conversations summary', 'GET', `/api/agents/${encodeURIComponent(agentId)}/conversations/summary`, formatConversationSummaries, flags);
    case 'messages':
      requireArg(convId, 'conversationId');
      return getCommand('conversations messages', 'GET', `/api/agents/${encodeURIComponent(agentId)}/conversations/${encodeURIComponent(convId)}/messages`, formatMessages, flags);
    default:
      throw new UsageError(`Unknown conversations command: ${action}`);
  }
}

async function interruptCommand(action: string | undefined, agentId: string | undefined, flags: Flags): Promise<CommandResult> {
  requireArg(agentId, 'agentId');
  switch (action) {
    case 'list': {
      const query = hasFlag(flags, 'include-resolved') ? '?include_resolved=true' : '';
      return getCommand('interrupts list', 'GET', `/api/agents/${encodeURIComponent(agentId)}/interrupts${query}`, formatInterrupts, flags);
    }
    case 'resolve': {
      const sessionId = flagString(flags, 'session', 'session-id');
      const actionValue = flagString(flags, 'action') ?? 'approve';
      requireArg(sessionId, 'sessionId via --session');
      if (!['approve', 'reject', 'submit'].includes(actionValue)) {
        throw new UsageError('--action must be approve, reject, or submit');
      }
      const body: JsonRecord = { action: actionValue, sessionId };
      const data = flagString(flags, 'data');
      if (data !== undefined) body.data = parseJsonFlag(data, '--data');
      return requestCommand('interrupts resolve', 'POST', `/api/agents/${encodeURIComponent(agentId)}/interrupt`, body, formatJsonSummary, flags);
    }
    default:
      throw new UsageError(`Unknown interrupts command: ${action}`);
  }
}

async function eventCommand(action: string | undefined, _unused: string | undefined, flags: Flags): Promise<CommandResult> {
  switch (action) {
    case 'list':
    case undefined: {
      const query = buildQuery({
        agentId: flagString(flags, 'agent', 'agent-id'),
        type: flagString(flags, 'type'),
        since: normalizeSince(flagString(flags, 'since')),
        limit: flagString(flags, 'limit') ?? '50',
        cursor: flagString(flags, 'cursor'),
      });
      return getCommand('events list', 'GET', `/api/events${query}`, formatEvents, flags);
    }
    case 'types':
      return getCommand('events types', 'GET', '/api/events/types', formatJsonSummary, flags);
    case 'stats': {
      const range = flagString(flags, 'range') ?? '24h';
      return getCommand('events stats', 'GET', `/api/events/stats?range=${encodeURIComponent(range)}`, formatJsonSummary, flags);
    }
    default:
      throw new UsageError(`Unknown events command: ${action}`);
  }
}

async function toolCommand(action: string | undefined, toolName: string | undefined, flags: Flags): Promise<CommandResult> {
  switch (action) {
    case 'list':
    case undefined:
      return getCommand('tools list', 'GET', '/api/catalogs/tools', formatTools, flags);
    case 'test': {
      requireArg(toolName, 'toolName');
      const input = parseJsonFlag(flagString(flags, 'input') ?? '{}', '--input');
      return requestCommand('tools test', 'POST', '/api/catalogs/tools/test', { toolName, input }, formatJsonSummary, flags);
    }
    default:
      throw new UsageError(`Unknown tools command: ${action}`);
  }
}

async function artifactCommand(action: string | undefined, id: string | undefined, flags: Flags): Promise<CommandResult> {
  switch (action) {
    case 'list':
    case undefined: {
      const agentId = flagString(flags, 'agent', 'agent-id');
      const sessionId = flagString(flags, 'session', 'session-id');
      if (!agentId && !sessionId) throw new UsageError('artifacts list requires --agent <agentId> or --session <sessionId>');
      const query = buildQuery({ agentId, sessionId, limit: flagString(flags, 'limit') ?? '100', offset: flagString(flags, 'offset') });
      return getCommand('artifacts list', 'GET', `/api/artifacts${query}`, formatArtifacts, flags);
    }
    case 'get':
      requireArg(id, 'artifactId');
      return getCommand('artifacts get', 'GET', `/api/artifacts/${encodeURIComponent(id)}`, formatJsonSummary, flags);
    case 'download-url':
      requireArg(id, 'artifactId');
      return getCommand('artifacts download-url', 'GET', `/api/artifacts/${encodeURIComponent(id)}/download-url`, formatJsonSummary, flags);
    default:
      throw new UsageError(`Unknown artifacts command: ${action}`);
  }
}

async function fileCommand(action: string | undefined, agentId: string | undefined, flags: Flags): Promise<CommandResult> {
  requireArg(agentId, 'agentId');
  const path = flagString(flags, 'path') ?? '.';
  const sessionId = flagString(flags, 'session', 'session-id');
  switch (action) {
    case 'ls': {
      const query = buildQuery({ path, sessionId });
      return getCommand('files ls', 'GET', `/api/agents/${encodeURIComponent(agentId)}/files${query}`, formatFiles, flags);
    }
    case 'cat': {
      if (!flagString(flags, 'path')) throw new UsageError('files cat requires --path <path>');
      const query = buildQuery({ path, sessionId });
      return getCommand('files cat', 'GET', `/api/agents/${encodeURIComponent(agentId)}/files/read${query}`, formatFileRead, flags);
    }
    default:
      throw new UsageError(`Unknown files command: ${action}`);
  }
}

async function triggerCommand(action: string | undefined, id: string | undefined, flags: Flags): Promise<CommandResult> {
  switch (action) {
    case 'list':
    case undefined: {
      const query = buildQuery({ agentId: flagString(flags, 'agent', 'agent-id') });
      return getCommand('triggers list', 'GET', `/api/triggers${query}`, formatJsonSummary, flags);
    }
    case 'get':
      requireArg(id, 'triggerId');
      return getCommand('triggers get', 'GET', `/api/triggers/${encodeURIComponent(id)}`, formatJsonSummary, flags);
    default:
      throw new UsageError(`Unknown triggers command: ${action}`);
  }
}

async function getCommand(command: string, method: string, endpoint: string, pretty: (data: unknown) => string, flags: Flags): Promise<CommandResult> {
  return requestCommand(command, method, endpoint, undefined, pretty, flags);
}

async function requestCommand(command: string, method: string, endpoint: string, body: unknown, pretty: (data: unknown) => string, flags: Flags): Promise<CommandResult> {
  const { data, meta } = await requestJson(endpoint, { method, body }, flags);
  return { command, meta, data, warnings: [], pretty };
}

function localResult(command: string, data: unknown, pretty: (data: unknown) => string): CommandResult {
  return {
    command,
    meta: { method: 'LOCAL', endpoint: '<local>', url: '<local>' },
    data,
    warnings: [],
    pretty,
  };
}

async function requestJson(endpoint: string, init: { method: string; body?: unknown }, flags: Flags): Promise<{ data: unknown; meta: RequestMeta }> {
  const baseUrl = getBaseUrl(flags);
  const url = buildUrl(baseUrl, endpoint);
  const headers: Record<string, string> = { Accept: 'application/json' };
  const requestInit: RequestInit = { method: init.method, headers };

  if (init.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    requestInit.body = JSON.stringify(init.body);
  }

  const meta = { method: init.method, endpoint, url };
  const response = await fetch(url, requestInit);
  const text = await response.text();
  const data = parseMaybeJson(text);

  if (!response.ok) {
    throw new ApiError(`${init.method} ${endpoint} failed with HTTP ${response.status}`, response.status, data, meta);
  }

  return { data, meta };
}

function getBaseUrl(flags: Flags): string {
  const raw = flagString(flags, 'base-url') ?? process.env.CTXMILL_API_URL ?? process.env.API_BASE ?? 'http://localhost:3002';
  return raw.replace(/\/+$/, '');
}

function buildUrl(baseUrl: string, endpoint: string): string {
  const url = new URL(baseUrl);
  const [endpointPathRaw, endpointQuery = ''] = endpoint.split('?');
  let endpointPath = endpointPathRaw!.startsWith('/') ? endpointPathRaw! : `/${endpointPathRaw}`;
  const basePath = url.pathname.replace(/\/+$/, '');

  if (basePath.endsWith('/api') && endpointPath.startsWith('/api/')) {
    endpointPath = endpointPath.slice('/api'.length);
  }

  url.pathname = `${basePath}${endpointPath}`.replace(/\/+/g, '/');
  url.search = endpointQuery ? `?${endpointQuery}` : '';
  return url.toString();
}

async function emitResult(result: CommandResult, flags: Flags): Promise<void> {
  const redacted = shouldRedact(flags) ? redact(result.data) : result.data;
  const envelope = {
    command: result.command,
    baseUrl: getBaseUrl(flags),
    endpoint: `${result.meta.method} ${result.meta.endpoint}`,
    data: redacted,
    warnings: result.warnings,
  };

  const outDir = flagString(flags, 'out');
  if (outDir) {
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, `${slug(result.command)}.json`), JSON.stringify(envelope, null, 2));
  }

  if (hasFlag(flags, 'raw')) {
    console.log(JSON.stringify(redacted, null, 2));
    return;
  }

  if (hasFlag(flags, 'json')) {
    console.log(JSON.stringify(envelope, null, 2));
    return;
  }

  console.log(result.pretty(redacted));
}

async function emitError(error: unknown, flags: Flags): Promise<never> {
  const exitCode = getExitCode(error);
  const payload = error instanceof ApiError
    ? { error: error.message, status: error.status, endpoint: `${error.meta.method} ${error.meta.endpoint}`, data: shouldRedact(flags) ? redact(error.data) : error.data }
    : { error: error instanceof Error ? error.message : String(error) };

  if (hasFlag(flags, 'json')) {
    console.error(JSON.stringify(payload, null, 2));
  } else {
    console.error(payload.error);
    if (error instanceof ApiError) console.error(JSON.stringify(payload.data, null, 2));
  }

  process.exit(exitCode);
}

function getExitCode(error: unknown): number {
  if (error instanceof UsageError) return error.exitCode;
  if (error instanceof ApiError) return error.exitCode;
  return 1;
}

function requireArg(value: string | undefined, name: string): asserts value is string {
  if (!value) throw new UsageError(`Missing required ${name}`);
}

function flagString(flags: Flags, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = flags[name];
    if (typeof value === 'string') return value;
    if (value === true) return 'true';
  }
  return undefined;
}

function hasFlag(flags: Flags, ...names: string[]): boolean {
  return names.some((name) => flags[name] === true || flags[name] === 'true');
}

function shouldRedact(flags: Flags): boolean {
  return !hasFlag(flags, 'no-redact');
}

function parseJsonFlag(value: string, flagName: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new UsageError(`${flagName} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseMaybeJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function buildQuery(params: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') query.set(key, String(value));
  }
  const rendered = query.toString();
  return rendered ? `?${rendered}` : '';
}

function normalizeSince(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return value;
  const parsedDate = Date.parse(value);
  if (Number.isFinite(parsedDate)) return String(parsedDate);
  const relative = value.match(/^now-(\d+)(s|m|h|d)$/);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2];
    const multiplier = unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
    return String(Date.now() - amount * multiplier);
  }
  throw new UsageError('--since must be epoch ms, ISO datetime, or now-<n>s|m|h|d');
}

function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (Array.isArray(value)) return value.map((item) => redact(item, seen));
  if (!isRecord(value)) return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  const out: JsonRecord = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = SECRET_KEY_RE.test(key) ? '[REDACTED]' : redact(child, seen);
  }
  return out;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'result';
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function getString(obj: unknown, key: string): string {
  if (!isRecord(obj)) return '';
  const value = obj[key];
  return value === undefined || value === null ? '' : String(value);
}

function getNumber(obj: unknown, key: string): number | undefined {
  if (!isRecord(obj)) return undefined;
  const value = obj[key];
  return typeof value === 'number' ? value : undefined;
}

function getNestedArray(obj: unknown, key: string): unknown[] {
  return isRecord(obj) ? asArray(obj[key]) : [];
}

function formatTime(value: unknown): string {
  if (typeof value === 'number') return new Date(value).toISOString();
  if (typeof value === 'string' && /^\d+$/.test(value)) return new Date(Number(value)).toISOString();
  if (typeof value === 'string') return value;
  return '';
}

function truncate(value: unknown, max = 100): string {
  const text = typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value);
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function table(rows: Array<Record<string, unknown>>, columns: Array<[string, string, number?]>): string {
  if (rows.length === 0) return '(none)';
  const renderedRows = rows.map((row) => columns.map(([key, _label, max]) => truncate(row[key], max ?? 40)));
  const widths = columns.map(([_key, label], index) => Math.max(label.length, ...renderedRows.map((row) => row[index]!.length)));
  const header = columns.map(([_key, label], index) => label.padEnd(widths[index]!)).join('  ');
  const divider = widths.map((width) => '-'.repeat(width)).join('  ');
  const body = renderedRows.map((row) => row.map((cell, index) => cell.padEnd(widths[index]!)).join('  ')).join('\n');
  return `${header}\n${divider}\n${body}`;
}

function formatHealth(data: unknown): string {
  if (!isRecord(data)) return JSON.stringify(data, null, 2);
  const lines = [`status: ${String(data.status ?? 'unknown')}`];
  if (data.timestamp) lines.push(`timestamp: ${String(data.timestamp)}`);
  if (isRecord(data.sandbox) && isRecord(data.sandbox.containers)) {
    lines.push(`containers: active=${data.sandbox.containers.active ?? '?'} queued=${data.sandbox.containers.queued ?? '?'} peak=${data.sandbox.containers.peak ?? '?'}`);
  }
  return lines.join('\n');
}

function formatSandboxMetrics(data: unknown): string {
  if (!isRecord(data)) return JSON.stringify(data, null, 2);
  const containers = isRecord(data.containers) ? data.containers : {};
  return [
    `execution_mode: ${String(data.execution_mode ?? 'unknown')}`,
    `active: ${String(containers.active ?? '?')}`,
    `queued: ${String(containers.queued ?? '?')}`,
    `peak: ${String(containers.peak ?? '?')}`,
    `total_created: ${String(containers.total_created ?? '?')}`,
  ].join('\n');
}

function formatAgents(data: unknown): string {
  const rows = asArray(data).map((agent) => ({
    id: getString(agent, 'id'),
    name: getString(agent, 'name'),
    harness: getString(agent, 'harness'),
    status: getString(agent, 'status'),
    active: getString(agent, 'activeSessions'),
    interrupt: getString(agent, 'hasPendingInterrupt'),
  }));
  return table(rows, [['id', 'ID', 12], ['name', 'NAME', 28], ['harness', 'HARNESS', 16], ['status', 'STATUS', 12], ['active', 'ACTIVE', 8], ['interrupt', 'HITL', 6]]);
}

function formatAgent(data: unknown): string {
  if (!isRecord(data)) return JSON.stringify(data, null, 2);
  const tools = Array.isArray(data.tools) ? data.tools.join(', ') : '';
  return [
    `${String(data.name ?? '<unnamed>')} (${String(data.id ?? 'no-id')})`,
    `status: ${String(data.status ?? 'unknown')}`,
    `harness: ${String(data.harness ?? 'unknown')}`,
    `version: ${String(data.version ?? 'unknown')}`,
    `workspace: ${String(data.workspaceDir ?? '')}`,
    `tools: ${tools}`,
    `pending_interrupt: ${String(data.hasPendingInterrupt ?? false)}`,
    `sessions_by_status: ${JSON.stringify(data.sessionsByStatus ?? {})}`,
  ].join('\n');
}

function formatSessions(data: unknown): string {
  const rows = getNestedArray(data, 'sessions').map((session) => ({
    id: getString(session, 'id'),
    status: getString(session, 'status'),
    mode: getString(session, 'mode'),
    conversation: getString(session, 'conversationId'),
    started: formatTime(getNumber(session, 'startedAt')),
    error: getString(session, 'error'),
  }));
  return table(rows, [['id', 'ID', 12], ['status', 'STATUS', 14], ['mode', 'MODE', 12], ['conversation', 'CONVERSATION', 12], ['started', 'STARTED', 24], ['error', 'ERROR', 40]]);
}

function formatActiveSessions(data: unknown): string {
  const rows = asArray(data).map((session) => ({
    id: getString(session, 'id') || getString(session, 'latestTurnId'),
    agent: getString(session, 'agentId'),
    status: getString(session, 'status'),
    conversation: getString(session, 'conversationId'),
    updated: getString(session, 'updatedAt') || getString(session, 'lastActivityAt'),
    task: getString(session, 'taskDescription'),
  }));
  return table(rows, [['id', 'ID', 12], ['agent', 'AGENT', 12], ['status', 'STATUS', 14], ['conversation', 'CONVERSATION', 12], ['updated', 'UPDATED', 24], ['task', 'TASK', 42]]);
}

function formatSessionDetail(data: unknown): string {
  if (!isRecord(data)) return JSON.stringify(data, null, 2);
  const session = isRecord(data.session) ? data.session : {};
  const messages = asArray(data.messages);
  const status = getString(session, 'completedAt') ? 'COMPLETED' : getString(session, 'error') ? 'ERROR' : 'ACTIVE/PENDING';
  return [
    `session: ${String(session.id ?? '')}`,
    `agent: ${String(session.agentId ?? '')}`,
    `conversation: ${String(session.conversationId ?? '')}`,
    `status: ${status}`,
    `started: ${formatTime(session.startedAt)}`,
    `completed: ${formatTime(session.completedAt)}`,
    `error: ${String(session.error ?? '')}`,
    `messages: ${messages.length}`,
  ].join('\n');
}

function formatConversations(data: unknown): string {
  const rows = asArray(data).map((conversation) => ({
    id: getString(conversation, 'id'),
    agent: getString(conversation, 'agentId'),
    created: formatTime(getNumber(conversation, 'createdAt')),
    updated: formatTime(getNumber(conversation, 'updatedAt')),
  }));
  return table(rows, [['id', 'ID', 12], ['agent', 'AGENT', 12], ['created', 'CREATED', 24], ['updated', 'UPDATED', 24]]);
}

function formatConversationSummaries(data: unknown): string {
  const rows = getNestedArray(data, 'conversations').map((conversation) => ({
    id: getString(conversation, 'id'),
    status: getString(conversation, 'status'),
    mode: getString(conversation, 'mode'),
    turns: getString(conversation, 'turnCount'),
    messages: getString(conversation, 'messageCount'),
    latest: getString(conversation, 'latestTurnId'),
    task: getString(conversation, 'taskDescription'),
  }));
  return table(rows, [['id', 'ID', 12], ['status', 'STATUS', 14], ['mode', 'MODE', 12], ['turns', 'TURNS', 6], ['messages', 'MSGS', 6], ['latest', 'LATEST', 12], ['task', 'TASK', 48]]);
}

function formatMessages(data: unknown): string {
  const rows = asArray(data).map((message) => ({
    id: getString(message, 'id'),
    role: getString(message, 'role'),
    created: getString(message, 'createdAt'),
    toolCalls: Array.isArray(isRecord(message) ? message.toolCalls : undefined) ? String((message as JsonRecord).toolCalls?.length) : '',
    content: getString(message, 'content'),
  }));
  return table(rows, [['id', 'ID', 12], ['role', 'ROLE', 10], ['created', 'CREATED', 24], ['toolCalls', 'TOOLS', 6], ['content', 'CONTENT', 90]]);
}

function formatInterrupts(data: unknown): string {
  const rows = getNestedArray(data, 'interrupts').map((interrupt) => ({
    id: getString(interrupt, 'id'),
    session: getString(interrupt, 'sessionId'),
    status: getString(interrupt, 'status'),
    tool: getString(interrupt, 'toolName'),
    call: getString(interrupt, 'toolCallId'),
    created: formatTime(getNumber(interrupt, 'createdAt')),
  }));
  return table(rows, [['id', 'ID', 12], ['session', 'SESSION', 12], ['status', 'STATUS', 12], ['tool', 'TOOL', 28], ['call', 'CALL', 14], ['created', 'CREATED', 24]]);
}

function formatEvents(data: unknown): string {
  const rows = getNestedArray(data, 'events').map((event) => ({
    seq: getString(event, 'seq'),
    type: getString(event, 'type'),
    agent: getString(event, 'agentId'),
    created: formatTime(getNumber(event, 'createdAt')),
    payload: getString(event, 'payload'),
  }));
  const next = isRecord(data) && data.nextCursor ? `\nnextCursor: ${String(data.nextCursor)}` : '';
  return table(rows, [['seq', 'SEQ', 8], ['type', 'TYPE', 32], ['agent', 'AGENT', 12], ['created', 'CREATED', 24], ['payload', 'PAYLOAD', 80]]) + next;
}

function formatTools(data: unknown): string {
  const rows = asArray(data).map((tool) => ({
    name: getString(tool, 'name'),
    source: getString(tool, 'source'),
    location: getString(tool, 'location'),
    approval: getString(tool, 'requiresApproval'),
    description: getString(tool, 'description'),
  }));
  return table(rows, [['name', 'NAME', 32], ['source', 'SOURCE', 12], ['location', 'LOCATION', 12], ['approval', 'HITL', 6], ['description', 'DESCRIPTION', 80]]);
}

function formatArtifacts(data: unknown): string {
  const rows = getNestedArray(data, 'artifacts').map((artifact) => ({
    id: getString(artifact, 'id'),
    name: getString(artifact, 'name'),
    status: getString(artifact, 'status'),
    mime: getString(artifact, 'mimeType'),
    size: getString(artifact, 'sizeBytes'),
    created: formatTime(getNumber(artifact, 'createdAt')),
  }));
  return table(rows, [['id', 'ID', 12], ['name', 'NAME', 32], ['status', 'STATUS', 16], ['mime', 'MIME', 24], ['size', 'BYTES', 10], ['created', 'CREATED', 24]]);
}

function formatFiles(data: unknown): string {
  const rows = getNestedArray(data, 'entries').map((entry) => ({
    name: getString(entry, 'name'),
    type: getString(entry, 'type'),
    size: getString(entry, 'size'),
  }));
  return table(rows, [['type', 'TYPE', 10], ['size', 'BYTES', 10], ['name', 'NAME', 80]]);
}

function formatFileRead(data: unknown): string {
  if (!isRecord(data)) return JSON.stringify(data, null, 2);
  return `path: ${String(data.path ?? '')}\nsize: ${String(data.size ?? '')}\n\n${String(data.content ?? '')}`;
}

function formatJsonSummary(data: unknown): string {
  if (Array.isArray(data)) return table(data.map((item, index) => ({ index, value: JSON.stringify(item) })), [['index', '#', 4], ['value', 'VALUE', 120]]);
  return JSON.stringify(data, null, 2);
}

function helpText(): string {
  return `ctxmill-debug.ts — agent-friendly ctxmill API CLI\n\nUsage:\n  bun scripts/ctxmill-debug.ts <command> [args] [flags]\n\nGlobal flags:\n  --base-url <url>       ctxmill API root (default: CTXMILL_API_URL, API_BASE, or http://localhost:3002)\n  --json                 Emit stable JSON envelope\n  --raw                  Emit raw API payload\n  --out <dir>            Save full JSON envelope to a directory\n  --no-redact            Do not redact secret-like fields\n  --help                 Show this help\n\nCommands:\n  health\n  config\n  sandbox metrics\n\n  agents list\n  agents get <agentId>\n  agents versions <agentId>\n\n  sessions list <agentId>\n  sessions active [--sandbox]\n  sessions get <agentId> <sessionId>\n  sessions cancel <agentId> <sessionId>\n  runs list|get|active|cancel ...     Alias for sessions\n\n  conversations list <agentId>\n  conversations summary <agentId>\n  conversations messages <agentId> <conversationId>\n\n  interrupts list <agentId> [--include-resolved]\n  interrupts resolve <agentId> --session <sessionId> --action approve|reject|submit [--data '{}']\n\n  events list [--agent <agentId>] [--type <type>] [--since <ms|iso|now-5m>] [--limit 50] [--cursor n]\n  events types\n  events stats [--range 1h|24h|7d]\n\n  tools list\n  tools test <toolName> --input '{}'\n\n  artifacts list (--agent <agentId> | --session <sessionId>) [--limit 100] [--offset 0]\n  artifacts get <artifactId>\n  artifacts download-url <artifactId>\n\n  files ls <agentId> [--session <sessionId>] [--path .]\n  files cat <agentId> [--session <sessionId>] --path <file>\n\n  triggers list [--agent <agentId>]\n  triggers get <triggerId>\n\nExamples:\n  bun scripts/ctxmill-debug.ts health\n  bun scripts/ctxmill-debug.ts agents list --json\n  bun scripts/ctxmill-debug.ts sessions get agent_123 run_456 --out .ctxmill/debug/current\n`;
}
