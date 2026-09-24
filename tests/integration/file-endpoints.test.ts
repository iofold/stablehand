import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { allowConsoleErrors } from '../setup-strict.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createGzip } from 'node:zlib';

import { getConversationWorkspacePath } from '../../packages/stablehand/src/workspace/session-workspace.js';
import { createTestApp, type TestAppHandle } from '../utils/test-app.js';

interface TarPack {
  entry(header: { name: string; size: number; type: 'file'; mode: number }, data: string): void;
  finalize(): void;
  pipe<T extends NodeJS.WritableStream>(destination: T): T;
}

async function createWorkspaceArchive(files: Record<string, string>): Promise<Buffer> {
  const tarModulePath = new URL(
    '../../packages/stablehand/node_modules/tar-stream/index.js',
    import.meta.url,
  ).href;
  const tar = await import(tarModulePath) as { pack(): TarPack };
  const pack = tar.pack();
  for (const [name, content] of Object.entries(files)) {
    pack.entry({
      name,
      size: Buffer.byteLength(content),
      type: 'file',
      mode: 0o644,
    }, content);
  }
  pack.finalize();

  const gzip = createGzip();
  const chunks: Buffer[] = [];
  pack.pipe(gzip);
  for await (const chunk of gzip) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

describe('File endpoint integration tests', () => {
  let app: TestAppHandle['app'];
  let container: TestAppHandle['container'];
  let testApp: TestAppHandle | undefined;
  let dataDir: string;
  let agentId: string;
  let workspaceDir: string;

  beforeEach(() => { allowConsoleErrors(); });

  beforeAll(async () => {
    testApp = await createTestApp({
      dirPrefix: 'file-test-',
    });
    app = testApp.app;
    container = testApp.container;
    dataDir = testApp.dataDir;

    // Create a test agent
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/agents',
      payload: {
        name: 'file-test-agent',
        harness: 'langgraph',
        harnessConfig: { provider: 'openai', model: 'gpt-5.4-mini' },
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
    await testApp?.close();
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
    expect(body.sizeBytes).toBeGreaterThan(0);
  });

  it('reads exact hidden diagnostics files from the conversation workspace', async () => {
    const conversation = await container.db.createConversation(agentId);

    mkdirSync(join(workspaceDir, '.claude'), { recursive: true });
    writeFileSync(join(workspaceDir, '.claude', 'settings.json'), '{"source":"base"}');

    const conversationWorkspaceDir = getConversationWorkspacePath(dataDir, agentId, conversation.id);
    mkdirSync(join(conversationWorkspaceDir, '.claude'), { recursive: true });
    writeFileSync(join(conversationWorkspaceDir, '.claude', 'settings.json'), '{"source":"conversation"}');
    writeFileSync(join(conversationWorkspaceDir, '.hook-trace.log'), 'hook trace from conversation');

    const settingsRes = await app.inject({
      method: 'GET',
      url: `/api/agents/${agentId}/files/read?path=${encodeURIComponent('.claude/settings.json')}&conversationId=${conversation.id}`,
    });
    expect(settingsRes.statusCode).toBe(200);
    expect(settingsRes.json().content).toBe('{"source":"conversation"}');

    const traceRes = await app.inject({
      method: 'GET',
      url: `/api/agents/${agentId}/files/read?path=${encodeURIComponent('.hook-trace.log')}&conversationId=${conversation.id}`,
    });
    expect(traceRes.statusCode).toBe(200);
    expect(traceRes.json().content).toBe('hook trace from conversation');
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

  it('returns 404 without internal path details for nonexistent file', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/agents/${agentId}/files/read?path=nonexistent.txt`,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'File not found' });
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

  // ── 404 Test ──

  it('returns 404 for non-existent agent', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/agents/00000000-0000-0000-0000-000000000000/files',
    });

    expect(res.statusCode).toBe(404);
  });

  it('persists and reads back a deterministic workspace revision', async () => {
    const archive = await createWorkspaceArchive({
      'AGENTS.md': '# Workspace contract',
      'bin/pilot': '#!/bin/sh\necho pilot\n',
    });

    const upload = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/workspace`,
      headers: { 'content-type': 'application/gzip' },
      payload: archive,
    });

    expect(upload.statusCode).toBe(201);
    expect(upload.json()).toMatchObject({
      revision: 1,
      fileCount: 2,
      totalBytes: 41,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      appliedAt: expect.any(Number),
    });

    const readback = await app.inject({
      method: 'GET',
      url: `/api/agents/${agentId}/workspace`,
    });
    expect(readback.statusCode).toBe(200);
    expect(readback.json()).toEqual(upload.json());

    const repeat = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/workspace`,
      headers: { 'content-type': 'application/gzip' },
      payload: archive,
    });
    expect(repeat.statusCode).toBe(201);
    expect(repeat.json()).toMatchObject({
      revision: 2,
      sha256: upload.json().sha256,
    });
  });

  it('rolls the workspace back when revision persistence fails', async () => {
    const baseline = await createWorkspaceArchive({
      'deployment.txt': 'stable workspace',
    });
    const baselineUpload = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/workspace`,
      headers: { 'content-type': 'application/gzip' },
      payload: baseline,
    });
    expect(baselineUpload.statusCode, baselineUpload.body).toBe(201);

    const revisionSpy = vi.spyOn(container.db, 'recordAgentWorkspaceRevision')
      .mockRejectedValueOnce(new Error('revision store unavailable'));
    const replacement = await createWorkspaceArchive({
      'deployment.txt': 'partial replacement must not survive',
    });
    const failedUpload = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/workspace`,
      headers: { 'content-type': 'application/gzip' },
      payload: replacement,
    });

    expect(failedUpload.statusCode).toBeGreaterThanOrEqual(400);
    expect(revisionSpy).toHaveBeenCalledTimes(1);
    const readback = await app.inject({
      method: 'GET',
      url: `/api/agents/${agentId}/files/read?path=deployment.txt`,
    });
    expect(readback.statusCode, readback.body).toBe(200);
    expect(readback.json().content).toBe('stable workspace');
  });
});
