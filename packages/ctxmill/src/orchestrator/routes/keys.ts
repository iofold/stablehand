import type { FastifyInstance, FastifyReply } from 'fastify';
import { ApiKeyCreateInputSchema, type ApiKey, type ApiKeyCreated } from '@ctxmill/contracts';

import type { DatabaseRepository } from '../../database/repository.js';
import type { ApiKeyRow } from '../../database/types.js';
import { apiKeyTokenHash, generateApiKeyToken } from '../api-key-token.js';

export interface ApiKeyRouteOptions {
  db: Pick<DatabaseRepository, 'createApiKey' | 'listApiKeys' | 'getApiKey' | 'revokeApiKey'>;
}

// These routes intentionally declare no `capability` — under the WO-5
// fail-closed default they are master-only, which is the "key management is
// never grantable" rule enforced structurally rather than by exception.

function toPublicApiKey(row: ApiKeyRow): ApiKey {
  return {
    id: row.id,
    name: row.name,
    capabilities: row.capabilities,
    note: row.note ?? null,
    createdAt: row.createdAt,
    createdBy: row.createdBy ?? null,
    expiresAt: row.expiresAt ?? null,
    lastUsedAt: row.lastUsedAt ?? null,
    revokedAt: row.revokedAt ?? null,
  };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

function invalidBody(reply: FastifyReply, issues: { path: PropertyKey[]; message: string }[]): FastifyReply {
  const issue = issues[0];
  const path = issue?.path.length ? `${issue.path.join('.')}: ` : '';
  return reply.status(400).send({
    error: `Invalid api key request: ${path}${issue?.message ?? 'invalid request'}`,
  });
}

export async function apiKeyRoutes(app: FastifyInstance, opts: ApiKeyRouteOptions): Promise<void> {
  const { db } = opts;

  app.post('/', async (request, reply) => {
    const parsed = ApiKeyCreateInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return invalidBody(reply, parsed.error.issues);
    }

    const token = generateApiKeyToken();
    try {
      const row = await db.createApiKey({
        name: parsed.data.name,
        tokenHash: apiKeyTokenHash(token),
        capabilities: parsed.data.capabilities,
        note: parsed.data.note ?? null,
        createdBy: 'master',
        expiresAt: parsed.data.expiresAt ?? null,
      });
      const body: ApiKeyCreated = { ...toPublicApiKey(row), token };
      return reply.status(201).send(body);
    } catch (err) {
      if (isUniqueViolation(err)) {
        return reply.status(409).send({ error: `An api key named '${parsed.data.name}' already exists` });
      }
      throw err;
    }
  });

  app.get('/', async () => {
    const rows = await db.listApiKeys();
    return { keys: rows.map(toPublicApiKey) };
  });

  app.delete('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = await db.revokeApiKey(id);
    if (!row) {
      return reply.status(404).send({ error: `Unknown api key: ${id}` });
    }
    return toPublicApiKey(row);
  });
}
