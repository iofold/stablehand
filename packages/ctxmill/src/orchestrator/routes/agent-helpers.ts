import { resolve, normalize } from 'node:path';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { Message } from '@ctxmill/sandbox-daemon';
import type { DatabaseRepository } from '../../database/repository.js';
import type { MessageSelect } from '../../database/types.js';
import type { ApiMessage } from '@ctxmill/shared';
import { getConversationWorkspacePath } from '../../workspace/session-workspace.js';

/** Patterns that should never be exposed via the file browsing API. */
const BLOCKED_PATTERNS = ['.env', '.git', '.ctxmill', 'credentials', '.pem', '.key', '.secret'];

interface RawTranscriptMessage {
  id: string;
  agentId?: string | null;
  role: string;
  content: string;
  toolCallId?: string | null;
  toolCalls?: unknown;
  createdAt: string | number | Date;
}

/** Explicit public projection: never leak internal publication watermarks. */
export function toApiMessage(message: MessageSelect): ApiMessage {
  return {
    id: message.id,
    conversationId: message.conversationId,
    ...(message.agentId ? { agentId: message.agentId } : {}),
    ...(message.turnId ? { turnId: message.turnId } : {}),
    ...(message.messageSeq != null ? { messageSeq: message.messageSeq } : {}),
    messageRevision: message.messageRevision,
    role: message.role as ApiMessage['role'],
    content: message.content,
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    ...(Array.isArray(message.toolCalls)
      ? { toolCalls: message.toolCalls as ApiMessage['toolCalls'] }
      : {}),
    ...(Array.isArray(message.parts)
      ? { parts: message.parts as ApiMessage['parts'] }
      : {}),
    createdAt: message.createdAt,
  };
}

type InternalToolCall = NonNullable<Message['toolCalls']>[number];

type WorkspaceTargetRequest = FastifyRequest<{
  Params: { id: string };
  Querystring: { conversationId?: string };
}>;
type WorkspaceTargetAgent = { id: string; workspaceDir?: string | null };

/** Check if a filename or path segment matches any blocked pattern. */
export function isBlockedPath(name: string): boolean {
  const lower = name.toLowerCase();
  return BLOCKED_PATTERNS.some((pattern) => lower.includes(pattern));
}

/**
 * Resolve the base directory for file operations.
 *
 * When a conversation id and `dataDir` are available, resolves the isolated
 * conversation workspace. Otherwise falls back to the base agent workspace.
 */
export function resolveBaseDir(
  agent: { id: string; workspaceDir?: string | null },
  opts?: { conversationId?: string | null; dataDir?: string },
): string | null {
  if (opts?.conversationId && opts.dataDir) {
    return getConversationWorkspacePath(opts.dataDir, agent.id, opts.conversationId);
  }

  return agent.workspaceDir ? resolve(agent.workspaceDir) : null;
}

/**
 * Validate that a resolved target path stays inside `baseDir` and that none
 * of its segments match a blocked pattern.
 *
 * Returns `null` when the path is valid, or a `{ status, body }` object that
 * should be sent as the reply when validation fails.
 */
export function validateSandboxPath(
  baseDir: string,
  filePath: string,
): { status: number; body: { error: string } } | null {
  const normalizedBase = resolve(baseDir);
  const target = resolve(normalizedBase, normalize(filePath));

  // Sandbox check: resolved path must be within baseDir (path-boundary safe)
  if (target !== normalizedBase && !target.startsWith(normalizedBase + '/')) {
    return { status: 403, body: { error: 'Path outside agent workspace' } };
  }

  // Block sensitive file patterns
  const segments = filePath.split('/');
  if (segments.some((seg) => isBlockedPath(seg))) {
    return { status: 403, body: { error: 'Access to this file is forbidden' } };
  }

  return null;
}

export async function resolveWorkspaceTarget(
  request: WorkspaceTargetRequest,
  reply: FastifyReply,
  deps: { db: Pick<DatabaseRepository, 'getConversation'>; dataDir?: string },
  filePath: string,
): Promise<{ baseDir: string; target: string } | null> {
  const { id } = request.params;
  const query = request.query as { conversationId?: string };
  let conversationId: string | null | undefined;

  if (query.conversationId) {
    const conversation = await deps.db.getConversation(query.conversationId);
    if (!conversation || conversation.agentId !== id) {
      await reply.status(404).send({
        error: 'Conversation not found',
        conversationId: query.conversationId,
      });
      return null;
    }
    conversationId = conversation.id;
  }

  const agent = (request as WorkspaceTargetRequest & { agent: WorkspaceTargetAgent }).agent;
  const baseDir = resolveBaseDir(agent, {
    conversationId,
    dataDir: deps.dataDir,
  });
  if (!baseDir) {
    await reply.status(500).send({ error: 'Agent has no workspace configured' });
    return null;
  }

  const pathError = validateSandboxPath(baseDir, filePath);
  if (pathError) {
    await reply.status(pathError.status).send(pathError.body);
    return null;
  }

  return {
    baseDir,
    target: resolve(baseDir, normalize(filePath)),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value));
}

function parseJsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? cloneRecord(parsed) : undefined;
  } catch {
    return undefined;
  }
}

function normalizeToolCallArguments(toolCall: Record<string, unknown>): Record<string, unknown> {
  for (const key of ['arguments', 'args', 'input', 'argumentsJson']) {
    const value = toolCall[key];
    if (isRecord(value)) return cloneRecord(value);
    if (typeof value === 'string') {
      const parsed = parseJsonRecord(value);
      if (parsed) return parsed;
    }
  }

  return {};
}

function normalizePersistedToolCalls(value: unknown): Message['toolCalls'] | undefined {
  if (!Array.isArray(value)) return undefined;

  const toolCalls: InternalToolCall[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;

    const id = typeof entry.id === 'string' ? entry.id : undefined;
    const name = typeof entry.name === 'string'
      ? entry.name
      : typeof entry.toolName === 'string'
        ? entry.toolName
        : undefined;
    if (!id || !name) continue;

    const toolCall: InternalToolCall = {
      id,
      name,
      arguments: normalizeToolCallArguments(entry),
    };
    if (typeof entry.idempotencyKey === 'string') {
      toolCall.idempotencyKey = entry.idempotencyKey;
    }
    toolCalls.push(toolCall);
  }

  return toolCalls.length > 0 ? toolCalls : undefined;
}

/**
 * Map raw DB message rows to the internal `Message[]` format.
 *
 * This is the canonical transcript assembly path used when preparing a run.
 * It sorts by `(createdAt, id)` and de-duplicates by message id so replaying
 * the same persisted rows always yields the same transcript in the same order.
 */
export function mapMessagesToInternal(
  allMessages: RawTranscriptMessage[],
  fallbackAgentId: string,
): Message[] {
  const byId = new Map<string, RawTranscriptMessage>();

  for (const message of allMessages) {
    if (!byId.has(message.id)) {
      byId.set(message.id, message);
    }
  }

  return [...byId.values()]
    .sort((a, b) => {
      const createdDelta = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      if (createdDelta !== 0) return createdDelta;
      return a.id.localeCompare(b.id);
    })
    .map((m) => ({
      id: m.id,
      agentId: m.agentId ?? fallbackAgentId,
      role: m.role as Message['role'],
      content: m.content,
      toolCallId: m.toolCallId ?? undefined,
      toolCalls: normalizePersistedToolCalls(m.toolCalls),
      createdAt: new Date(m.createdAt),
    }));
}

/**
 * Fastify preHandler that loads an agent by `:id` from the DB and attaches
 * it to `request.agent`. Sends a 404 reply if the agent doesn't exist.
 *
 * Usage:
 *   app.get('/:id/foo', { preHandler: [requireAgent(db)] }, handler)
 */
export function requireAgent(db: DatabaseRepository) {
  return async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ): Promise<void> => {
    const { id } = (request.params as { id: string });
    const agent = await db.getAgent(id);
    if (!agent) {
      reply.status(404).send({ error: 'Agent not found', agentId: id });
      return;
    }
    (request as any).agent = agent;
  };
}
