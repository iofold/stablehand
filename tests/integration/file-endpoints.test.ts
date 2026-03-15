import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { allowConsoleErrors } from '../setup-strict.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';

import { createContainer } from '../../packages/ctxmill/src/config/container.js';
import { createServer } from '../../packages/ctxmill/src/orchestrator/server.js';
import type { AppContainer } from '../../packages/ctxmill/src/config/container.js';
import { MockOverlayFactory } from '../../packages/ctxmill/src/workspace/mock-overlay.js';

describe('File endpoint integration tests', () => {
  let app: FastifyInstance;
  let container: AppContainer;
  let dataDir: string;
  let agentId: string;
  let workspaceDir: string;

  beforeEach(() => { allowConsoleErrors(); });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'file-test-'));

    container = await createContainer(
      {
        preset: 'local',
        database: {
          type: 'sqlite',
          path: 'data.db',
        },
        llm: {
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
          apiKey: 'test-key-not-used',
        },
      },
      dataDir,
    );

    const envFactory = new MockOverlayFactory();

    app = await createServer({
      db: container.db,
      executor: container.agentExecutor,
      runRegistry: container.runRegistry,
      eventBus: container.eventBus,
      dataDir,
      envFactory,
    });

    await app.ready();

    // Create a test agent
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/agents',
      payload: {
        name: 'file-test-agent',
        model: 'test-model',
        systemPrompt: 'You are a test agent.',
        tools: [],
      },
    });
    expect(createRes.statusCode).toBe(201);
    const agentBody = createRes.json();
    agentId = agentBody.id;

    const agent = await container.db.getAgent(agentId);
    workspaceDir = agent!.workspaceDir!;

    // Populate workspace with test files
    writeFileSync(join(workspaceDir, 'README.md'), '# Test Agent\nThis is a test workspace.');
    mkdirSync(join(workspaceDir, 'data', 'deep', 'nested'), { recursive: true });
    writeFileSync(join(workspaceDir, 'data', 'portfolio.json'), '{"holdings":[{"symbol":"AAPL","shares":100}]}');
    writeFileSync(join(workspaceDir, 'data', 'deep', 'nested', 'file.txt'), 'deeply nested content');
    writeFileSync(join(workspaceDir, 'large-file.txt'), 'x'.repeat(52000));

    // Blocked files
    writeFileSync(join(workspaceDir, '.env'), 'SECRET=should_not_be_visible');
    mkdirSync(join(workspaceDir, 'secrets'), { recursive: true });
    writeFileSync(join(workspaceDir, 'secrets', 'credentials.json'), '{"key":"hidden"}');
    mkdirSync(join(workspaceDir, '.git'), { recursive: true });
    writeFileSync(join(workspaceDir, '.git', 'config'), '[core]\nbare = false');
  });

  afterAll(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  // ── Listing Tests ──

  it('lists root entries excluding blocked patterns and dotfiles', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/agents/${agentId}/files`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    const names = body.entries.map((e: { name: string }) => e.name);

    expect(names).toContain('README.md');
    expect(names).toContain('data');
    expect(names).toContain('large-file.txt');
    // Blocked / dotfiles should not appear
    expect(names).not.toContain('.env');
    expect(names).not.toContain('.git');
    // Note: 'secrets' dir is visible in listing (blocked patterns use '.secret' not 'secret')
    // but files inside containing 'credentials' are blocked by the read endpoint
  });

  it('lists nested directory contents', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/agents/${agentId}/files?path=data`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    const names = body.entries.map((e: { name: string }) => e.name);

    expect(names).toContain('portfolio.json');
    expect(names).toContain('deep');
  });

  it('lists deeply nested directory contents', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/agents/${agentId}/files?path=data/deep/nested`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    const names = body.entries.map((e: { name: string }) => e.name);

    expect(names).toContain('file.txt');
  });

  it('returns entries for an empty subdirectory', async () => {
    mkdirSync(join(workspaceDir, 'empty-dir'), { recursive: true });
    const res = await app.inject({
      method: 'GET',
      url: `/api/agents/${agentId}/files?path=empty-dir`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.entries).toEqual([]);
  });

  // ── Path Traversal Tests ──

  it('rejects path traversal with ../../etc', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/agents/${agentId}/files?path=../../etc`,
    });

    expect([400, 403]).toContain(res.statusCode);
  });

  it('rejects path traversal with ../../../etc/passwd', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/agents/${agentId}/files?path=../../../etc/passwd`,
    });

    expect([400, 403]).toContain(res.statusCode);
  });

  // ── Read Tests ──

  it('reads README.md content', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/agents/${agentId}/files/read?path=README.md`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.path).toBe('README.md');
    expect(body.content).toBe('# Test Agent\nThis is a test workspace.');
    expect(body.size).toBeGreaterThan(0);
  });

  it('reads nested JSON file', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/agents/${agentId}/files/read?path=data/portfolio.json`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    const parsed = JSON.parse(body.content);
    expect(parsed.holdings[0].symbol).toBe('AAPL');
  });

  it('returns 400 when path param is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/agents/${agentId}/files/read`,
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toContain('path');
  });

  it('returns 400 for files exceeding 50KB', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/agents/${agentId}/files/read?path=large-file.txt`,
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toContain('too large');
  });

  it('returns 403 for .env file', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/agents/${agentId}/files/read?path=.env`,
    });

    expect(res.statusCode).toBe(403);
  });

  it('returns 403 for secrets/credentials.json', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/agents/${agentId}/files/read?path=secrets/credentials.json`,
    });

    expect(res.statusCode).toBe(403);
  });

  it('returns 403 for .git/config', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/agents/${agentId}/files/read?path=.git/config`,
    });

    expect(res.statusCode).toBe(403);
  });

  it('returns 403 for path traversal in read', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/agents/${agentId}/files/read?path=../../etc/passwd`,
    });

    expect([400, 403]).toContain(res.statusCode);
  });

  it('returns 400 for nonexistent file', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/agents/${agentId}/files/read?path=nonexistent.txt`,
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when path is a directory', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/agents/${agentId}/files/read?path=data`,
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toContain('directory');
  });

  // ── Session Tests ──

  it('lists files from session workspace when runId is provided', async () => {
    // Register a real run with a real conversation so FK + runId validation passes
    const conv1 = await container.db.createConversation(agentId);
    const run = await container.runRegistry.startRun(agentId, conv1.id, 'interactive');
    const runId = run.id;
    // Create session merged workspace dir under dataDir/agents/:id/sessions/:runId/merged
    const sessionMergedDir = join(dataDir, 'agents', agentId, 'sessions', runId, 'merged');
    mkdirSync(sessionMergedDir, { recursive: true });
    writeFileSync(join(sessionMergedDir, 'session-file.txt'), 'session content');

    const res = await app.inject({
      method: 'GET',
      url: `/api/agents/${agentId}/files?runId=${runId}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    const names = body.entries.map((e: { name: string }) => e.name);
    expect(names).toContain('session-file.txt');
  });

  it('reads file from session workspace when runId is provided', async () => {
    // Register a real run with a real conversation so FK + runId validation passes
    const conv2 = await container.db.createConversation(agentId);
    const run = await container.runRegistry.startRun(agentId, conv2.id, 'interactive');
    const runId = run.id;
    // Create session merged workspace dir under dataDir/agents/:id/sessions/:runId/merged
    const sessionMergedDir = join(dataDir, 'agents', agentId, 'sessions', runId, 'merged');
    mkdirSync(sessionMergedDir, { recursive: true });
    writeFileSync(join(sessionMergedDir, 'session-file.txt'), 'session content');

    const res = await app.inject({
      method: 'GET',
      url: `/api/agents/${agentId}/files/read?path=session-file.txt&runId=${runId}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.content).toBe('session content');
    expect(body.path).toBe('session-file.txt');
  });

  // ── 404 Test ──

  it('returns 404 for non-existent agent', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/agents/00000000-0000-0000-0000-000000000000/files',
    });

    expect(res.statusCode).toBe(404);
  });
});
