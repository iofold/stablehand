import { execFile } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { PreparedTurnStart } from '../../packages/stablehand/src/orchestrator/turn-startup-service.js';
import { TurnFinalizer } from '../../packages/stablehand/src/orchestrator/turn-finalizer.js';
import { createTestApp, type TestAppHandle } from '../utils/test-app.js';
import { createTestDb } from '../utils/test-db.js';

/**
 * ctx-krrn: the kitchen-sink example's flagship chain must work out of the
 * box. This suite seeds the shipped manifests and triggers with the real
 * seed script against a real orchestrator (Postgres, canonical spine, trigger
 * consumer, turn admission and dispatcher), and swaps only the sandbox
 * harness for a fake that records each admitted run and plays the writer's
 * part of the chain by emitting `report.ready`.
 */

const execFileAsync = promisify(execFile);
const SEED_PATH = fileURLToPath(new URL('../../packages/examples/kitchen-sink/seed.ts', import.meta.url));
const WORKSPACE_ROOT = fileURLToPath(new URL('../../', import.meta.url));

interface LaunchedRun {
  agentId: string;
  turnId: string;
  mode: PreparedTurnStart['mode'];
  taskDescription: string;
}

interface SeededAgent {
  id: string;
  name: string;
  mode: string | null;
}

interface SeededTrigger {
  id: string;
  agentId: string;
  eventType: string;
  taskTemplate: string;
  enabled: boolean;
}

describe('kitchen-sink event chain', () => {
  let testApp: TestAppHandle | undefined;
  const launches: LaunchedRun[] = [];

  // createTestApp suites share the database without resetting it; seed into
  // an empty one so leftover agents, triggers and queued turns cannot leak in
  // or out of this suite.
  async function resetDatabase(): Promise<void> {
    const reset = await createTestDb();
    await reset.close();
  }

  beforeAll(async () => {
    await resetDatabase();
    testApp = await createTestApp({ dirPrefix: 'stablehand-kitchen-sink-chain-' });
    await testApp.app.listen({ host: '127.0.0.1', port: 0 });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    try {
      await testApp?.close();
    } finally {
      await resetDatabase();
    }
  });

  it('seeds the shipped chain and admits the trigger-started runs on every target', async () => {
    if (!testApp) throw new Error('test app did not start');
    const { app, container } = testApp;
    const { port } = app.server.address() as AddressInfo;

    const runSeed = async (): Promise<string> => {
      const { stdout } = await execFileAsync(
        process.execPath,
        ['--experimental-strip-types', SEED_PATH],
        {
          cwd: WORKSPACE_ROOT,
          env: { ...process.env, API_URL: `http://127.0.0.1:${port}` },
          timeout: 60_000,
        },
      );
      return stdout;
    };
    expect(await runSeed()).toContain('Seed complete');
    // A second run is how an existing install picks up manifest changes: it
    // must update the seeded agents and reconcile triggers in place.
    expect(await runSeed()).toMatch(/updated[\s\S]*Seed complete/);

    const agentsRes = await app.inject({ method: 'GET', url: '/api/agents' });
    expect(agentsRes.statusCode).toBe(200);
    const agents = agentsRes.json() as SeededAgent[];
    const byName = (name: string): SeededAgent => {
      const agent = agents.find((candidate) => candidate.name === name);
      if (!agent) throw new Error(`seeded agent ${name} not found`);
      return agent;
    };
    const analyst = byName('langgraph-analyst');
    const writer = byName('claude-writer');
    const auditor = byName('pi-auditor');
    expect(writer.mode).toBe('both');
    expect(auditor.mode).toBe('both');

    const triggersRes = await app.inject({ method: 'GET', url: '/api/triggers' });
    expect(triggersRes.statusCode).toBe(200);
    const chainTriggers = (triggersRes.json() as SeededTrigger[])
      .filter((trigger) => trigger.agentId === writer.id || trigger.agentId === auditor.id);
    expect(chainTriggers.map((trigger) => `${trigger.agentId}:${trigger.eventType}:${trigger.enabled}`).sort())
      .toEqual([
        `${auditor.id}:analysis.complete:true`,
        `${auditor.id}:report.ready:true`,
        `${writer.id}:analysis.complete:true`,
      ].sort());

    // Fake harness: record each admitted run once, play the writer's emit,
    // then close the turn the way a finished sandbox turn would.
    const finalizer = new TurnFinalizer({ db: container.db, eventBus: container.eventBus });
    vi.spyOn(container.turnStartupService, 'launchPreparedTurn').mockImplementation(
      async (start, agentId, options) => {
        if (launches.some((launch) => launch.turnId === start.turnId)) return;
        launches.push({
          agentId,
          turnId: start.turnId,
          mode: start.mode,
          taskDescription: start.taskDescription,
        });
        if (agentId === writer.id) {
          await container.eventBus.emitCustomAsync('report.ready', writer.id, {
            report: 'Summary: revenue up 12%. Key Findings: margin stable. Recommendations: hold.',
            turnId: start.turnId,
            conversationId: start.conversationId,
            agentId: writer.id,
          });
        }
        await finalizer.finalize({
          turnId: start.turnId,
          agentId,
          conversationId: start.conversationId,
          status: 'completed',
        });
        options?.onSuccess?.();
      },
    );

    // The analyst's emit-event tool call, as the orchestrator tool handler makes
    // it. Models often send structured findings; the writer's
    // {{payload.analysis}} must render them as JSON, not [object Object]
    // (ctx-et0w).
    await container.eventBus.emitCustomAsync('analysis.complete', analyst.id, {
      analysis: {
        summary: 'Revenue grew 12% quarter over quarter; weather risk is low.',
        metrics: { revenueGrowthPct: 12, weatherRisk: 'low' },
      },
      agentId: analyst.id,
    });

    await vi.waitFor(() => {
      expect(launches.filter((launch) => launch.agentId === writer.id)).toHaveLength(1);
      expect(launches.filter((launch) => launch.agentId === auditor.id)).toHaveLength(2);
    }, { timeout: 15_000, interval: 50 });

    expect(launches.every((launch) => launch.mode === 'background')).toBe(true);
    expect(launches.find((launch) => launch.agentId === writer.id)?.taskDescription).toBe(
      'Write a polished final report based on this analysis:\n\n'
      + '{"summary":"Revenue grew 12% quarter over quarter; weather risk is low.",'
      + '"metrics":{"revenueGrowthPct":12,"weatherRisk":"low"}}',
    );
    const auditTasks = launches
      .filter((launch) => launch.agentId === auditor.id)
      .map((launch) => launch.taskDescription);
    expect(auditTasks).toEqual(expect.arrayContaining([
      expect.stringContaining('Audit log entry: Event "analysis.complete" received. Payload: {'),
      expect.stringContaining('Audit log entry: Event "report.ready" received. Payload: {'),
    ]));

    for (const agentId of [writer.id, auditor.id]) {
      const turnsRes = await app.inject({ method: 'GET', url: `/api/agents/${agentId}/turns` });
      expect(turnsRes.statusCode).toBe(200);
      const turns = (turnsRes.json() as { turns: Array<{ id: string; mode: string; status: string }> }).turns;
      const launched = launches.filter((launch) => launch.agentId === agentId).map((launch) => launch.turnId);
      expect(turns.map((turn) => turn.id).sort()).toEqual([...launched].sort());
      expect(new Set(turns.map((turn) => `${turn.mode}:${turn.status}`))).toEqual(new Set(['background:COMPLETED']));
    }

    for (const trigger of chainTriggers) {
      const eventsRes = await app.inject({
        method: 'GET',
        url: `/api/events?type=${encodeURIComponent(trigger.eventType)}`,
      });
      const [event] = (eventsRes.json() as { events: Array<{ seq: number | string }> }).events;
      expect(event, `${trigger.eventType} persisted`).toBeDefined();
      expect(await container.db.hasTriggerFiring(trigger.id, Number(event?.seq))).toBe(true);
    }
  }, 90_000);
});
