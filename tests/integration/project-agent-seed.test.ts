import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { seedProjectAgents } from '../../packages/stablehand/src/agent/project-seed.js';
import { createTestApp, type TestAppHandle } from '../utils/test-app.js';
import { createTestDb } from '../utils/test-db.js';

/**
 * ctx-dxxa: agents declared in the project's agents/ directory are seeded
 * once. Deleting one through the API must survive an orchestrator restart,
 * and creating one with the same name through the API must still work.
 *
 * A "restart" here closes the whole app (container and server) and builds a
 * new one against the same database, then runs the boot seeding again, as
 * `stablehand dev` does on every start.
 */

interface ListedAgent {
  id: string;
  name: string;
}

async function writeManifest(agentsDir: string, name: string): Promise<void> {
  const dir = join(agentsDir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'agent.yaml'), `
apiVersion: stablehand.io/v1
kind: Agent
metadata:
  name: ${name}
  description: Declared in agents/ for the seed-once test
spec:
  harness: langgraph
  harnessConfig:
    provider: openai
    model: gpt-5.4-mini
  instructions: You are a seed-once test agent.
`, 'utf8');
}

describe('project agent seeding (seed-once)', () => {
  let testApp: TestAppHandle | undefined;
  let projectDir: string;
  let agentsDir: string;

  // createTestApp suites share the database without resetting it; start from
  // an empty one so leftover agents and seed records cannot leak in or out.
  async function resetDatabase(): Promise<void> {
    const reset = await createTestDb();
    await reset.close();
  }

  async function startApp(): Promise<TestAppHandle> {
    testApp = await createTestApp({ dirPrefix: 'stablehand-project-agent-seed-' });
    return testApp;
  }

  async function restart(): Promise<TestAppHandle> {
    await testApp?.close();
    testApp = undefined;
    return startApp();
  }

  async function listAgents(app: TestAppHandle): Promise<ListedAgent[]> {
    const res = await app.app.inject({ method: 'GET', url: '/api/agents' });
    expect(res.statusCode).toBe(200);
    return res.json() as ListedAgent[];
  }

  async function agentsNamed(app: TestAppHandle, name: string): Promise<ListedAgent[]> {
    return (await listAgents(app)).filter((agent) => agent.name === name);
  }

  async function deleteAgent(app: TestAppHandle, id: string): Promise<void> {
    const res = await app.app.inject({ method: 'DELETE', url: `/api/agents/${id}` });
    expect(res.statusCode).toBe(204);
  }

  beforeAll(async () => {
    await resetDatabase();
  });

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'stablehand-project-'));
    agentsDir = join(projectDir, 'agents');
    await writeManifest(agentsDir, 'seeded-analyst');
    await writeManifest(agentsDir, 'seeded-writer');
    await startApp();
  });

  afterEach(async () => {
    await testApp?.close();
    testApp = undefined;
    await rm(projectDir, { recursive: true, force: true });
    await resetDatabase();
  });

  afterAll(async () => {
    await resetDatabase();
  });

  it('keeps a deleted agent deleted across restarts and lets the API create it again', async () => {
    let app = testApp!;
    const first = await seedProjectAgents(app.container.db, agentsDir);
    expect(first.created.sort()).toEqual(['seeded-analyst', 'seeded-writer']);
    const [analyst] = await agentsNamed(app, 'seeded-analyst');
    expect(analyst).toBeDefined();

    await deleteAgent(app, analyst!.id);

    app = await restart();
    const second = await seedProjectAgents(app.container.db, agentsDir);
    expect(second.created).toEqual([]);
    expect(second.alreadySeeded.sort()).toEqual(['seeded-analyst', 'seeded-writer']);
    expect(await agentsNamed(app, 'seeded-analyst')).toEqual([]);
    // The agent nobody deleted is still there, once.
    expect(await agentsNamed(app, 'seeded-writer')).toHaveLength(1);

    const recreate = await app.app.inject({
      method: 'POST',
      url: '/api/agents',
      payload: {
        name: 'seeded-analyst',
        harness: 'langgraph',
        harnessConfig: { provider: 'openai', model: 'gpt-5.4-mini' },
        systemPrompt: 'Created again through the API.',
        tools: [],
      },
    });
    expect(recreate.statusCode).toBe(201);
    const recreatedId = (recreate.json() as ListedAgent).id;

    // Later starts neither duplicate nor replace the agent the API created.
    app = await restart();
    await seedProjectAgents(app.container.db, agentsDir);
    const afterRecreate = await agentsNamed(app, 'seeded-analyst');
    expect(afterRecreate.map((agent) => agent.id)).toEqual([recreatedId]);

    // Deleting it again sticks too.
    await deleteAgent(app, recreatedId);
    app = await restart();
    await seedProjectAgents(app.container.db, agentsDir);
    expect(await agentsNamed(app, 'seeded-analyst')).toEqual([]);
  });

  it('adopts an agent that existed before the first seeded start, then lets it stay deleted', async () => {
    let app = testApp!;
    const existing = await app.app.inject({
      method: 'POST',
      url: '/api/agents',
      payload: {
        name: 'seeded-writer',
        harness: 'langgraph',
        harnessConfig: { provider: 'openai', model: 'gpt-5.4-mini' },
        systemPrompt: 'Registered by an older orchestrator.',
        tools: [],
      },
    });
    expect(existing.statusCode).toBe(201);
    const existingId = (existing.json() as ListedAgent).id;

    const first = await seedProjectAgents(app.container.db, agentsDir);
    expect(first.created).toEqual(['seeded-analyst']);
    expect(first.adopted).toEqual(['seeded-writer']);
    expect((await agentsNamed(app, 'seeded-writer')).map((agent) => agent.id)).toEqual([existingId]);

    await deleteAgent(app, existingId);
    app = await restart();
    await seedProjectAgents(app.container.db, agentsDir);
    expect(await agentsNamed(app, 'seeded-writer')).toEqual([]);
  });

  it('seeds an agent added to agents/ after the first start', async () => {
    let app = testApp!;
    await seedProjectAgents(app.container.db, agentsDir);

    await writeManifest(agentsDir, 'seeded-auditor');
    app = await restart();
    const second = await seedProjectAgents(app.container.db, agentsDir);
    expect(second.created).toEqual(['seeded-auditor']);
    expect(await agentsNamed(app, 'seeded-auditor')).toHaveLength(1);
  });
});
