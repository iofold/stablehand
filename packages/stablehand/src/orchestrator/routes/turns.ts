import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  TurnLookupResponseSchema,
  TurnSearchResponseSchema,
  TurnStatusSchema,
  type TurnStatus,
} from '@stablehand/contracts';

import type { DatabaseRepository } from '../../database/repository.js';
import { MAX_TAG_VALUE_LENGTH } from '../turn-tags.js';
import { toApiAgentTurn } from './agents/helpers.js';

export interface TurnRouteOptions {
  db: Pick<DatabaseRepository, 'getSandboxSessionsByIds' | 'getTurn' | 'searchTurns'>;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function badRequest(reply: FastifyReply, error: string) {
  return reply.status(400).send({ error });
}

function queryValues(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** Cursor = base64url("<queuedAt>:<id>") of the last row on the page. */
function encodeCursor(turn: { queuedAt: number; id: string }): string {
  return Buffer.from(`${turn.queuedAt}:${turn.id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { queuedAt: number; id: string } | undefined {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator <= 0) return undefined;
  const queuedAt = Number(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);
  if (!Number.isSafeInteger(queuedAt) || queuedAt < 0 || id.length === 0) return undefined;
  return { queuedAt, id };
}

/**
 * Cross-agent turn reads (ctx-89id): find turns by tag (for example every
 * turn of one campaign) and look one turn up by id without knowing its agent.
 * A key bound to one agent only ever sees that agent's turns.
 */
export async function turnRoutes(
  app: FastifyInstance,
  options: TurnRouteOptions,
): Promise<void> {
  const { db } = options;

  app.get('/', { config: { capability: 'agents:read' } }, async (request, reply) => {
    const query = request.query as {
      tag?: string | string[];
      status?: string | string[];
      agentId?: string;
      limit?: string;
      cursor?: string;
    };

    const tags: Record<string, string> = {};
    for (const raw of queryValues(query.tag)) {
      const separator = raw.indexOf(':');
      const key = separator > 0 ? raw.slice(0, separator).trim() : '';
      const value = separator > 0 ? raw.slice(separator + 1) : '';
      if (!key || value.length === 0 || value.length > MAX_TAG_VALUE_LENGTH) {
        return badRequest(
          reply,
          `tag must be key:value with a non-empty key and a value of 1-${MAX_TAG_VALUE_LENGTH} characters`,
        );
      }
      if (tags[key] !== undefined && tags[key] !== value) {
        return badRequest(reply, `tag ${key} is given twice with different values`);
      }
      tags[key] = value;
    }

    const statuses: TurnStatus[] = [];
    for (const raw of queryValues(query.status).flatMap((value) => value.split(','))) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const parsed = TurnStatusSchema.safeParse(trimmed.toUpperCase());
      if (!parsed.success) {
        return badRequest(
          reply,
          `Invalid status filter: ${trimmed}. Valid values: ${TurnStatusSchema.options.join(', ')}`,
        );
      }
      if (!statuses.includes(parsed.data)) statuses.push(parsed.data);
    }

    const requestedLimit = query.limit === undefined ? DEFAULT_LIMIT : Number(query.limit);
    if (!Number.isInteger(requestedLimit) || requestedLimit <= 0) {
      return badRequest(reply, 'limit must be a positive integer');
    }
    const limit = Math.min(requestedLimit, MAX_LIMIT);

    const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    if (query.cursor !== undefined && !after) {
      return badRequest(reply, 'cursor is not valid; pass back the nextCursor from the previous page');
    }

    if (query.agentId !== undefined && query.agentId.trim().length === 0) {
      return badRequest(reply, 'agentId must be a non-empty string');
    }
    // ctx-k6ad pattern: a key bound to one agent is pinned to it; asking for
    // another agent returns an empty page rather than revealing anything.
    const boundAgentId = request.apiPrincipal?.agentId ?? null;
    const requestedAgentId = query.agentId?.trim();
    if (boundAgentId && requestedAgentId && requestedAgentId !== boundAgentId) {
      return TurnSearchResponseSchema.parse({ turns: [] });
    }
    const agentId = boundAgentId ?? requestedAgentId;

    const page = await db.searchTurns({
      ...(Object.keys(tags).length > 0 ? { tags } : {}),
      ...(statuses.length > 0 ? { statuses } : {}),
      ...(agentId ? { agentId } : {}),
      limit,
      ...(after ? { after } : {}),
    });

    const sandboxIds = [...new Set(
      page.turns
        .map((turn) => turn.sandboxSessionId)
        .filter((id): id is string => typeof id === 'string'),
    )];
    const sandboxById = new Map(
      (await db.getSandboxSessionsByIds(sandboxIds)).map((session) => [session.id, session]),
    );

    const last = page.turns[page.turns.length - 1];
    return TurnSearchResponseSchema.parse({
      turns: page.turns.map((turn) => toApiAgentTurn(
        turn,
        turn.sandboxSessionId ? sandboxById.get(turn.sandboxSessionId) : null,
      )),
      ...(page.hasMore && last ? { nextCursor: encodeCursor(last) } : {}),
    });
  });

  app.get('/:turnId', { config: { capability: 'agents:read' } }, async (request, reply) => {
    const { turnId } = request.params as { turnId: string };
    const turn = await db.getTurn(turnId);
    const boundAgentId = request.apiPrincipal?.agentId ?? null;
    if (!turn || (boundAgentId && turn.agentId !== boundAgentId)) {
      return reply.status(404).send({ error: 'Turn not found', turnId });
    }
    const [sandboxSession] = turn.sandboxSessionId
      ? await db.getSandboxSessionsByIds([turn.sandboxSessionId])
      : [];
    return TurnLookupResponseSchema.parse({
      turn: toApiAgentTurn(turn, sandboxSession ?? null),
    });
  });
}
