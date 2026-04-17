import { test, expect, type APIRequestContext } from '@playwright/test';
import fs from 'fs';
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'yaml';
import { API_BASE } from './support';

/**
 * E2E tests for the Kitchen Sink multi-agent chaining demo.
 *
 * Pre-requisite: Docker stack running with the UI on localhost:3200.
 *
 * Test flow:
 *  1. Seed all 3 kitchen-sink agents via the manifest import API
 *  2. Verify all agents appear on the dashboard
 *  3. Verify each agent shows its harness type
 *  4. Send a message to the langgraph analyst to start the chain
 *  5. Verify events flow through the chain
 */

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const RUN_SUFFIX = `${Date.now()}`;

const AGENT_DIRS = [
  'claude-agent',
  'langgraph-agent',
  'pi-agent',
];

const EXPECTED_AGENTS = [
  {
    dir: 'langgraph-agent',
    harness: 'langgraph',
  },
  {
    dir: 'claude-agent',
    harness: 'claude-agents',
  },
  {
    dir: 'pi-agent',
    harness: 'pi-agent',
  },
];

// Chain event types in order
const CHAIN_EVENTS = [
  'analysis.complete',
  'report.ready',
];

// ── Helpers ──────────────────────────────────────────────────

interface AgentInfo {
  id: string;
  name: string;
  displayName?: string;
  harness?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Seed all kitchen-sink agents via POST /api/agents.
 * Parses each agent.yaml manifest and converts to the JSON create payload.
 * Returns a map of directory name -> agent ID.
 */
async function seedAgents(
  request: APIRequestContext,
): Promise<Record<string, string>> {
  const agentsRoot = path.resolve(
    TEST_DIR,
    '../../packages/examples/kitchen-sink/agents',
  );
  const created: Record<string, string> = {};

  for (const dir of AGENT_DIRS) {
    const manifestPath = path.join(agentsRoot, dir, 'agent.yaml');
    if (!fs.existsSync(manifestPath)) continue;

    const raw = yaml.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const meta = raw?.metadata ?? {};
    const spec = raw?.spec ?? {};
    const suffix = `${dir}-${RUN_SUFFIX}`;

    const res = await request.post(`${API_BASE}/api/agents`, {
      data: {
        name: `${meta.name}-${suffix}`,
        harness: spec.harness,
        harnessConfig: spec.harnessConfig ?? {},
        systemPrompt: spec.instructions ?? '',
        tools: (spec.tools ?? []).map((t: { ref?: string }) => t.ref).filter(Boolean),
        description: meta.description ?? null,
      },
    });
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    const agentId = data.id ?? data.agentId;
    if (agentId) {
      created[dir] = agentId;
    }
  }

  return created;
}

/**
 * Register a single event trigger.
 */
async function registerTrigger(
  request: any,
  agentId: string,
  eventType: string,
  taskTemplate: string,
): Promise<void> {
  const existingRes = await request.get(`${API_BASE}/api/triggers?agentId=${agentId}`);
  expect(existingRes.ok()).toBeTruthy();
  const existing = (await existingRes.json()) as Array<{
    eventType: string;
    taskTemplate: string;
  }>;

  if (
    existing.some(
      (trigger) =>
        trigger.eventType === eventType &&
        trigger.taskTemplate === taskTemplate,
    )
  ) {
    return;
  }

  const res = await request.post(`${API_BASE}/api/triggers`, {
    data: { agentId, eventType, taskTemplate, enabled: true },
  });
  // 201 = created, or it may already exist
  expect(res.status()).toBeLessThan(500);
}

async function getAgent(
  request: any,
  agentId: string,
): Promise<AgentInfo> {
  const res = await request.get(`${API_BASE}/api/agents/${agentId}`);
  expect(res.ok()).toBeTruthy();
  return (await res.json()) as AgentInfo;
}

async function getRuns(
  request: any,
  agentId: string,
): Promise<Array<{ id: string; taskDescription?: string }>> {
  const res = await request.get(`${API_BASE}/api/agents/${agentId}/sessions`);
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as {
    sessions?: Array<{ id: string; taskDescription?: string }>;
  } | Array<{ id: string; taskDescription?: string }>;
  return Array.isArray(body) ? body : (body.sessions ?? []);
}

// ── Tests ────────────────────────────────────────────────────

test.describe('Kitchen Sink — Multi-Agent Chain', () => {
  let importedAgents: Record<string, string> = {};
  const seededAgents: Record<string, AgentInfo> = {};

  test.beforeAll(async ({ request }) => {
    // Seed all agents
    importedAgents = await seedAgents(request);
    for (const [dir, agentId] of Object.entries(importedAgents)) {
      seededAgents[dir] = await getAgent(request, agentId);
    }

    // Register chain triggers
     const claudeId = importedAgents['claude-agent'];
     const piId = importedAgents['pi-agent'];

     if (claudeId) {
       await registerTrigger(
         request,
         claudeId,
         'analysis.complete',
         'Write a report from: Analysis: {{payload.analysis}}',
       );
     }
     if (piId) {
      for (const evt of CHAIN_EVENTS) {
        await registerTrigger(
          request,
          piId,
          evt,
          `Audit: Event "${evt}" received. Payload: {{payload}}`,
        );
      }
    }
  });

  test.afterAll(async ({ request }) => {
    for (const agentId of Object.values(importedAgents)) {
      await request.delete(`${API_BASE}/api/agents/${agentId}`);
    }
  });

  // ── 1. Dashboard shows all 3 agents ────────────────────────

  test('dashboard displays all 3 kitchen-sink agents', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Wait for agent cards to render
    const agentCards = page.getByTestId('agent-card');
    await expect(agentCards.first()).toBeVisible({ timeout: 15_000 });

    // Verify at least 3 agents are listed
    const count = await agentCards.count();
    expect(count).toBeGreaterThanOrEqual(EXPECTED_AGENTS.length);

    // Verify each expected agent name appears somewhere on the page
    for (const agent of Object.values(seededAgents)) {
      await expect(
        page.getByText(agent.name, { exact: false }),
      ).toBeVisible({ timeout: 5_000 });
    }
  });

  // ── 2. Each agent detail page shows correct harness ────────

  test('each agent detail page shows harness type', async ({ page }) => {
    for (const expected of EXPECTED_AGENTS) {
      const agent = seededAgents[expected.dir];
      expect(agent, `missing seeded agent for ${expected.dir}`).toBeTruthy();

      await page.goto(`/agents/${agent.id}`);
      await page.waitForLoadState('networkidle');
      await page.getByRole('button', { name: 'Configuration' }).click();
      await expect(page.getByText('Exact Config')).toBeVisible();
      await expect(
        page.locator('div').filter({ has: page.getByText('Harness') }).first(),
      ).toContainText(expected.harness);
      await expect(page.getByTestId('agent-name')).toContainText(agent.name);
    }
  });

  // ── 3. Send a message to the analyst to start the chain ────

  test('can send a message to the langgraph analyst', async ({ page, request }) => {
    const analyst = seededAgents['langgraph-agent'];
    expect(analyst).toBeTruthy();

    // Navigate to chat
    await page.goto(`/agents/${analyst!.id}/sessions/new`);
    await expect(page.getByTestId('session-input')).toBeVisible({ timeout: 15_000 });

    // Send a message that triggers analysis
    const chatInput = page.getByTestId('session-input');
    const userPrompt = 'What is 42 * 17? Analyze this calculation and emit your findings.';
    const startedAt = Date.now();
    const responsePromise = page.waitForResponse((response) =>
      response.request().method() === 'POST' &&
      response.url().includes(`/api/agents/${analyst!.id}/message`) &&
      response.status() === 201,
    );

    await chatInput.fill(userPrompt);
    await chatInput.press('Enter');

    // Wait for the user message to appear
    await expect(page.getByTestId('message-bubble-user').last()).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.getByTestId('message-bubble-user').last()).toContainText(userPrompt);

    const response = await responsePromise;
    const body = (await response.json()) as {
      messageId: string;
      conversationId: string;
      sessionId: string;
    };
    expect(body.messageId).toBeTruthy();
    expect(body.conversationId).toBeTruthy();
    expect(body.sessionId).toBeTruthy();

    await expect
      .poll(
        async () => {
          const res = await request.get(
            `${API_BASE}/api/agents/${analyst!.id}/conversations/${body.conversationId}/messages`,
          );
          expect(res.ok()).toBeTruthy();
          const messages = await res.json();
          return messages.some(
            (message: { role: string; content: string }) =>
              message.role === 'user' && message.content === userPrompt,
          );
        },
        { timeout: 30_000 },
      )
      .toBe(true);

    await expect
      .poll(
        async () => {
          const res = await request.get(
            `${API_BASE}/api/agents/${analyst!.id}/sessions/${body.sessionId}`,
          );
          return res.ok();
        },
        { timeout: 30_000 },
      )
      .toBe(true);
  });

  // ── 4. Verify custom chain events trigger downstream runs ─

  test('custom chain events are persisted and trigger downstream writer runs', async ({
    request,
  }) => {
    const analyst = seededAgents['langgraph-agent'];
    const reviewer = seededAgents['claude-agent'];
    expect(analyst).toBeTruthy();
    expect(reviewer).toBeTruthy();

    const beforeRuns = await getRuns(request, reviewer!.id);
    const emittedAnalysis = `kitchen-sink-analysis-${Date.now()}`;
    const emitRes = await request.post(`${API_BASE}/api/triggers/emit`, {
      data: {
        type: 'analysis.complete',
        agentId: analyst!.id,
        payload: { analysis: emittedAnalysis },
      },
    });
    expect(emitRes.ok()).toBeTruthy();

    await expect
      .poll(
        async () => {
          const reviewerRuns = await getRuns(request, reviewer!.id);
          if (reviewerRuns.length <= beforeRuns.length) return false;
          return reviewerRuns.some((run) =>
            run.taskDescription?.includes(emittedAnalysis) ?? false,
          );
        },
        { timeout: 30_000 },
      )
      .toBe(true);

    const reviewerRuns = await getRuns(request, reviewer!.id);
    const matchingRun = reviewerRuns.find((run) =>
      run.taskDescription?.includes(emittedAnalysis) ?? false,
    );
    expect(matchingRun).toBeTruthy();
    if (matchingRun) {
      const detailRes = await request.get(`${API_BASE}/api/agents/${reviewer!.id}/sessions/${matchingRun.id}`);
      expect(detailRes.ok()).toBeTruthy();
    }
  });

  // ── 5. Triggers are registered correctly ───────────────────

  test('triggers API shows registered chain triggers', async ({ request }) => {
    const res = await request.get(`${API_BASE}/api/triggers`);
    expect(res.ok()).toBeTruthy();
    const triggers = await res.json();
    expect(Array.isArray(triggers)).toBeTruthy();

    // Should have triggers for at least the main chain events
    const triggerEventTypes = triggers.map((t: { eventType: string }) => t.eventType);
    expect(triggerEventTypes).toContain('analysis.complete');
    expect(triggerEventTypes).toContain('report.ready');
  });
});
