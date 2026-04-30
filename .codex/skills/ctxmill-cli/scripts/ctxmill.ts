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
    case 'sandbox-sessions':
      return sandboxSessionCommand(action, third, fourth, args.flags);
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
    case 'secrets':
      return secretCommand(action, third, fourth, args.flags);
    case 'settings':
      return settingsCommand(action, args.flags);
    case 'feedback':
      return feedbackCommand(action, third, args.flags);
    case 'traces':
      return traceCommand(action, third, args.flags);
    case 'webhooks':
      return webhookCommand(action, third, fourth, args.flags);
    case 'knowledge':
      return knowledgeCommand(action, third, fourth, args.flags);
    case 'stream':
      return streamCommand(action, args.flags);
    case 'run':
      return runCommand(action, args.flags);
    case 'workspace':
      return workspaceCommand(action, third, args.flags);
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
    case 'create': {
      const body = await loadBody(flags, { required: true, hint: 'agent definition (name, harness, harnessConfig, systemPrompt, tools, ...)' });
      return requestCommand('agents create', 'POST', '/api/agents', body, formatJsonSummary, flags);
    }
    case 'update': {
      requireArg(id, 'agentId');
      const body = await loadBody(flags, { required: true, hint: 'partial agent definition' });
      return requestCommand('agents update', 'PUT', `/api/agents/${encodeURIComponent(id)}`, body, formatJsonSummary, flags);
    }
    case 'delete':
      requireArg(id, 'agentId');
      confirmDestructive(`agents delete ${id} (cascades sessions, conversations, artifacts)`, flags);
      return requestCommand('agents delete', 'DELETE', `/api/agents/${encodeURIComponent(id)}`, undefined, formatJsonSummary, flags);
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
    case 'turns':
      requireArg(agentId, 'agentId');
      return getCommand(`${noun} turns`, 'GET', `/api/agents/${encodeURIComponent(agentId)}/turns`, formatJsonSummary, flags);
    case 'message': {
      requireArg(agentId, 'agentId');
      const content = flagString(flags, 'content');
      requireArg(content, 'content via --content');
      const body: JsonRecord = { content };
      const conversationId = flagString(flags, 'conversation', 'conversation-id');
      if (conversationId) body.conversationId = conversationId;
      const result = await requestCommand(`${noun} message`, 'POST', `/api/agents/${encodeURIComponent(agentId)}/message`, body, formatJsonSummary, flags);
      return maybeWaitForSession(agentId, result, flags);
    }
    case 'start': {
      requireArg(agentId, 'agentId');
      const task = flagString(flags, 'task');
      requireArg(task, 'task via --task');
      const body: JsonRecord = { task };
      const mode = flagString(flags, 'mode');
      if (mode) body.mode = mode;
      const secrets = flagString(flags, 'sandbox-secrets');
      if (secrets) body.sandboxSecrets = parseJsonFlag(secrets, '--sandbox-secrets');
      const result = await requestCommand(`${noun} start`, 'POST', `/api/agents/${encodeURIComponent(agentId)}/session`, body, formatJsonSummary, flags);
      return maybeWaitForSession(agentId, result, flags);
    }
    default:
      throw new UsageError(`Unknown ${noun} command: ${action}`);
  }
}

async function sandboxSessionCommand(action: string | undefined, agentId: string | undefined, sandboxSessionId: string | undefined, flags: Flags): Promise<CommandResult> {
  requireArg(agentId, 'agentId');
  requireArg(sandboxSessionId, 'sandboxSessionId');
  const base = `/api/agents/${encodeURIComponent(agentId)}/sandbox-sessions/${encodeURIComponent(sandboxSessionId)}`;
  switch (action) {
    case 'suspend':
      return requestCommand('sandbox-sessions suspend', 'POST', `${base}/suspend`, undefined, formatJsonSummary, flags);
    case 'kill':
      return requestCommand('sandbox-sessions kill', 'POST', `${base}/kill`, undefined, formatJsonSummary, flags);
    default:
      throw new UsageError(`Unknown sandbox-sessions command: ${action}`);
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
    case 'upload-url': {
      const agentId = flagString(flags, 'agent', 'agent-id');
      const name = flagString(flags, 'name');
      requireArg(agentId, 'agentId via --agent');
      requireArg(name, 'name via --name');
      const body: JsonRecord = { agentId, name };
      const mime = flagString(flags, 'mime', 'mime-type');
      if (mime) body.mimeType = mime;
      const size = flagString(flags, 'size', 'size-bytes');
      if (size) body.sizeBytes = Number(size);
      return requestCommand('artifacts upload-url', 'POST', '/api/artifacts/upload-url', body, formatJsonSummary, flags);
    }
    case 'upload': {
      const agentId = flagString(flags, 'agent', 'agent-id');
      const filePath = flagString(flags, 'file');
      requireArg(agentId, 'agentId via --agent');
      requireArg(filePath, 'file path via --file');
      const name = flagString(flags, 'name') ?? basename(filePath);
      const file = Bun.file(filePath);
      if (!(await file.exists())) throw new UsageError(`file not found: ${filePath}`);
      const form = new FormData();
      form.append('agentId', agentId);
      form.append('name', name);
      form.append('file', file, name);
      const { data, meta } = await requestRaw('/api/artifacts/upload', { method: 'POST', body: form }, flags);
      return { command: 'artifacts upload', meta, data, warnings: [], pretty: formatJsonSummary };
    }
    case 'delete':
      requireArg(id, 'artifactId');
      confirmDestructive(`artifacts delete ${id}`, flags);
      return requestCommand('artifacts delete', 'DELETE', `/api/artifacts/${encodeURIComponent(id)}`, undefined, formatJsonSummary, flags);
    default:
      throw new UsageError(`Unknown artifacts command: ${action}`);
  }
}

async function fileCommand(action: string | undefined, agentId: string | undefined, flags: Flags): Promise<CommandResult> {
  requireArg(agentId, 'agentId');
  const pathFlag = flagString(flags, 'path');
  const path = pathFlag ?? '.';
  const sessionId = flagString(flags, 'session', 'session-id');
  switch (action) {
    case 'ls': {
      const query = buildQuery({ path, sessionId });
      return getCommand('files ls', 'GET', `/api/agents/${encodeURIComponent(agentId)}/files${query}`, formatFiles, flags);
    }
    case 'cat': {
      if (!pathFlag) throw new UsageError('files cat requires --path <path>');
      const query = buildQuery({ path, sessionId });
      return getCommand('files cat', 'GET', `/api/agents/${encodeURIComponent(agentId)}/files/read${query}`, formatFileRead, flags);
    }
    case 'write':
    case 'update': {
      if (!pathFlag) throw new UsageError(`files ${action} requires --path <path>`);
      const content = await loadFileContent(flags);
      const body: JsonRecord = { path: pathFlag, content };
      const method = action === 'write' ? 'POST' : 'PUT';
      return requestCommand(`files ${action}`, method, `/api/agents/${encodeURIComponent(agentId)}/files`, body, formatJsonSummary, flags);
    }
    case 'delete': {
      if (!pathFlag) throw new UsageError('files delete requires --path <path>');
      confirmDestructive(`files delete ${agentId}:${pathFlag}`, flags);
      const query = buildQuery({ path: pathFlag, sessionId });
      return requestCommand('files delete', 'DELETE', `/api/agents/${encodeURIComponent(agentId)}/files${query}`, undefined, formatJsonSummary, flags);
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
      return getCommand('triggers list', 'GET', `/api/triggers${query}`, formatTriggers, flags);
    }
    case 'get':
      requireArg(id, 'triggerId');
      return getCommand('triggers get', 'GET', `/api/triggers/${encodeURIComponent(id)}`, formatJsonSummary, flags);
    case 'create': {
      const body = await loadBody(flags, { required: true, hint: 'trigger definition (agentId, eventType, selector, taskTemplate, enabled)' });
      return requestCommand('triggers create', 'POST', '/api/triggers', body, formatJsonSummary, flags);
    }
    case 'update': {
      requireArg(id, 'triggerId');
      const body = await loadBody(flags, { required: true, hint: 'partial trigger definition' });
      return requestCommand('triggers update', 'PUT', `/api/triggers/${encodeURIComponent(id)}`, body, formatJsonSummary, flags);
    }
    case 'delete':
      requireArg(id, 'triggerId');
      confirmDestructive(`triggers delete ${id}`, flags);
      return requestCommand('triggers delete', 'DELETE', `/api/triggers/${encodeURIComponent(id)}`, undefined, formatJsonSummary, flags);
    case 'emit': {
      const type = flagString(flags, 'type');
      requireArg(type, 'event type via --type');
      const body: JsonRecord = { type };
      const agentId = flagString(flags, 'agent', 'agent-id');
      if (agentId) body.agentId = agentId;
      const payload = flagString(flags, 'payload');
      if (payload) body.payload = parseJsonFlag(payload, '--payload');
      return requestCommand('triggers emit', 'POST', '/api/triggers/emit', body, formatJsonSummary, flags);
    }
    default:
      throw new UsageError(`Unknown triggers command: ${action}`);
  }
}

async function secretCommand(action: string | undefined, agentId: string | undefined, key: string | undefined, flags: Flags): Promise<CommandResult> {
  requireArg(agentId, 'agentId');
  const base = `/api/agents/${encodeURIComponent(agentId)}/secrets`;
  switch (action) {
    case 'list':
    case undefined:
      return getCommand('secrets list', 'GET', base, formatSecrets, flags);
    case 'set': {
      const k = flagString(flags, 'key') ?? key;
      const value = flagString(flags, 'value');
      requireArg(k, 'key via --key');
      requireArg(value, 'value via --value');
      return requestCommand('secrets set', 'POST', base, { key: k, value }, formatJsonSummary, flags);
    }
    case 'delete':
      requireArg(key, 'secret key');
      confirmDestructive(`secrets delete ${agentId}/${key}`, flags);
      return requestCommand('secrets delete', 'DELETE', `${base}/${encodeURIComponent(key)}`, undefined, formatJsonSummary, flags);
    default:
      throw new UsageError(`Unknown secrets command: ${action}`);
  }
}

async function settingsCommand(action: string | undefined, flags: Flags): Promise<CommandResult> {
  switch (action) {
    case 'get':
    case undefined:
      return getCommand('settings get', 'GET', '/api/settings', formatJsonSummary, flags);
    case 'set': {
      const body = await loadBody(flags, { required: true, hint: 'partial settings object (limits, timeouts, ...)' });
      return requestCommand('settings set', 'PUT', '/api/settings', body, formatJsonSummary, flags);
    }
    default:
      throw new UsageError(`Unknown settings command: ${action}`);
  }
}

async function feedbackCommand(action: string | undefined, agentId: string | undefined, flags: Flags): Promise<CommandResult> {
  requireArg(agentId, 'agentId');
  switch (action) {
    case 'submit': {
      const conversationId = flagString(flags, 'conversation', 'conversation-id');
      const messageId = flagString(flags, 'message', 'message-id');
      const type = flagString(flags, 'type');
      requireArg(conversationId, 'conversationId via --conversation');
      requireArg(messageId, 'messageId via --message');
      requireArg(type, 'type via --type (thumbs_up|thumbs_down)');
      if (!['thumbs_up', 'thumbs_down'].includes(type)) {
        throw new UsageError('--type must be thumbs_up or thumbs_down');
      }
      const body: JsonRecord = { conversationId, messageId, type };
      const comment = flagString(flags, 'comment');
      if (comment) body.comment = comment;
      return requestCommand('feedback submit', 'POST', `/api/agents/${encodeURIComponent(agentId)}/feedback`, body, formatJsonSummary, flags);
    }
    case 'stats':
      return getCommand('feedback stats', 'GET', `/api/agents/${encodeURIComponent(agentId)}/feedback/stats`, formatJsonSummary, flags);
    default:
      throw new UsageError(`Unknown feedback command: ${action}`);
  }
}

async function traceCommand(action: string | undefined, agentId: string | undefined, flags: Flags): Promise<CommandResult> {
  requireArg(agentId, 'agentId');
  switch (action) {
    case 'list':
    case undefined: {
      const query = buildQuery({ limit: flagString(flags, 'limit') });
      return getCommand('traces list', 'GET', `/api/agents/${encodeURIComponent(agentId)}/traces${query}`, formatJsonSummary, flags);
    }
    case 'stats':
      return getCommand('traces stats', 'GET', `/api/agents/${encodeURIComponent(agentId)}/traces/stats`, formatJsonSummary, flags);
    default:
      throw new UsageError(`Unknown traces command: ${action}`);
  }
}

async function webhookCommand(action: string | undefined, agentId: string | undefined, webhookId: string | undefined, flags: Flags): Promise<CommandResult> {
  requireArg(agentId, 'agentId');
  const base = `/api/agents/${encodeURIComponent(agentId)}/webhooks`;
  switch (action) {
    case 'list':
    case undefined:
      return getCommand('webhooks list', 'GET', base, formatWebhooks, flags);
    case 'add':
    case 'create': {
      const url = flagString(flags, 'url');
      const events = flagString(flags, 'events');
      requireArg(url, 'url via --url');
      requireArg(events, 'events via --events (comma-separated)');
      const body: JsonRecord = { url, events: events.split(',').map((e) => e.trim()).filter(Boolean) };
      const secret = flagString(flags, 'secret');
      if (secret) body.secret = secret;
      return requestCommand('webhooks add', 'POST', base, body, formatJsonSummary, flags);
    }
    case 'update': {
      requireArg(webhookId, 'webhookId');
      const body = await loadBody(flags, { required: true, hint: 'partial webhook (url, events, secret)' });
      return requestCommand('webhooks update', 'PUT', `${base}/${encodeURIComponent(webhookId)}`, body, formatJsonSummary, flags);
    }
    case 'delete':
      requireArg(webhookId, 'webhookId');
      confirmDestructive(`webhooks delete ${agentId}/${webhookId}`, flags);
      return requestCommand('webhooks delete', 'DELETE', `${base}/${encodeURIComponent(webhookId)}`, undefined, formatJsonSummary, flags);
    default:
      throw new UsageError(`Unknown webhooks command: ${action}`);
  }
}

async function knowledgeCommand(action: string | undefined, third: string | undefined, fourth: string | undefined, flags: Flags): Promise<CommandResult> {
  switch (action) {
    case 'search': {
      requireArg(third, 'agentId');
      const query = buildQuery({
        q: flagString(flags, 'q', 'query'),
        category: flagString(flags, 'category'),
        limit: flagString(flags, 'limit'),
        offset: flagString(flags, 'offset'),
      });
      return getCommand('knowledge search', 'GET', `/api/agents/${encodeURIComponent(third)}/knowledge${query}`, formatJsonSummary, flags);
    }
    case 'stats':
      requireArg(third, 'agentId');
      return getCommand('knowledge stats', 'GET', `/api/agents/${encodeURIComponent(third)}/knowledge/stats`, formatJsonSummary, flags);
    case 'get':
      requireArg(third, 'agentId');
      requireArg(fourth, 'itemId');
      return getCommand('knowledge get', 'GET', `/api/agents/${encodeURIComponent(third)}/knowledge/${encodeURIComponent(fourth)}`, formatJsonSummary, flags);
    case 'cross-search': {
      const query = buildQuery({
        q: flagString(flags, 'q', 'query'),
        category: flagString(flags, 'category'),
        limit: flagString(flags, 'limit'),
        offset: flagString(flags, 'offset'),
      });
      return getCommand('knowledge cross-search', 'GET', `/api/knowledge/search${query}`, formatJsonSummary, flags);
    }
    case 'shared':
      return knowledgeSharedCommand(third, fourth, flags);
    default:
      throw new UsageError(`Unknown knowledge command: ${action}`);
  }
}

async function knowledgeSharedCommand(action: string | undefined, itemId: string | undefined, flags: Flags): Promise<CommandResult> {
  switch (action) {
    case 'list':
    case undefined: {
      const query = buildQuery({
        q: flagString(flags, 'q', 'query'),
        category: flagString(flags, 'category'),
        limit: flagString(flags, 'limit'),
        offset: flagString(flags, 'offset'),
      });
      return getCommand('knowledge shared list', 'GET', `/api/knowledge/shared${query}`, formatJsonSummary, flags);
    }
    case 'stats':
      return getCommand('knowledge shared stats', 'GET', '/api/knowledge/shared/stats', formatJsonSummary, flags);
    case 'add': {
      const content = flagString(flags, 'content');
      requireArg(content, 'content via --content');
      const body: JsonRecord = { content };
      const category = flagString(flags, 'category');
      if (category) body.category = category;
      const source = flagString(flags, 'source');
      if (source) body.source = source;
      const effectiveness = flagString(flags, 'effectiveness');
      if (effectiveness) body.effectiveness = Number(effectiveness);
      return requestCommand('knowledge shared add', 'POST', '/api/knowledge/shared', body, formatJsonSummary, flags);
    }
    case 'delete':
      requireArg(itemId, 'itemId');
      confirmDestructive(`knowledge shared delete ${itemId}`, flags);
      return requestCommand('knowledge shared delete', 'DELETE', `/api/knowledge/shared/${encodeURIComponent(itemId)}`, undefined, formatJsonSummary, flags);
    default:
      throw new UsageError(`Unknown knowledge shared command: ${action}`);
  }
}

async function streamCommand(agentId: string | undefined, flags: Flags): Promise<CommandResult> {
  const id = agentId ?? flagString(flags, 'agent', 'agent-id');
  requireArg(id, 'agentId');
  const endpoint = `/api/agents/${encodeURIComponent(id)}/stream`;
  const baseUrl = getBaseUrl(flags);
  const url = buildUrl(baseUrl, endpoint);
  const meta: RequestMeta = { method: 'GET', endpoint, url };
  const limit = Number(flagString(flags, 'limit') ?? '0');
  const timeoutMs = Number(flagString(flags, 'timeout') ?? '0');
  const watchType = flagString(flags, 'until-type');
  const startedAt = Date.now();
  let count = 0;
  for await (const evt of sseStream(url, { method: 'GET' }, meta)) {
    const line = formatSseEvent(evt, flags);
    if (line) console.log(line);
    count += 1;
    if (limit > 0 && count >= limit) break;
    if (timeoutMs > 0 && Date.now() - startedAt > timeoutMs) break;
    if (watchType && eventTypeMatches(evt, watchType)) break;
  }
  return localResult('stream', { events: count, durationMs: Date.now() - startedAt }, () => `streamed ${count} events in ${Date.now() - startedAt}ms`);
}

async function runCommand(agentId: string | undefined, flags: Flags): Promise<CommandResult> {
  const id = agentId ?? flagString(flags, 'agent', 'agent-id');
  requireArg(id, 'agentId');
  const task = flagString(flags, 'task');
  const body = (await loadBody(flags)) ?? buildAgUiRunBody(task);
  const endpoint = `/api/ag-ui/${encodeURIComponent(id)}/run`;
  const baseUrl = getBaseUrl(flags);
  const url = buildUrl(baseUrl, endpoint);
  const meta: RequestMeta = { method: 'POST', endpoint, url };
  if (hasFlag(flags, 'no-stream')) {
    const { data } = await requestRaw(endpoint, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }, flags);
    return { command: 'run', meta, data, warnings: [], pretty: formatJsonSummary };
  }
  let count = 0;
  let lastEvent: { event?: string; data: string } | null = null;
  const startedAt = Date.now();
  for await (const evt of sseStream(url, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }, meta)) {
    const line = formatSseEvent(evt, flags);
    if (line) console.log(line);
    count += 1;
    lastEvent = evt;
    if (isTerminalAgUiEvent(evt)) break;
  }
  return localResult('run', { events: count, durationMs: Date.now() - startedAt, lastEvent }, () => `consumed ${count} SSE events in ${Date.now() - startedAt}ms`);
}

function buildAgUiRunBody(task: string | undefined): JsonRecord {
  const threadId = `cli-thread-${Date.now()}`;
  const runId = `cli-run-${Date.now()}`;
  const messages = task
    ? [{ id: `cli-msg-${Date.now()}`, role: 'user', content: task }]
    : [];
  return { threadId, runId, messages, state: {}, tools: [], context: [], forwardedProps: {} };
}

function isTerminalAgUiEvent(evt: { event?: string; data: string }): boolean {
  if (evt.event === 'RUN_FINISHED' || evt.event === 'RUN_ERROR' || evt.event === 'RUN_CANCELLED') return true;
  try {
    const parsed = JSON.parse(evt.data) as JsonRecord;
    const type = typeof parsed.type === 'string' ? parsed.type : '';
    if (['RUN_FINISHED', 'RUN_ERROR', 'RUN_CANCELLED', 'turn.completed', 'turn.error'].includes(type)) return true;
  } catch { /* non-json data */ }
  return false;
}

function eventTypeMatches(evt: { event?: string; data: string }, target: string): boolean {
  if (evt.event === target) return true;
  try {
    const parsed = JSON.parse(evt.data) as JsonRecord;
    return parsed.type === target;
  } catch {
    return false;
  }
}

function formatSseEvent(evt: { event?: string; data: string }, flags: Flags): string {
  if (hasFlag(flags, 'json')) {
    let parsed: unknown = evt.data;
    try { parsed = JSON.parse(evt.data); } catch { /* keep raw */ }
    return JSON.stringify({ event: evt.event ?? null, data: parsed });
  }
  const tag = evt.event ?? 'message';
  const dataPreview = truncate(evt.data, 200);
  return `[${tag}] ${dataPreview}`;
}

async function workspaceCommand(action: string | undefined, agentId: string | undefined, flags: Flags): Promise<CommandResult> {
  switch (action) {
    case 'upload': {
      requireArg(agentId, 'agentId');
      const filePath = flagString(flags, 'file');
      requireArg(filePath, 'tarball path via --file (must be a .tar.gz)');
      const file = Bun.file(filePath);
      if (!(await file.exists())) throw new UsageError(`file not found: ${filePath}`);
      const force = hasFlag(flags, 'force');
      const endpoint = `/api/agents/${encodeURIComponent(agentId)}/workspace${force ? '?force=true' : ''}`;
      const headers: Record<string, string> = { 'Content-Type': 'application/gzip', 'Content-Encoding': 'gzip' };
      const { data, meta } = await requestRaw(endpoint, { method: 'POST', body: file, headers }, flags);
      return { command: 'workspace upload', meta, data, warnings: [], pretty: formatJsonSummary };
    }
    default:
      throw new UsageError(`Unknown workspace command: ${action}`);
  }
}

async function maybeWaitForSession(agentId: string, started: CommandResult, flags: Flags): Promise<CommandResult> {
  const waitFor = flagString(flags, 'wait-for');
  if (!waitFor) return started;
  const data = isRecord(started.data) ? started.data : {};
  const sessionId = typeof data.sessionId === 'string' ? data.sessionId : typeof data.runId === 'string' ? data.runId : undefined;
  if (!sessionId) throw new UsageError('--wait-for set but no sessionId returned by start/message');
  const timeoutMs = Number(flagString(flags, 'timeout') ?? '300000');
  const intervalMs = Number(flagString(flags, 'poll-interval') ?? '1000');
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const detail = await requestJson(`/api/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}`, { method: 'GET' }, flags);
    if (waitFor === 'terminal' && sessionIsTerminal(detail.data)) {
      return { command: `${started.command} (waited terminal)`, meta: detail.meta, data: detail.data, warnings: started.warnings, pretty: formatSessionDetail };
    }
    if (waitFor === 'interrupt') {
      const interrupts = await requestJson(`/api/agents/${encodeURIComponent(agentId)}/interrupts`, { method: 'GET' }, flags);
      const list = isRecord(interrupts.data) ? asArray(interrupts.data.interrupts) : [];
      if (list.some((i) => isRecord(i) && i.sessionId === sessionId)) {
        return { command: `${started.command} (waited interrupt)`, meta: interrupts.meta, data: interrupts.data, warnings: started.warnings, pretty: formatInterrupts };
      }
    }
    await sleep(intervalMs);
  }
  throw new TimeoutError(`--wait-for ${waitFor} did not occur within ${timeoutMs}ms (session ${sessionId})`);
}

function sessionIsTerminal(data: unknown): boolean {
  if (!isRecord(data)) return false;
  const session = isRecord(data.session) ? data.session : data;
  const status = String(session.status ?? '').toUpperCase();
  if (TERMINAL_STATUSES.has(status)) return true;
  if (session.completedAt || session.error) return true;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class TimeoutError extends Error {
  exitCode = 3;
}

function confirmDestructive(description: string, flags: Flags): void {
  if (hasFlag(flags, 'yes', 'y', 'force')) return;
  if (process.env.CTXMILL_YES === '1' || process.env.CTXMILL_YES === 'true') return;
  const error = new UsageError(`refusing destructive op without confirmation: ${description}\nPass --yes (or set CTXMILL_YES=1) to proceed.`);
  error.exitCode = 4;
  throw error;
}

function basename(path: string): string {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return idx === -1 ? path : path.slice(idx + 1);
}

async function* sseStream(url: string, init: RequestInit, meta: RequestMeta): AsyncGenerator<{ event?: string; data: string }> {
  const headers = new Headers(init.headers ?? {});
  headers.set('Accept', 'text/event-stream');
  const response = await fetch(url, { ...init, headers });
  if (!response.ok) {
    const text = await response.text();
    throw new ApiError(`SSE ${init.method ?? 'GET'} ${meta.endpoint} failed with HTTP ${response.status}`, response.status, parseMaybeJson(text), meta);
  }
  if (!response.body) {
    throw new ApiError('SSE response had no body', 0, null, meta);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const evt = parseSseBlock(block);
        if (evt) yield evt;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseSseBlock(block: string): { event?: string; data: string } | null {
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const rawLine of block.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.startsWith('event:')) event = line.slice(line.startsWith('event: ') ? 7 : 6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(line.startsWith('data: ') ? 6 : 5));
    else if (line.startsWith(':')) continue;
  }
  if (event === undefined && dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}

async function requestRaw(endpoint: string, init: RequestInit, flags: Flags): Promise<{ data: unknown; meta: RequestMeta }> {
  const baseUrl = getBaseUrl(flags);
  const url = buildUrl(baseUrl, endpoint);
  const meta: RequestMeta = { method: init.method ?? 'GET', endpoint, url };
  const response = await fetch(url, init);
  const text = await response.text();
  const data = parseMaybeJson(text);
  if (!response.ok) {
    throw new ApiError(`${meta.method} ${endpoint} failed with HTTP ${response.status}`, response.status, data, meta);
  }
  return { data, meta };
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

interface LoadBodyOptions {
  required?: boolean;
  hint?: string;
}

async function loadBody(flags: Flags, options: LoadBodyOptions = {}): Promise<unknown> {
  const fromFile = flagString(flags, 'from-file', 'body-file');
  if (fromFile) {
    const text = fromFile === '-' ? await readStdin() : await Bun.file(fromFile).text();
    return parseJsonFlag(text, '--from-file');
  }
  const data = flagString(flags, 'data', 'body');
  if (data !== undefined) return parseJsonFlag(data, '--data');
  if (options.required) {
    const hint = options.hint ? ` (${options.hint})` : '';
    throw new UsageError(`request body required${hint}; pass --data '<json>' or --from-file <path|->`);
  }
  return undefined;
}

async function loadFileContent(flags: Flags): Promise<string> {
  const inline = flagString(flags, 'content');
  if (inline !== undefined) return inline;
  const fromFile = flagString(flags, 'from-file', 'content-file');
  if (fromFile) {
    return fromFile === '-' ? await readStdin() : await Bun.file(fromFile).text();
  }
  throw new UsageError('content required; pass --content <text> or --from-file <path|->');
}

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  const decoder = new TextDecoder();
  for await (const chunk of Bun.stdin.stream()) chunks.push(chunk);
  return chunks.map((c) => decoder.decode(c)).join('');
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

function formatSecrets(data: unknown): string {
  const keys = isRecord(data) && Array.isArray(data.keys) ? data.keys : asArray(data);
  if (keys.length === 0) return '(no secrets)';
  return keys.map((k) => `- ${String(k)}`).join('\n');
}

function formatWebhooks(data: unknown): string {
  const list = isRecord(data) && Array.isArray(data.webhooks) ? data.webhooks : asArray(data);
  const rows = list.map((w) => ({
    id: getString(w, 'id'),
    url: getString(w, 'url'),
    events: Array.isArray(isRecord(w) ? w.events : undefined) ? (w as JsonRecord).events!.toString() : '',
    enabled: getString(w, 'enabled'),
  }));
  return table(rows, [['id', 'ID', 12], ['url', 'URL', 60], ['events', 'EVENTS', 40], ['enabled', 'ENABLED', 8]]);
}

function formatTriggers(data: unknown): string {
  const list = isRecord(data) && Array.isArray(data.triggers) ? data.triggers : asArray(data);
  const rows = list.map((t) => ({
    id: getString(t, 'id'),
    agent: getString(t, 'agentId'),
    type: getString(t, 'eventType'),
    enabled: getString(t, 'enabled'),
    selector: truncate(isRecord(t) ? t.selector : '', 40),
    task: truncate(isRecord(t) ? t.taskTemplate : '', 60),
  }));
  return table(rows, [['id', 'ID', 12], ['agent', 'AGENT', 12], ['type', 'EVENT_TYPE', 28], ['enabled', 'EN', 4], ['selector', 'SELECTOR', 40], ['task', 'TASK', 60]]);
}

function helpText(): string {
  return `ctxmill — agent-friendly ctxmill API CLI

Usage:
  bun scripts/ctxmill.ts <command> [args] [flags]

Global flags:
  --base-url <url>       ctxmill API root (default: CTXMILL_API_URL, API_BASE, or http://localhost:3002)
  --json                 Emit stable JSON envelope
  --raw                  Emit raw API payload
  --out <dir>            Save full JSON envelope to a directory
  --no-redact            Do not redact secret-like fields
  --yes / -y             Skip confirmation on destructive ops (or set CTXMILL_YES=1)
  --help                 Show this help

Body flags (mutations):
  --data '<json>'        Inline JSON request body
  --from-file <path|->   Read JSON body from file or stdin (use - for stdin)

Wait flags (sessions message|start):
  --wait-for terminal|interrupt
  --timeout <ms>         Default 300000 (5m)
  --poll-interval <ms>   Default 1000

Read commands:
  health
  config
  sandbox metrics
  settings get

  agents list
  agents get <agentId>
  agents versions <agentId>

  sessions list|get|active|turns ...
  runs list|get|active|cancel|turns ...     Alias for sessions

  conversations list|summary|messages ...
  interrupts list <agentId> [--include-resolved]
  events list|types|stats
  tools list

  artifacts list|get|download-url ...
  files ls|cat ...
  secrets list <agentId>
  feedback stats <agentId>
  traces list|stats <agentId>
  webhooks list <agentId>
  knowledge search|stats|get|cross-search|shared list|shared stats ...
  triggers list|get ...

Mutation commands:
  agents create --from-file <path>
  agents update <agentId> --from-file <path>
  agents delete <agentId>                              [--yes]

  sessions message <agentId> --content <text> [--conversation <id>] [--wait-for terminal|interrupt]
  sessions start <agentId> --task <text> [--mode <mode>] [--sandbox-secrets '{}'] [--wait-for ...]
  sessions cancel <agentId> <sessionId>
  sandbox-sessions suspend|kill <agentId> <sandboxSessionId>

  interrupts resolve <agentId> --session <sessionId> --action approve|reject|submit [--data '{}']
  tools test <toolName> --input '{}'

  files write|update <agentId> --path <p> (--content <text> | --from-file <path|->)
  files delete <agentId> --path <p> [--session <id>]   [--yes]

  artifacts upload --agent <id> --file <path> [--name <n>]      Multipart upload
  artifacts upload-url --agent <id> --name <n> [--mime <m>] [--size <bytes>]
  artifacts delete <artifactId>                        [--yes]

  workspace upload <agentId> --file <tarball.tar.gz> [--force]   Gzip body, raw POST

  secrets set <agentId> --key <k> --value <v>
  secrets delete <agentId> <key>                       [--yes]

  settings set --from-file <path>

  feedback submit <agentId> --conversation <cid> --message <mid> --type thumbs_up|thumbs_down [--comment <t>]

  webhooks add <agentId> --url <u> --events <csv> [--secret <s>]
  webhooks update <agentId> <webhookId> --from-file <path>
  webhooks delete <agentId> <webhookId>                [--yes]

  knowledge shared add --content <t> [--category <c>] [--source <s>] [--effectiveness <n>]
  knowledge shared delete <itemId>                     [--yes]

  triggers create --from-file <path>
  triggers update <triggerId> --from-file <path>
  triggers delete <triggerId>                          [--yes]
  triggers emit --type <t> [--agent <id>] [--payload '{}']

Streaming commands:
  stream <agentId> [--limit N] [--timeout ms] [--until-type <t>] [--json]
  run <agentId> --task "<text>" [--no-stream] [--data '<ag-ui body>']

Exit codes: 0=ok 1=api/runtime 2=usage 3=timeout 4=unsafe-blocked 5=unexpected-shape

Examples:
  bun scripts/ctxmill.ts health
  bun scripts/ctxmill.ts agents create --from-file agent.json
  bun scripts/ctxmill.ts sessions start agent_123 --task "Summarize repo" --wait-for terminal --timeout 600000
  bun scripts/ctxmill.ts run agent_123 --task "Hello"
  bun scripts/ctxmill.ts stream agent_123 --limit 20
  bun scripts/ctxmill.ts artifacts upload --agent agent_123 --file ./report.pdf
  bun scripts/ctxmill.ts workspace upload agent_123 --file ./ws.tar.gz
  bun scripts/ctxmill.ts agents delete agent_123 --yes
  bun scripts/ctxmill.ts settings set --data '{"turnTimeoutMs":600000}'
`;
}
