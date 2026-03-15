import { resolve, normalize, join } from 'node:path';
import { existsSync } from 'node:fs';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { Message } from '../../types.js';
import type { DatabaseRepository } from '../../database/repository.js';

/** Patterns that should never be exposed via the file browsing API. */
const BLOCKED_PATTERNS = ['.env', '.git', '.ctxmill', 'credentials', '.pem', '.key', '.secret'];

/** Check if a filename or path segment matches any blocked pattern. */
export function isBlockedPath(name: string): boolean {
  const lower = name.toLowerCase();
  return BLOCKED_PATTERNS.some((pattern) => lower.includes(pattern));
}

/**
 * Resolve the base directory for file operations.
 *
 * When a `runId` is provided and a `dataDir` is configured, looks for a
 * session-merged workspace first and falls back to the agent's workspace dir
 * (or `process.cwd()` as a last resort).
 */
export function resolveBaseDir(
  agent: { id: string; workspaceDir?: string | null },
  opts?: { runId?: string; dataDir?: string },
): string | null {
  if (opts?.runId && opts.dataDir) {
    const sessionMerged = resolve(
      join(opts.dataDir, 'agents', agent.id, 'sessions', opts.runId, 'merged'),
    );
    if (existsSync(sessionMerged)) {
      return sessionMerged;
    }
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

/**
 * Resolve the session directory for an agent's workspace.
 * Pattern: `join(agent.workspaceDir, '..', '..', 'sessions')`
 */
export function resolveSessionDir(agent: { workspaceDir?: string | null }): string {
  return join(agent.workspaceDir!, '..', '..', 'sessions');
}

/**
 * Map raw DB message rows to the internal `Message[]` format.
 */
export function mapMessagesToInternal(
  allMessages: Array<{
    id: string;
    agentId?: string | null;
    role: string;
    content: string;
    toolCallId?: string | null;
    createdAt: string | number | Date;
  }>,
  fallbackAgentId: string,
): Message[] {
  return allMessages.map((m) => ({
    id: m.id,
    agentId: m.agentId ?? fallbackAgentId,
    role: m.role as Message['role'],
    content: m.content,
    toolCallId: m.toolCallId ?? undefined,
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
