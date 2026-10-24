import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileRoutes } from '../../orchestrator/routes/agents/files.js';
import type { AgentSubRouteOptions } from '../../orchestrator/routes/agents/types.js';

describe.runIf(process.platform === 'linux')('workspace file route containment', () => {
  let fixture: string;
  let workspace: string;
  let outside: string;
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await mkdir(join(process.cwd(), '.tmp'), { recursive: true });
    fixture = await mkdtemp(join(process.cwd(), '.tmp', 'safe-file-routes-'));
    workspace = join(fixture, 'workspace');
    outside = join(fixture, 'outside');
    await mkdir(workspace);
    await mkdir(outside);
    await writeFile(join(outside, 'ordinary.txt'), 'SYNTHETIC-HOST-SECRET');
    app = Fastify();
    const options = {
      db: {},
      loadAgent: async (request: { agent?: unknown }) => {
        request.agent = { id: 'agent-a', workspaceDir: workspace };
      },
    } as unknown as AgentSubRouteOptions;
    await app.register(fileRoutes, { ...options, prefix: '/api/agents' });
  });

  afterEach(async () => {
    await app?.close();
    await rm(fixture, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it.each(['GET', 'POST', 'PUT', 'DELETE'] as const)('rejects a leaf symlink for %s', async (method) => {
    await symlink(join(outside, 'ordinary.txt'), join(workspace, 'ordinary.txt'));
    const response = await app.inject({
      method,
      url: method === 'GET'
        ? '/api/agents/agent-a/files/read?path=ordinary.txt'
        : `/api/agents/agent-a/files${method === 'DELETE' ? '?path=ordinary.txt' : ''}`,
      ...(['POST', 'PUT'].includes(method) ? { payload: { path: 'ordinary.txt', content: 'ATTACK' } } : {}),
    });
    expect(response.statusCode).toBe(400);
    expect(await readFile(join(outside, 'ordinary.txt'), 'utf8')).toBe('SYNTHETIC-HOST-SECRET');
  });

  it.each(['GET', 'POST', 'PUT', 'DELETE'] as const)('rejects an ancestor symlink for %s', async (method) => {
    await symlink(outside, join(workspace, 'alias'));
    const response = await app.inject({
      method,
      url: method === 'GET'
        ? '/api/agents/agent-a/files/read?path=alias/ordinary.txt'
        : `/api/agents/agent-a/files${method === 'DELETE' ? '?path=alias/ordinary.txt' : ''}`,
      ...(['POST', 'PUT'].includes(method) ? { payload: { path: 'alias/ordinary.txt', content: 'ATTACK' } } : {}),
    });
    expect(response.statusCode).toBe(400);
    expect(await readFile(join(outside, 'ordinary.txt'), 'utf8')).toBe('SYNTHETIC-HOST-SECRET');
  });

  it('rejects directory traversal through a symlink and omits symlinks from listings', async () => {
    await symlink(outside, join(workspace, 'alias'));
    const escaped = await app.inject({ method: 'GET', url: '/api/agents/agent-a/files?path=alias' });
    expect(escaped.statusCode).toBe(400);
    const listing = await app.inject({ method: 'GET', url: '/api/agents/agent-a/files' });
    expect(listing.statusCode).toBe(200);
    expect(listing.json()).toEqual({ entries: [] });
  });

  it('preserves nested create, read, update, listing and delete response shapes', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/agents/agent-a/files', payload: { path: 'one/two/file.txt', content: 'hello' } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual({ path: 'one/two/file.txt', sizeBytes: 5 });
    const read = await app.inject({ method: 'GET', url: '/api/agents/agent-a/files/read?path=one/two/file.txt' });
    expect(read.json()).toEqual({ path: 'one/two/file.txt', content: 'hello', sizeBytes: 5 });
    const updated = await app.inject({ method: 'PUT', url: '/api/agents/agent-a/files', payload: { path: 'one/two/file.txt', content: 'next' } });
    expect(updated.json()).toEqual({ path: 'one/two/file.txt', sizeBytes: 4 });
    const listed = await app.inject({ method: 'GET', url: '/api/agents/agent-a/files?path=one/two' });
    expect(listed.json()).toEqual({ entries: [{ name: 'file.txt', type: 'file', sizeBytes: 4 }] });
    const deleted = await app.inject({ method: 'DELETE', url: '/api/agents/agent-a/files?path=one/two/file.txt' });
    expect(deleted.statusCode).toBe(204);
    const missing = await app.inject({ method: 'GET', url: '/api/agents/agent-a/files/read?path=one/two/file.txt' });
    expect(missing.statusCode).toBe(404);
  });
});
