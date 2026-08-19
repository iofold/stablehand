/**
 * ctx-sf2n — GET /api/sandbox-sessions must serve exactly the contract shape.
 *
 * Before the fix the route stripped only runtimeDefinitionHash from raw
 * repository rows, so columns added later (checkpointFailures /
 * lastCheckpointError, ctx-vsf8) leaked into the response and the strict
 * SandboxSessionSchema-parsing UI/SDK threw on any live session. The route now
 * projects explicitly and parses at the reply site.
 */
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { SandboxSessionListResponseSchema } from '@ctxmill/contracts';
import { activeSandboxSessionRoutes } from '../agents/active-lifecycle.js';

const row = {
  id: 'f2b7c1de-0000-4000-8000-000000000001',
  conversationId: 'f2b7c1de-0000-4000-8000-000000000002',
  agentId: 'f2b7c1de-0000-4000-8000-000000000003',
  containerName: 'ctxmill-sandbox-1',
  containerId: 'container-1',
  status: 'ACTIVE',
  harnessName: 'langgraph',
  checkpointRef: null,
  createdAt: 1_755_000_000_000,
  updatedAt: 1_755_000_000_000,
  lastActivityAt: 1_755_000_000_000,
  restoreAttempts: 0,
  lastRestoreError: null,
  // The two columns that used to leak and break strict parsing:
  checkpointFailures: 2,
  lastCheckpointError: 'checkpoint too large',
  restoreOwnerId: null,
  restoreFenceToken: 1,
  restoreLeaseExpiresAt: null,
  // Private columns that must never appear:
  runtimeDefinitionHash: 'runtime-abc',
};

describe('ctx-sf2n active sandbox-session list projection', () => {
  it('parses under the strict contract and exposes checkpoint evidence, not private columns', async () => {
    const app = Fastify({ logger: false });
    await app.register(activeSandboxSessionRoutes, {
      prefix: '/api/sandbox-sessions',
      db: { getActiveSandboxSessions: vi.fn().mockResolvedValue([row]) } as never,
    } as never);

    const res = await app.inject({ method: 'GET', url: '/api/sandbox-sessions?status=active' });
    expect(res.statusCode).toBe(200);

    // The exact consumer behavior that broke: strict parse of the response.
    const sessions = SandboxSessionListResponseSchema.parse(res.json());
    expect(sessions).toHaveLength(1);
    expect(sessions[0].checkpointFailures).toBe(2);
    expect(sessions[0].lastCheckpointError).toBe('checkpoint too large');
    expect('runtimeDefinitionHash' in (res.json()[0] as object)).toBe(false);
    await app.close();
  });
});
