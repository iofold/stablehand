import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { allowConsoleErrors } from '../setup-strict.js';
import {
  mkdtempSync, mkdirSync, writeFileSync, existsSync,
  readFileSync, rmSync, readdirSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';

import { createContainer } from '../../packages/ctxmill/src/config/container.js';
import { createServer } from '../../packages/ctxmill/src/orchestrator/server.js';
import type { AppContainer } from '../../packages/ctxmill/src/config/container.js';
import { MockOverlayFactory } from '../../packages/ctxmill/src/workspace/mock-overlay.js';

/**
 * Full session lifecycle E2E test:
 *   create agent → start run → write files → diff → promote → verify
 *   create agent → start run → write files → discard → verify nothing changed
 *   create agent → start run → write files → fork → verify new agent has files
 */
describe('Session lifecycle (full flow)', () => {
  let app: FastifyInstance;
  let container: AppContainer;
  let dataDir: string;
  const envFactory = new MockOverlayFactory();

  beforeEach(() => { allowConsoleErrors(); });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'ctxmill-lifecycle-'));

    container = await createContainer(
      {
        preset: 'local',
        database: { type: 'sqlite', path: 'data.db' },
        llm: {
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
          apiKey: 'test-key-not-used',
        },
      },
      dataDir,
    );

    app = await createServer({
      db: container.db,
      executor: container.agentExecutor,
      runRegistry: container.runRegistry,
      eventBus: container.eventBus,
      dataDir,
      envFactory,
    });

    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /**
   * Helper: create an agent via HTTP, return its id and workspace path.
   */
  async function createAgent(name: string) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agents',
      payload: {
        name,
        model: 'test-model',
        systemPrompt: 'Lifecycle test agent',
        tools: [],
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    const agent = await container.db.getAgent(body.id);
    return { id: body.id, workspaceDir: agent!.workspaceDir! };
  }

  /**
   * Helper: create a run with session files.
   */
  async function createRunWithSession(
    agentId: string,
    workspaceDir: string,
    files: Record<string, string>,
    baseFiles?: Record<string, string>,
  ) {
    const sessionsDir = resolve(join(workspaceDir, '..', '..', 'sessions'));
    mkdirSync(sessionsDir, { recursive: true });

    // Write base files if provided
    if (baseFiles) {
      for (const [name, content] of Object.entries(baseFiles)) {
        writeFileSync(join(workspaceDir, name), content);
      }
    }

    const run = await container.runRegistry.startRun(
      agentId, `conv-${Date.now()}`, 'background', 'lifecycle test',
    );

    const env = envFactory.create(workspaceDir, run.id, sessionsDir);
    await env.setup();

    // Write session files
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(env.workspacePath, name), content);
    }

    await container.runRegistry.updateSessionDir(run.id, join(sessionsDir, run.id));
    return { runId: run.id, env };
  }

  it('full promote flow: create → run → diff → promote → verify base updated', async () => {
    const { id: agentId, workspaceDir } = await createAgent('promote-flow-agent');

    // Write a base file
    writeFileSync(join(workspaceDir, 'readme.txt'), 'original readme');

    // Create run with session changes
    const { runId } = await createRunWithSession(
      agentId,
      workspaceDir,
      {
        'new-feature.ts': 'export const feature = true;',
        'readme.txt': 'updated readme with feature docs',
      },
    );

    // Step 1: Diff — should show both added and modified
    const diffRes = await app.inject({
      method: 'GET',
      url: `/api/agents/${agentId}/runs/${runId}/diff`,
    });
    expect(diffRes.statusCode).toBe(200);
    const diffBody = diffRes.json();
    expect(diffBody.changes.length).toBeGreaterThanOrEqual(1);

    const added = diffBody.changes.find((c: any) => c.path === 'new-feature.ts');
    const modified = diffBody.changes.find((c: any) => c.path === 'readme.txt');
    expect(added).toBeDefined();
    expect(added.type).toBe('added');
    expect(modified).toBeDefined();
    expect(modified.type).toBe('modified');

    // Step 2: Promote
    const promoteRes = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/runs/${runId}/promote`,
    });
    expect(promoteRes.statusCode).toBe(200);
    const promoteBody = promoteRes.json();
    expect(promoteBody.added).toBeGreaterThanOrEqual(1);

    // Step 3: Verify base has the promoted files
    expect(existsSync(join(workspaceDir, 'new-feature.ts'))).toBe(true);
    expect(readFileSync(join(workspaceDir, 'new-feature.ts'), 'utf-8')).toBe(
      'export const feature = true;',
    );
    expect(readFileSync(join(workspaceDir, 'readme.txt'), 'utf-8')).toBe(
      'updated readme with feature docs',
    );
  });

  it('full discard flow: create → run → write → discard → verify base unchanged', async () => {
    const { id: agentId, workspaceDir } = await createAgent('discard-flow-agent');

    // Write a base file
    writeFileSync(join(workspaceDir, 'config.json'), '{"version": 1}');

    // Create run with session changes
    const { runId } = await createRunWithSession(
      agentId,
      workspaceDir,
      {
        'temp-file.txt': 'this should be discarded',
        'config.json': '{"version": 2, "broken": true}',
      },
    );

    // Discard the session
    const discardRes = await app.inject({
      method: 'DELETE',
      url: `/api/agents/${agentId}/runs/${runId}/session`,
    });
    expect(discardRes.statusCode).toBe(200);
    expect(discardRes.json().discarded).toBe(true);

    // Verify base is unchanged
    expect(existsSync(join(workspaceDir, 'temp-file.txt'))).toBe(false);
    expect(readFileSync(join(workspaceDir, 'config.json'), 'utf-8')).toBe('{"version": 1}');
  });

  it('full fork flow: create → run → write → fork → verify new agent has session state', async () => {
    const { id: agentId, workspaceDir } = await createAgent('fork-source-agent');

    // Write base + session files
    writeFileSync(join(workspaceDir, 'shared.txt'), 'shared content');

    const { runId } = await createRunWithSession(
      agentId,
      workspaceDir,
      {
        'forked-feature.ts': 'export const forked = true;',
        'shared.txt': 'shared content with session additions',
      },
    );

    // Fork into a new agent
    const forkRes = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/runs/${runId}/fork`,
      payload: { name: 'forked-agent' },
    });
    expect(forkRes.statusCode).toBe(201);
    const forkBody = forkRes.json();
    expect(forkBody.agentId).toBeDefined();
    expect(forkBody.name).toBe('forked-agent');

    // Verify the new agent exists in DB
    const newAgent = await container.db.getAgent(forkBody.agentId);
    expect(newAgent).toBeDefined();
    expect(newAgent!.name).toBe('forked-agent');
  });

  it('diff after diff is idempotent', async () => {
    const { id: agentId, workspaceDir } = await createAgent('idempotent-diff-agent');

    const { runId } = await createRunWithSession(
      agentId,
      workspaceDir,
      { 'file.txt': 'content' },
    );

    // Call diff twice
    const diff1 = await app.inject({
      method: 'GET',
      url: `/api/agents/${agentId}/runs/${runId}/diff`,
    });
    const diff2 = await app.inject({
      method: 'GET',
      url: `/api/agents/${agentId}/runs/${runId}/diff`,
    });

    expect(diff1.statusCode).toBe(200);
    expect(diff2.statusCode).toBe(200);
    expect(diff1.json()).toEqual(diff2.json());
  });

  it('returns 404 for operations on non-existent agent', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/agents/nonexistent-id/runs/some-run/diff',
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for operations on non-existent run', async () => {
    const { id: agentId } = await createAgent('missing-run-agent');

    const res = await app.inject({
      method: 'GET',
      url: `/api/agents/${agentId}/runs/nonexistent-run/diff`,
    });
    expect(res.statusCode).toBe(404);
  });
});
