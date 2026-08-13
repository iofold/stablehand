import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AgentCreateInputSchema,
  AgentPatchInputSchema,
  ApiKeyCreateInputSchema,
  BackgroundTurnStartInputSchema,
  ConversationTurnStartInputSchema,
  CustomEventEmitInputSchema,
  FileWriteInputSchema,
  InterruptResolveInputSchema,
  SecretPutInputSchema,
  ScheduleCreateInputSchema,
  SchedulePatchInputSchema,
  WebhookCreateInputSchema,
  WebhookPatchInputSchema,
} from '@ctxmill/contracts';
import type { ZodType } from 'zod';
import { redactSensitiveFields as redact } from './redaction.js';

type JsonRecord = Record<string, unknown>;
type FlagValue = string | boolean;
type Flags = Record<string, FlagValue | FlagValue[]>;

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

interface RunOpsCliOptions {
  invocation?: string;
}

class UsageError extends Error {
  exitCode = 2;
  code = 'usage_error';
  hint?: string;
  retryable = false;
}

class UnsafeOperationError extends UsageError {
  override exitCode = 4;
  override code = 'unsafe_operation_blocked';
  override hint = 'Review the target, then pass --yes. Use --dry-run to validate without changing state.';
}

class ApiError extends Error {
  exitCode = 1;
  code = 'api_error';
  constructor(message: string, readonly status: number, readonly data: unknown, readonly meta: RequestMeta) {
    super(message);
  }
}

const DEFAULT_INVOCATION = 'ctxmill ops';
const TERMINAL_STATUSES = new Set(['COMPLETED', 'ERROR', 'CANCELLED', 'TERMINATED', 'completed', 'error', 'cancelled']);

export async function runOpsCli(
  argv: string[],
  options: RunOpsCliOptions = {},
): Promise<number> {
  const invocation = options.invocation?.trim() || DEFAULT_INVOCATION;
  const parsed = parseArgs(argv);
  try {
    const result = await executeCommand(parsed, invocation);
    await emitResult(result, parsed.flags);
    return 0;
  } catch (error) {
    return emitError(error, parsed.flags, invocation);
  }
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
      appendFlag(flags, withoutPrefix.slice(0, eq), withoutPrefix.slice(eq + 1));
      continue;
    }

    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      appendFlag(flags, withoutPrefix, next);
      i += 1;
    } else {
      appendFlag(flags, withoutPrefix, true);
    }
  }

  return { positionals, flags };
}

function appendFlag(flags: Flags, name: string, value: FlagValue): void {
  const existing = flags[name];
  if (existing === undefined) {
    flags[name] = value;
  } else if (Array.isArray(existing)) {
    existing.push(value);
  } else {
    flags[name] = [existing, value];
  }
}

async function executeCommand(
  args: ParsedArgs,
  invocation: string,
): Promise<CommandResult> {
  const [group, action, third, fourth] = args.positionals;
  if (!group || group === 'help' || hasFlag(args.flags, 'help', 'h')) {
    return localResult(
      'help',
      helpText(invocation),
      () => helpText(invocation),
    );
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
    case 'turns':
      return turnCommand(action, third, fourth, args.flags);
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
    case 'schedules':
      return scheduleCommand(action, third, args.flags);
    case 'secrets':
      return secretCommand(action, third, fourth, args.flags);
    case 'keys':
      return apiKeyCommand(action, third, args.flags);
    case 'settings':
      return settingsCommand(action, args.flags);
    case 'feedback':
      return feedbackCommand(action, third, args.flags);
    case 'webhooks':
      return webhookCommand(action, third, fourth, args.flags);
    case 'stream':
      return streamCommand(action, args.flags);
    case 'ag-ui':
      if (action === 'run') return agUiRunCommand(third, args.flags);
      break;
    case 'workspace':
      return workspaceCommand(action, third, args.flags);
    default:
      break;
  }

  throw new UsageError(
    `Unknown command: ${args.positionals.join(' ') || '<none>'}\n\n${helpText(invocation)}`,
  );
}

async function agentCommand(action: string | undefined, id: string | undefined, flags: Flags): Promise<CommandResult> {
  switch (action) {
    case 'list':
    case undefined:
      return getCommand('agents list', 'GET', '/api/agents', formatAgents, flags);
    case 'get':
      requireArg(id, 'agentId');
      return getCommand('agents get', 'GET', `/api/agents/${encodeURIComponent(id)}`, formatAgent, flags);
    case 'create': {
      const body = await loadBody(flags, { required: true, hint: 'agent definition (name, harness, harnessConfig, systemPrompt, tools, ...)' });
      return requestCommand('agents create', 'POST', '/api/agents', body, formatJsonSummary, flags, AgentCreateInputSchema);
    }
    case 'update': {
      requireArg(id, 'agentId');
      const body = await loadBody(flags, { required: true, hint: 'partial agent definition' });
      return requestCommand('agents update', 'PATCH', `/api/agents/${encodeURIComponent(id)}`, body, formatJsonSummary, flags, AgentPatchInputSchema);
    }
    case 'delete':
      requireArg(id, 'agentId');
      confirmDestructive(`agents delete ${id} (cascades turns, conversations, sandbox sessions, and artifacts)`, flags);
      return requestCommand('agents delete', 'DELETE', `/api/agents/${encodeURIComponent(id)}`, undefined, formatJsonSummary, flags);
    default:
      throw new UsageError(`Unknown agents command: ${action}`);
  }
}

async function turnCommand(action: string | undefined, agentId: string | undefined, turnId: string | undefined, flags: Flags): Promise<CommandResult> {
  switch (action) {
    case 'list':
    case undefined:
      requireArg(agentId, 'agentId');
      return getCommand('turns list', 'GET', `/api/agents/${encodeURIComponent(agentId)}/turns`, formatTurns, flags);
    case 'get':
      requireArg(agentId, 'agentId');
      requireArg(turnId, 'turnId');
      return getCommand('turns get', 'GET', `/api/agents/${encodeURIComponent(agentId)}/turns/${encodeURIComponent(turnId)}`, formatTurnDetail, flags);
    case 'cancel':
      requireArg(agentId, 'agentId');
      requireArg(turnId, 'turnId');
      confirmDestructive(`turns cancel ${agentId}/${turnId}`, flags);
      return requestCommand('turns cancel', 'POST', `/api/agents/${encodeURIComponent(agentId)}/turns/${encodeURIComponent(turnId)}/cancel`, undefined, formatJsonSummary, flags);
    case 'message': {
      requireArg(agentId, 'agentId');
      const content = flagString(flags, 'content');
      requireArg(content, 'content via --content');
      const body: JsonRecord = { content };
      const conversationId = flagString(flags, 'conversation', 'conversation-id');
      if (conversationId) body.conversationId = conversationId;
      const result = await requestCommand('turns message', 'POST', `/api/agents/${encodeURIComponent(agentId)}/message`, body, formatJsonSummary, flags, ConversationTurnStartInputSchema);
      return maybeWaitForTurn(agentId, result, flags);
    }
    case 'start': {
      requireArg(agentId, 'agentId');
      const task = flagString(flags, 'task');
      requireArg(task, 'task via --task');
      const body: JsonRecord = { task };
      const secrets = flagString(flags, 'sandbox-secrets');
      if (secrets) body.sandboxSecrets = parseJsonFlag(secrets, '--sandbox-secrets');
      const result = await requestCommand('turns start', 'POST', `/api/agents/${encodeURIComponent(agentId)}/turns`, body, formatJsonSummary, flags, BackgroundTurnStartInputSchema);
      return maybeWaitForTurn(agentId, result, flags);
    }
    default:
      throw new UsageError(`Unknown turns command: ${action}`);
  }
}

async function sandboxSessionCommand(action: string | undefined, agentId: string | undefined, sandboxSessionId: string | undefined, flags: Flags): Promise<CommandResult> {
  if (action === 'active') {
    return getCommand(
      'sandbox-sessions active',
      'GET',
      '/api/sandbox-sessions?status=active',
      formatActiveSandboxSessions,
      flags,
    );
  }
  requireArg(agentId, 'agentId');
  requireArg(sandboxSessionId, 'sandboxSessionId');
  const base = `/api/agents/${encodeURIComponent(agentId)}/sandbox-sessions/${encodeURIComponent(sandboxSessionId)}`;
  switch (action) {
    case 'suspend':
      return requestCommand('sandbox-sessions suspend', 'POST', `${base}/suspend`, undefined, formatJsonSummary, flags);
    case 'restore':
      return requestCommand('sandbox-sessions restore', 'POST', `${base}/restore`, undefined, formatJsonSummary, flags);
    case 'kill':
      confirmDestructive(`sandbox-sessions kill ${agentId}/${sandboxSessionId}`, flags);
      return requestCommand('sandbox-sessions kill', 'POST', `${base}/kill`, undefined, formatJsonSummary, flags);
    default:
      throw new UsageError(`Unknown sandbox-sessions command: ${action}`);
  }
}

async function conversationCommand(action: string | undefined, agentId: string | undefined, convId: string | undefined, flags: Flags): Promise<CommandResult> {
  if (action === 'active') {
    return getCommand(
      'conversations active',
      'GET',
      '/api/conversations?status=active',
      formatActiveConversations,
      flags,
    );
  }
  requireArg(agentId, 'agentId');
  switch (action) {
    case 'list':
    case undefined:
      return getCommand('conversations list', 'GET', `/api/agents/${encodeURIComponent(agentId)}/conversations`, formatConversations, flags);
    case 'summary':
      return getCommand('conversations summary', 'GET', `/api/agents/${encodeURIComponent(agentId)}/conversations/summary`, formatConversationSummaries, flags);
    case 'snapshot':
      requireArg(convId, 'conversationId');
      return getCommand(
        'conversations snapshot',
        'GET',
        `/api/agents/${encodeURIComponent(agentId)}/conversations/${encodeURIComponent(convId)}/snapshot`,
        formatConversationSnapshot,
        flags,
      );
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
      const interruptId = flagString(flags, 'interrupt', 'interrupt-id');
      const actionValue = flagString(flags, 'action') ?? 'approve';
      requireArg(interruptId, 'interruptId via --interrupt');
      if (!['approve', 'reject', 'submit'].includes(actionValue)) {
        throw new UsageError('--action must be approve, reject, or submit');
      }
      const body: JsonRecord = { action: actionValue, interruptId };
      const data = flagString(flags, 'data');
      if (data !== undefined) body.data = parseJsonFlag(data, '--data');
      return requestCommand('interrupts resolve', 'POST', `/api/agents/${encodeURIComponent(agentId)}/interrupt`, body, formatJsonSummary, flags, InterruptResolveInputSchema);
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
        turnId: flagString(flags, 'turn', 'turn-id'),
        conversationId: flagString(flags, 'conversation', 'conversation-id'),
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
      const turnId = flagString(flags, 'turn', 'turn-id');
      if (!agentId && !turnId) throw new UsageError('artifacts list requires --agent <agentId> or --turn <turnId>');
      const query = buildQuery({ agentId, turnId, limit: flagString(flags, 'limit') ?? '100', offset: flagString(flags, 'offset') });
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
      const file = await readFileOrUsageError(filePath);
      const form = new FormData();
      form.append('agentId', agentId);
      form.append('name', name);
      form.append('file', new Blob([new Uint8Array(file)]), name);
      if (hasFlag(flags, 'dry-run')) {
        return localResult('artifacts upload (dry-run)', {
          dryRun: true,
          method: 'POST',
          endpoint: '/api/artifacts/upload',
          file: filePath,
          name,
          bytes: file.byteLength,
        }, formatJsonSummary);
      }
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
  const conversationId = flagString(flags, 'conversation', 'conversation-id');
  switch (action) {
    case 'ls': {
      const query = buildQuery({ path, conversationId });
      return getCommand('files ls', 'GET', `/api/agents/${encodeURIComponent(agentId)}/files${query}`, formatFiles, flags);
    }
    case 'cat': {
      if (!pathFlag) throw new UsageError('files cat requires --path <path>');
      const query = buildQuery({ path, conversationId });
      return getCommand('files cat', 'GET', `/api/agents/${encodeURIComponent(agentId)}/files/read${query}`, formatFileRead, flags);
    }
    case 'write':
    case 'update': {
      if (!pathFlag) throw new UsageError(`files ${action} requires --path <path>`);
      const content = await loadFileContent(flags);
      const body: JsonRecord = { path: pathFlag, content };
      const method = action === 'write' ? 'POST' : 'PUT';
      const query = buildQuery({ conversationId });
      return requestCommand(`files ${action}`, method, `/api/agents/${encodeURIComponent(agentId)}/files${query}`, body, formatJsonSummary, flags, FileWriteInputSchema);
    }
    case 'delete': {
      if (!pathFlag) throw new UsageError('files delete requires --path <path>');
      confirmDestructive(`files delete ${agentId}:${pathFlag}`, flags);
      const query = buildQuery({ path: pathFlag, conversationId });
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
      const body: JsonRecord = { type, payload: {} };
      const agentId = flagString(flags, 'agent', 'agent-id');
      if (agentId) body.agentId = agentId;
      const payload = flagString(flags, 'payload');
      if (payload) body.payload = parseJsonFlag(payload, '--payload');
      return requestCommand(
        'triggers emit',
        'POST',
        '/api/triggers/emit',
        body,
        formatJsonSummary,
        flags,
        CustomEventEmitInputSchema,
      );
    }
    default:
      throw new UsageError(`Unknown triggers command: ${action}`);
  }
}

async function scheduleCommand(action: string | undefined, id: string | undefined, flags: Flags): Promise<CommandResult> {
  switch (action) {
    case 'list':
    case undefined:
      return getCommand('schedules list', 'GET', '/api/schedules', formatSchedules, flags);
    case 'get':
      requireArg(id, 'scheduleId');
      return getCommand('schedules get', 'GET', `/api/schedules/${encodeURIComponent(id)}`, formatJsonSummary, flags);
    case 'create': {
      const body = await loadBody(flags, {
        required: true,
        hint: 'schedule definition (name, cronExpression, eventType, optional agentId/timezone/payload/enabled)',
      });
      return requestCommand(
        'schedules create',
        'POST',
        '/api/schedules',
        body,
        formatJsonSummary,
        flags,
        ScheduleCreateInputSchema,
      );
    }
    case 'update': {
      requireArg(id, 'scheduleId');
      const body = await loadBody(flags, { required: true, hint: 'partial schedule definition' });
      return requestCommand(
        'schedules update',
        'PATCH',
        `/api/schedules/${encodeURIComponent(id)}`,
        body,
        formatJsonSummary,
        flags,
        SchedulePatchInputSchema,
      );
    }
    case 'delete':
      requireArg(id, 'scheduleId');
      confirmDestructive(`schedules delete ${id}`, flags);
      return requestCommand(
        'schedules delete',
        'DELETE',
        `/api/schedules/${encodeURIComponent(id)}`,
        undefined,
        formatJsonSummary,
        flags,
      );
    default:
      throw new UsageError(`Unknown schedules command: ${action}`);
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
      return requestCommand('secrets set', 'POST', base, { key: k, value }, formatJsonSummary, flags, SecretPutInputSchema);
    }
    case 'delete':
      requireArg(key, 'secret key');
      confirmDestructive(`secrets delete ${agentId}/${key}`, flags);
      return requestCommand('secrets delete', 'DELETE', `${base}/${encodeURIComponent(key)}`, undefined, formatJsonSummary, flags);
    default:
      throw new UsageError(`Unknown secrets command: ${action}`);
  }
}

async function apiKeyCommand(action: string | undefined, third: string | undefined, flags: Flags): Promise<CommandResult> {
  const base = '/api/keys';
  switch (action) {
    case 'list':
    case undefined:
      return getCommand('keys list', 'GET', base, formatJsonSummary, flags);
    case 'create': {
      const name = flagString(flags, 'name') ?? third;
      const caps = flagStrings(flags, 'cap', 'capabilities')
        .flatMap((value) => value.split(','))
        .map((cap) => cap.trim())
        .filter(Boolean);
      requireArg(name, 'name via --name');
      if (caps.length === 0) {
        throw new UsageError('Missing required capabilities via --cap (repeatable or comma-separated)');
      }
      if (flagString(flags, 'out') && !hasFlag(flags, 'dry-run')) {
        throw new UsageError(
          'keys create returns a one-time secret; --out is disabled for this command',
        );
      }
      const body: JsonRecord = {
        name,
        capabilities: caps,
      };
      const note = flagString(flags, 'note');
      if (note) body.note = note;
      const expiresAt = flagString(flags, 'expires-at');
      if (expiresAt) body.expiresAt = Number(expiresAt);
      // The response carries the token exactly once; it is never retrievable again.
      return requestCommand('keys create', 'POST', base, body, formatJsonSummary, flags, ApiKeyCreateInputSchema);
    }
    case 'revoke': {
      const id = flagString(flags, 'id') ?? third;
      requireArg(id, 'key id');
      confirmDestructive(`keys revoke ${id}`, flags);
      return requestCommand('keys revoke', 'DELETE', `${base}/${encodeURIComponent(id!)}`, undefined, formatJsonSummary, flags);
    }
    default:
      throw new UsageError(`Unknown keys command: ${action}`);
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
    default:
      throw new UsageError(`Unknown feedback command: ${action}`);
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
      requireArg(secret, 'secret via --secret');
      body.secret = secret;
      return requestCommand('webhooks add', 'POST', base, body, formatJsonSummary, flags, WebhookCreateInputSchema);
    }
    case 'update': {
      requireArg(webhookId, 'webhookId');
      const body = await loadBody(flags, { required: true, hint: 'partial webhook (url, events, secret)' });
      return requestCommand('webhooks update', 'PATCH', `${base}/${encodeURIComponent(webhookId)}`, body, formatJsonSummary, flags, WebhookPatchInputSchema);
    }
    case 'delete':
      requireArg(webhookId, 'webhookId');
      confirmDestructive(`webhooks delete ${agentId}/${webhookId}`, flags);
      return requestCommand('webhooks delete', 'DELETE', `${base}/${encodeURIComponent(webhookId)}`, undefined, formatJsonSummary, flags);
    default:
      throw new UsageError(`Unknown webhooks command: ${action}`);
  }
}


async function streamCommand(agentId: string | undefined, flags: Flags): Promise<CommandResult> {
  const id = agentId ?? flagString(flags, 'agent', 'agent-id');
  requireArg(id, 'agentId');
  const endpoint = `/api/agents/${encodeURIComponent(id)}/stream`;
  const baseUrl = getBaseUrl(flags);
  const url = buildSseGetUrl(baseUrl, endpoint, flags);
  const meta: RequestMeta = { method: 'GET', endpoint, url };
  const limit = Number(flagString(flags, 'limit') ?? '0');
  const timeoutMs = Number(flagString(flags, 'timeout') ?? '0');
  const watchType = flagString(flags, 'until-type');
  const startedAt = Date.now();
  let count = 0;
  for await (const evt of sseStream(url, { method: 'GET' }, meta, flags)) {
    const line = formatSseEvent(evt, flags);
    if (line) console.log(line);
    count += 1;
    if (limit > 0 && count >= limit) break;
    if (timeoutMs > 0 && Date.now() - startedAt > timeoutMs) break;
    if (watchType && eventTypeMatches(evt, watchType)) break;
  }
  return localResult('stream', { events: count, durationMs: Date.now() - startedAt }, () => `streamed ${count} events in ${Date.now() - startedAt}ms`);
}

async function agUiRunCommand(agentId: string | undefined, flags: Flags): Promise<CommandResult> {
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
    return { command: 'ag-ui run', meta, data, warnings: [], pretty: formatJsonSummary };
  }
  let count = 0;
  let lastEvent: { event?: string; data: string } | null = null;
  const startedAt = Date.now();
  for await (const evt of sseStream(url, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }, meta, flags)) {
    const line = formatSseEvent(evt, flags);
    if (line) console.log(line);
    count += 1;
    lastEvent = evt;
    if (isTerminalAgUiEvent(evt)) break;
  }
  return localResult('ag-ui run', { events: count, durationMs: Date.now() - startedAt, lastEvent }, () => `consumed ${count} SSE events in ${Date.now() - startedAt}ms`);
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
      const file = await readFileOrUsageError(filePath);
      const force = hasFlag(flags, 'force');
      if (force) {
        confirmDestructive(`workspace force replacement for ${agentId}`, flags);
      }
      const endpoint = `/api/agents/${encodeURIComponent(agentId)}/workspace${force ? '?force=true' : ''}`;
      const headers: Record<string, string> = { 'Content-Type': 'application/gzip', 'Content-Encoding': 'gzip' };
      if (hasFlag(flags, 'dry-run')) {
        return localResult('workspace upload (dry-run)', {
          dryRun: true,
          method: 'POST',
          endpoint,
          file: filePath,
          bytes: file.byteLength,
        }, formatJsonSummary);
      }
      const { data, meta } = await requestRaw(
        endpoint,
        { method: 'POST', body: new Blob([new Uint8Array(file)]), headers },
        flags,
      );
      return { command: 'workspace upload', meta, data, warnings: [], pretty: formatJsonSummary };
    }
    default:
      throw new UsageError(`Unknown workspace command: ${action}`);
  }
}

async function maybeWaitForTurn(agentId: string, started: CommandResult, flags: Flags): Promise<CommandResult> {
  const waitFor = flagString(flags, 'wait-for');
  if (!waitFor) return started;
  const data = isRecord(started.data) ? started.data : {};
  const turnId = typeof data.turnId === 'string' ? data.turnId : undefined;
  if (!turnId) throw new UsageError('--wait-for set but no turnId returned by turns start/message');
  const timeoutMs = Number(flagString(flags, 'timeout') ?? '300000');
  const intervalMs = Number(flagString(flags, 'poll-interval') ?? '1000');
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const detail = await requestJson(`/api/agents/${encodeURIComponent(agentId)}/turns/${encodeURIComponent(turnId)}`, { method: 'GET' }, flags);
    if (waitFor === 'terminal' && turnIsTerminal(detail.data)) {
      return { command: `${started.command} (waited terminal)`, meta: detail.meta, data: detail.data, warnings: started.warnings, pretty: formatTurnDetail };
    }
    if (waitFor === 'interrupt') {
      const interrupts = await requestJson(`/api/agents/${encodeURIComponent(agentId)}/interrupts`, { method: 'GET' }, flags);
      const list = isRecord(interrupts.data) ? asArray(interrupts.data.interrupts) : [];
      if (list.some((interrupt) => isRecord(interrupt) && interrupt.turnId === turnId)) {
        return { command: `${started.command} (waited interrupt)`, meta: interrupts.meta, data: interrupts.data, warnings: started.warnings, pretty: formatInterrupts };
      }
    }
    await sleep(intervalMs);
  }
  throw new TimeoutError(`--wait-for ${waitFor} did not occur within ${timeoutMs}ms (turn ${turnId})`);
}

function turnIsTerminal(data: unknown): boolean {
  if (!isRecord(data)) return false;
  const turn = isRecord(data.turn) ? data.turn : data;
  const status = String(turn.status ?? '').toUpperCase();
  if (TERMINAL_STATUSES.has(status)) return true;
  if (turn.completedAt || turn.error) return true;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class TimeoutError extends Error {
  exitCode = 3;
  code = 'timeout';
  hint = 'Retry the read, or retry an idempotent mutation with the same Idempotency-Key.';
  retryable = true;
}

function confirmDestructive(description: string, flags: Flags): void {
  if (hasFlag(flags, 'dry-run')) return;
  if (hasFlag(flags, 'yes', 'y')) return;
  if (process.env.CTXMILL_YES === '1' || process.env.CTXMILL_YES === 'true') return;
  throw new UnsafeOperationError(
    `Refusing destructive operation without confirmation: ${description}`,
  );
}

function basename(path: string): string {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return idx === -1 ? path : path.slice(idx + 1);
}

async function* sseStream(
  url: string,
  init: RequestInit,
  meta: RequestMeta,
  flags: Flags,
): AsyncGenerator<{ event?: string; data: string }> {
  const headers = new Headers(init.headers ?? {});
  headers.set('Accept', 'text/event-stream');
  if (!urlHasAccessToken(url)) applyApiAuth(headers, flags);
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
  const headers = new Headers(init.headers ?? {});
  applyApiAuth(headers, flags);
  const response = await fetch(url, { ...init, headers });
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

async function requestCommand(
  command: string,
  method: string,
  endpoint: string,
  body: unknown,
  pretty: (data: unknown) => string,
  flags: Flags,
  dryRunSchema?: ZodType,
): Promise<CommandResult> {
  if (method !== 'GET' && hasFlag(flags, 'dry-run')) {
    const validatedBody = dryRunSchema
      ? parseCanonicalDryRunBody(command, body, dryRunSchema)
      : body;
    return localResult(`${command} (dry-run)`, {
      dryRun: true,
      method,
      endpoint,
      ...(validatedBody === undefined ? {} : { body: validatedBody }),
    }, formatJsonSummary);
  }
  const { data, meta } = await requestJson(endpoint, { method, body }, flags);
  return { command, meta, data, warnings: [], pretty };
}

function parseCanonicalDryRunBody(command: string, body: unknown, schema: ZodType): unknown {
  const parsed = schema.safeParse(body);
  if (parsed.success) {
    return parsed.data;
  }

  const details = parsed.error.issues
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
  throw new UsageError(`Invalid canonical request for ${command}: ${details}`);
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
  applyApiAuth(headers, flags);
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

function getApiToken(flags: Flags): string | undefined {
  const raw = flagString(flags, 'api-token', 'token') ?? process.env.CTXMILL_API_TOKEN;
  const token = raw?.trim();
  return token ? token : undefined;
}

function applyApiAuth(headers: Headers | Record<string, string>, flags: Flags): void {
  const token = getApiToken(flags);
  if (!token) return;
  if (headers instanceof Headers) {
    if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`);
    return;
  }
  if (!headers.Authorization && !headers.authorization) headers.Authorization = `Bearer ${token}`;
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

function buildSseGetUrl(baseUrl: string, endpoint: string, flags: Flags): string {
  const url = new URL(buildUrl(baseUrl, endpoint));
  const token = getApiToken(flags);
  if (token && !url.searchParams.has('access_token')) url.searchParams.set('access_token', token);
  return url.toString();
}

function urlHasAccessToken(url: string): boolean {
  try {
    return new URL(url).searchParams.has('access_token');
  } catch {
    return false;
  }
}

async function emitResult(result: CommandResult, flags: Flags): Promise<void> {
  const redacted = redactResultData(result, flags);
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

function redactResultData(result: CommandResult, flags: Flags): unknown {
  if (!shouldRedact(flags)) return result.data;
  const redacted = redact(result.data);
  if (
    result.command === 'keys create'
    && isRecord(result.data)
    && typeof result.data.token === 'string'
    && isRecord(redacted)
  ) {
    return { ...redacted, token: result.data.token };
  }
  return redacted;
}

function emitError(
  error: unknown,
  flags: Flags,
  invocation: string,
): number {
  const exitCode = getExitCode(error);
  const code = error instanceof ApiError
    ? error.code
    : error instanceof UsageError || error instanceof TimeoutError
      ? error.code
      : 'runtime_error';
  const message = error instanceof Error ? error.message : String(error);
  const payload = {
    error: code,
    message,
    hint: error instanceof UnsafeOperationError
      ? error.hint
      : error instanceof UsageError
        ? `Run \`${invocation} help\` to inspect commands and required arguments.`
        : error instanceof TimeoutError
          ? error.hint
          : error instanceof ApiError
            ? 'Inspect the status and redacted response data, correct the request, then retry only when safe.'
            : 'Inspect the runtime error and retry after correcting its cause.',
    retryable: error instanceof TimeoutError || (
      error instanceof ApiError && (error.status === 408 || error.status === 429 || error.status >= 500)
    ),
    ...(error instanceof ApiError
      ? {
          status: error.status,
          endpoint: `${error.meta.method} ${error.meta.endpoint}`,
          data: shouldRedact(flags) ? redact(error.data) : error.data,
        }
      : {}),
  };

  if (hasFlag(flags, 'json')) {
    console.error(JSON.stringify(payload, null, 2));
  } else {
    console.error(payload.message);
    if (error instanceof ApiError) console.error(JSON.stringify(payload.data, null, 2));
  }

  return exitCode;
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
    const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
    for (let index = values.length - 1; index >= 0; index -= 1) {
      const candidate = values[index];
      if (typeof candidate === 'string') return candidate;
      if (candidate === true) return 'true';
    }
  }
  return undefined;
}

function flagStrings(flags: Flags, ...names: string[]): string[] {
  return names.flatMap((name) => {
    const value = flags[name];
    const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
    return values.filter((candidate): candidate is string => typeof candidate === 'string');
  });
}

function hasFlag(flags: Flags, ...names: string[]): boolean {
  return names.some((name) => {
    const value = flags[name];
    const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
    return values.some((candidate) => candidate === true || candidate === 'true');
  });
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
    const text = fromFile === '-' ? await readStdin() : await readFileTextOrUsageError(fromFile);
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
    return fromFile === '-' ? await readStdin() : readFileTextOrUsageError(fromFile);
  }
  throw new UsageError('content required; pass --content <text> or --from-file <path|->');
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readFileOrUsageError(path: string): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : '';
    throw new UsageError(`file not found or unreadable: ${path}${detail}`);
  }
}

async function readFileTextOrUsageError(path: string): Promise<string> {
  return (await readFileOrUsageError(path)).toString('utf8');
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
    active: getString(agent, 'activeTurnCount'),
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
    `workspace: ${String(data.workspaceDir ?? '')}`,
    `tools: ${tools}`,
    `pending_interrupt: ${String(data.hasPendingInterrupt ?? false)}`,
    `turns: total=${String(data.turnCount ?? 0)} active=${String(data.activeTurnCount ?? 0)} completed=${String(data.completedTurnCount ?? 0)} failed=${String(data.failedTurnCount ?? 0)}`,
    `sandbox_sessions_by_status: ${JSON.stringify(data.sandboxSessionsByStatus ?? {})}`,
  ].join('\n');
}

function formatTurns(data: unknown): string {
  const rows = getNestedArray(data, 'turns').map((turn) => ({
    id: getString(turn, 'id'),
    sandbox: getString(turn, 'sandboxSessionId'),
    status: getString(turn, 'status'),
    mode: getString(turn, 'mode'),
    conversation: getString(turn, 'conversationId'),
    started: formatTime(getNumber(turn, 'startedAt')),
    error: getString(turn, 'error'),
  }));
  return table(rows, [['id', 'TURN', 12], ['sandbox', 'SANDBOX', 12], ['status', 'STATUS', 14], ['mode', 'MODE', 12], ['conversation', 'CONVERSATION', 12], ['started', 'STARTED', 24], ['error', 'ERROR', 40]]);
}

function formatActiveConversations(data: unknown): string {
  const rows = asArray(data).map((conversation) => ({
    id: getString(conversation, 'id'),
    agent: getString(conversation, 'agentId'),
    status: getString(conversation, 'status'),
    latestTurn: getString(conversation, 'latestTurnId'),
    updated: getString(conversation, 'updatedAt') || getString(conversation, 'lastActivityAt'),
    task: getString(conversation, 'taskDescription'),
  }));
  return table(rows, [['id', 'CONVERSATION', 12], ['agent', 'AGENT', 12], ['status', 'STATUS', 14], ['latestTurn', 'LATEST TURN', 12], ['updated', 'UPDATED', 24], ['task', 'TASK', 42]]);
}

function formatActiveSandboxSessions(data: unknown): string {
  const rows = asArray(data).map((sandboxSession) => ({
    id: getString(sandboxSession, 'id'),
    agent: getString(sandboxSession, 'agentId'),
    conversation: getString(sandboxSession, 'conversationId'),
    status: getString(sandboxSession, 'status'),
    harness: getString(sandboxSession, 'harnessName'),
    updated: formatTime(getNumber(sandboxSession, 'updatedAt')),
  }));
  return table(rows, [['id', 'SANDBOX SESSION', 16], ['agent', 'AGENT', 12], ['conversation', 'CONVERSATION', 12], ['status', 'STATUS', 14], ['harness', 'HARNESS', 16], ['updated', 'UPDATED', 24]]);
}

function formatTurnDetail(data: unknown): string {
  if (!isRecord(data)) return JSON.stringify(data, null, 2);
  const turn = isRecord(data.turn) ? data.turn : {};
  const messages = asArray(data.messages);
  return [
    `turn: ${String(turn.id ?? '')}`,
    `sandbox_session: ${String(turn.sandboxSessionId ?? '')}`,
    `agent: ${String(turn.agentId ?? '')}`,
    `conversation: ${String(turn.conversationId ?? '')}`,
    `status: ${String(turn.status ?? '')}`,
    `started: ${formatTime(turn.startedAt)}`,
    `completed: ${formatTime(turn.completedAt)}`,
    `error: ${String(turn.error ?? '')}`,
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
  const rows = asArray(data).map((message) => {
    const toolCalls = isRecord(message) && Array.isArray(message.toolCalls)
      ? String(message.toolCalls.length)
      : '';
    return {
      id: getString(message, 'id'),
      role: getString(message, 'role'),
      created: getString(message, 'createdAt'),
      toolCalls,
      content: getString(message, 'content'),
    };
  });
  return table(rows, [['id', 'ID', 12], ['role', 'ROLE', 10], ['created', 'CREATED', 24], ['toolCalls', 'TOOLS', 6], ['content', 'CONTENT', 90]]);
}

function formatConversationSnapshot(data: unknown): string {
  if (!isRecord(data)) return formatMessages([]);
  return [
    `conversation: ${getString(data, 'conversationId')}`,
    `event cursor: ${getString(data, 'eventCursor')}`,
    formatMessages(data.messages),
  ].join('\n');
}

function formatInterrupts(data: unknown): string {
  const rows = getNestedArray(data, 'interrupts').map((interrupt) => ({
    id: getString(interrupt, 'interruptId'),
    turn: getString(interrupt, 'turnId'),
    sandbox: getString(interrupt, 'sandboxSessionId'),
    status: getString(interrupt, 'status'),
    tool: getString(interrupt, 'toolName'),
    call: getString(interrupt, 'toolCallId'),
    created: formatTime(getNumber(interrupt, 'createdAt')),
  }));
  return table(rows, [['id', 'INTERRUPT', 12], ['turn', 'TURN', 12], ['sandbox', 'SANDBOX', 12], ['status', 'STATUS', 12], ['tool', 'TOOL', 28], ['call', 'CALL', 14], ['created', 'CREATED', 24]]);
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

function formatSchedules(data: unknown): string {
  const list = isRecord(data) && Array.isArray(data.schedules) ? data.schedules : asArray(data);
  const rows = list.map((schedule) => ({
    id: getString(schedule, 'id'),
    name: getString(schedule, 'name'),
    agent: getString(schedule, 'agentId'),
    cron: getString(schedule, 'cronExpression'),
    timezone: getString(schedule, 'timezone'),
    event: getString(schedule, 'eventType'),
    enabled: getString(schedule, 'enabled'),
    nextRun: getString(schedule, 'nextRun'),
  }));
  return table(rows, [
    ['id', 'ID', 12],
    ['name', 'NAME', 24],
    ['agent', 'AGENT', 12],
    ['cron', 'CRON', 18],
    ['timezone', 'TIMEZONE', 24],
    ['event', 'EVENT', 36],
    ['enabled', 'ENABLED', 8],
    ['nextRun', 'NEXT RUN', 16],
  ]);
}

function helpText(invocation = DEFAULT_INVOCATION): string {
  return `ctxmill — agent-friendly ctxmill API CLI

Usage:
  ${invocation} <command> [args] [flags]

Global flags:
  --base-url <url>       ctxmill API root (default: CTXMILL_API_URL, API_BASE, or http://localhost:3002)
  --api-token <token>    Bearer token (default: CTXMILL_API_TOKEN)
  --json                 Emit stable JSON envelope
  --raw                  Emit raw API payload
  --out <dir>            Save full JSON envelope to a directory
  --no-redact            Do not redact secret-like fields
  --dry-run              Validate a mutation and print the request without sending it
  --yes / -y             Skip confirmation on destructive ops (or set CTXMILL_YES=1)
  --help                 Show this help

Body flags (mutations):
  --data '<json>'        Inline JSON request body
  --from-file <path|->   Read JSON body from file or stdin (use - for stdin)

Wait flags (turns message|start):
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
  turns list <agentId>
  turns get <agentId> <turnId>

  conversations active
  conversations list|summary|snapshot ...
  sandbox-sessions active
  interrupts list <agentId> [--include-resolved]
  events list [--turn <id>] [--conversation <id>] | types | stats
  tools list

  artifacts list|get|download-url ...
  files ls|cat ...
  secrets list <agentId>
  webhooks list <agentId>
  triggers list|get ...
  schedules list|get ...

Mutation commands:
  agents create --from-file <path>
  agents update <agentId> --from-file <path>
  agents delete <agentId>                              [--yes]

  turns message <agentId> --content <text> [--conversation <id>] [--wait-for terminal|interrupt]
  turns start <agentId> --task <text> [--sandbox-secrets '{}'] [--wait-for ...]
  turns cancel <agentId> <turnId>                     [--yes]
  sandbox-sessions suspend|restore <agentId> <sandboxSessionId>
  sandbox-sessions kill <agentId> <sandboxSessionId>  [--yes]

  interrupts resolve <agentId> --interrupt <interruptId> --action approve|reject|submit [--data '{}']
  tools test <toolName> --input '{}'

  files write|update <agentId> --path <p> (--content <text> | --from-file <path|->) [--conversation <conversationId>]
  files ls|cat <agentId> --path <p> [--conversation <conversationId>]
  files delete <agentId> --path <p> [--conversation <conversationId>]   [--yes]

  artifacts list (--agent <agentId> | --turn <turnId>)
  artifacts upload --agent <id> --file <path> [--name <n>]      Multipart upload
  artifacts upload-url --agent <id> --name <n> [--mime <m>] [--size <bytes>]
  artifacts delete <artifactId>                        [--yes]

  workspace upload <agentId> --file <tarball.tar.gz> [--force --yes]   Gzip body, raw POST

  secrets set <agentId> --key <k> --value <v>
  secrets delete <agentId> <key>                       [--yes]

  keys list                                            Scoped api keys (WO-5; master token only)
  keys create --name <n> --cap <cap1> [--cap <cap2>] [--note <t>] [--expires-at <ms>]   Token shown once; --out disabled
  keys revoke <keyId>                                  [--yes]

  settings set --from-file <path>

  feedback submit <agentId> --conversation <cid> --message <mid> --type thumbs_up|thumbs_down [--comment <t>]

  webhooks add <agentId> --url <u> --events <csv> --secret <s>
  webhooks update <agentId> <webhookId> --from-file <path>
  webhooks delete <agentId> <webhookId>                [--yes]

  triggers create --from-file <path>
  triggers update <triggerId> --from-file <path>
  triggers delete <triggerId>                          [--yes]
  triggers emit --type <t> [--agent <id>] [--payload '{}']

  schedules create --from-file <path>
  schedules update <scheduleId> --from-file <path>
  schedules delete <scheduleId>                        [--yes]

Streaming commands:
  stream <agentId> [--limit N] [--timeout ms] [--until-type <t>] [--json]
  ag-ui run <agentId> --task "<text>" [--no-stream] [--data '<ag-ui body>']

Exit codes: 0=ok 1=api/runtime 2=usage 3=timeout 4=unsafe-blocked

Examples:
  ${invocation} health --json
  ${invocation} agents create --from-file agent.json --dry-run --json
  ${invocation} turns start agent_123 --task "Summarize repo" --wait-for terminal --timeout 600000
  ${invocation} ag-ui run agent_123 --task "Hello"
  ${invocation} stream agent_123 --limit 20
  ${invocation} artifacts upload --agent agent_123 --file ./report.pdf
  ${invocation} workspace upload agent_123 --file ./ws.tar.gz
  ${invocation} agents delete agent_123 --yes
  ${invocation} settings set --data '{"turnTimeoutMs":600000}'
`;
}
