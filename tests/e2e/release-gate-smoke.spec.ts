import { API_BASE, createTestAgent, deleteTestAgent } from './support';
import { assertNoUnexpectedTerminalErrorStates, expect, test } from './release-gate-fixtures';

test.describe('Required release gate smoke @smoke', () => {
  let agentId = '';
  let agentName = '';

  test.beforeAll(async ({ request }) => {
    const agent = await createTestAgent(request, {
      name: `release-gate-smoke-${Date.now()}`,
      description: 'Deterministic required release gate smoke agent',
    });
    agentId = agent.id;
    agentName = agent.name;
  });

  test.afterAll(async ({ request }) => {
    if (agentId) {
      await deleteTestAgent(request, agentId);
    }
  });

  test('API health, event persistence, and terminal-state gate are deterministic @smoke', async ({ request }) => {
    const health = await request.get(`${API_BASE}/api/health`);
    expect(health.ok()).toBe(true);
    await expect(health).toBeOK();

    const emittedAt = new Date().toISOString();
    const eventType = `release.gate.smoke.${Date.now()}`;
    const emit = await request.post(`${API_BASE}/api/triggers/emit`, {
      data: {
        type: eventType,
        payload: { source: 'release-gate-smoke', emittedAt },
      },
    });
    expect(emit.ok()).toBe(true);

    await expect
      .poll(
        async () => {
          const events = await request.get(`${API_BASE}/api/events?type=${encodeURIComponent(eventType)}&limit=10`);
          if (!events.ok()) return false;
          const body = (await events.json()) as { events?: Array<{ payload?: string }> };
          return body.events?.some((event) => (event.payload ?? '').includes(emittedAt)) ?? false;
        },
        { timeout: 15_000, message: `event ${eventType} is persisted and queryable` },
      )
      .toBe(true);

    const turns = await request.get(`${API_BASE}/api/agents/${agentId}/turns`);
    expect(turns.ok()).toBe(true);
    const turnsBody = (await turns.json()) as { turns?: Array<{ id?: string; status?: string; error?: unknown }> };
    await assertNoUnexpectedTerminalErrorStates(turnsBody.turns ?? []);
  });

  test('dashboard and agent files tab render without strict console errors @smoke', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });

    const agentCard = page.getByTestId('agent-card').filter({
      has: page.getByText(agentName, { exact: true }),
    });
    await expect(agentCard).toBeVisible({ timeout: 15_000 });

    await page.goto(`/agents/${agentId}`, { waitUntil: 'networkidle' });
    await expect(page.getByText(agentName, { exact: true })).toBeVisible();

    await page.getByTestId('files-tab').click();
    await expect(page.getByTestId('file-explorer')).toBeVisible();
  });
});
