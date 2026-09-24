/**
 * ctx-k6ad — REST artifact reads/writes must honour an agent-scoped key.
 *
 * Before the fix a scoped key with `artifacts:read` could read EVERY agent's
 * artifacts (metadata, content, and a signed URL that bypasses auth), and an
 * `artifacts:write` key could upload an artifact attributed to any agent.
 * api_keys now carries an optional agent_id; a key bound to an agent may only
 * reach that agent's artifacts (no-oracle 404 on cross-agent, mirroring the
 * gRPC rule) and its uploads are pinned to that agent. A null binding
 * (operator key / master token) keeps the legacy all-agents behaviour.
 */
import { createHash } from 'node:crypto';

import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { artifactRoutes } from '../artifacts.js';
import { registerApiAuth, type ApiKeyPrincipal, type ApiKeyStore } from '../../auth.js';
import type { ArtifactStore } from '../../../artifact/artifact-store.js';
import type { DatabaseRepository } from '../../../database/repository.js';

const MASTER_TOKEN = 'master-token';
const BOUND_A_TOKEN = `cmk_${'a'.repeat(43)}`;
const OPERATOR_TOKEN = `cmk_${'b'.repeat(43)}`;
const hash = (t: string) => createHash('sha256').update(t).digest('hex');

const boundToA: ApiKeyPrincipal = {
  keyId: 'key-a', name: 'bound-a', capabilities: ['artifacts:read', 'artifacts:write'], agentId: 'agent-A',
};
const operatorKey: ApiKeyPrincipal = {
  keyId: 'key-op', name: 'operator', capabilities: ['artifacts:read', 'artifacts:write'], agentId: null,
};

const keyStore: ApiKeyStore = {
  findLiveKeyByTokenHash: async (h) =>
    h === hash(BOUND_A_TOKEN) ? boundToA : h === hash(OPERATOR_TOKEN) ? operatorKey : null,
  isLiveKey: async () => true,
  touchLastUsed: async () => {},
};

const artB = {
  id: 'art-B', agentId: 'agent-B' as string | null, turnId: null, conversationId: null,
  name: 'b-secret.txt', mimeType: 'text/plain', sizeBytes: 10,
  storageKey: 'artifacts/art-B/b-secret.txt', bucket: 'artifacts',
  kind: null, metadata: null, sha256: null,
  status: 'active', expiresAt: null, createdAt: 1, updatedAt: 1,
};
const artUnowned = { ...artB, id: 'art-U', agentId: null, name: 'orphan.txt', storageKey: 'artifacts/art-U/orphan.txt' };
const artA = { ...artB, id: 'art-A', agentId: 'agent-A', name: 'a-owned.txt', storageKey: 'artifacts/art-A/a-owned.txt' };
const byId: Record<string, typeof artB> = { 'art-B': artB, 'art-U': artUnowned, 'art-A': artA };

function makeApp(registrationRegister = vi.fn().mockResolvedValue(undefined)) {
  const repository = {
    getArtifact: vi.fn(async (id: string) => byId[id]),
    listArtifactsForAgent: vi.fn(async (agentId: string) =>
      Object.values(byId).filter((a) => a.agentId === agentId)),
    listAllArtifacts: vi.fn(async () => ({ artifacts: Object.values(byId), total: Object.keys(byId).length })),
    listArtifactsForTurn: vi.fn(async () => Object.values(byId)),
  } as unknown as DatabaseRepository;
  const artifactStore = {
    download: vi.fn(async () => ({ body: Buffer.from('SECRET-B'), contentType: 'text/plain' })),
    getSignedDownloadUrl: vi.fn(async () => 'https://minio.test/signed'),
    getSignedUploadUrl: vi.fn(async () => 'https://minio.test/upload'),
    headObject: vi.fn(async () => ({ sizeBytes: 10, contentType: 'text/plain' })),
  } as unknown as ArtifactStore;

  const app = Fastify({ logger: false });
  registerApiAuth(app, { mode: 'enforce', token: MASTER_TOKEN }, keyStore);
  app.register(multipart);
  app.register(artifactRoutes, {
    prefix: '/api/artifacts',
    repository,
    artifactStore,
    bucket: 'artifacts',
    registrationService: { register: registrationRegister } as never,
  });
  return { app, repository, artifactStore, registrationRegister };
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

describe('ctx-k6ad artifact agent scoping', () => {
  const apps: Array<ReturnType<typeof makeApp>['app']> = [];
  const open = () => { const h = makeApp(); apps.push(h.app); return h; };
  afterEach(async () => { await Promise.all(apps.splice(0).map((a) => a.close())); });

  it("hides another agent's artifact from a bound key (no-oracle 404)", async () => {
    const { app } = open();
    for (const path of ['/api/artifacts/art-B', '/api/artifacts/art-B/download', '/api/artifacts/art-B/download-url']) {
      const res = await app.inject({ method: 'GET', url: path, headers: auth(BOUND_A_TOKEN) });
      expect(res.statusCode, path).toBe(404);
    }
  });

  it('lets a bound key reach its own agent and unowned artifacts', async () => {
    const { app } = open();
    const own = await app.inject({ method: 'GET', url: '/api/artifacts/art-A', headers: auth(BOUND_A_TOKEN) });
    expect(own.statusCode).toBe(200);
    const orphan = await app.inject({ method: 'GET', url: '/api/artifacts/art-U/download', headers: auth(BOUND_A_TOKEN) });
    expect(orphan.statusCode).toBe(200);
  });

  it('pins a bound-key list to its own agent and ignores the agentId param', async () => {
    const { app, repository } = open();
    const res = await app.inject({
      method: 'GET', url: '/api/artifacts?agentId=agent-B', headers: auth(BOUND_A_TOKEN),
    });
    expect(res.statusCode).toBe(200);
    expect(repository.listArtifactsForAgent).toHaveBeenCalledWith('agent-A', expect.anything(), expect.anything());
    expect(repository.listAllArtifacts).not.toHaveBeenCalled();
    expect(res.json().artifacts.every((a: { agentId: string }) => a.agentId === 'agent-A')).toBe(true);
  });

  it('pins a bound-key upload to its own agent even if it claims another', async () => {
    const { app, registrationRegister } = open();
    const res = await app.inject({
      method: 'POST', url: '/api/artifacts/upload-url', headers: auth(BOUND_A_TOKEN),
      payload: { agentId: 'agent-B', name: 'x.txt', mimeType: 'text/plain' },
    });
    expect(res.statusCode).toBe(200);
    expect(registrationRegister).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'agent-A' }));
  });

  it('keeps all-agents reach for the master token and a null-bound operator key', async () => {
    for (const token of [MASTER_TOKEN, OPERATOR_TOKEN]) {
      const { app } = open();
      const res = await app.inject({ method: 'GET', url: '/api/artifacts/art-B', headers: auth(token) });
      expect(res.statusCode, token).toBe(200);
      expect(res.json().agentId).toBe('agent-B');
    }
  });
});
