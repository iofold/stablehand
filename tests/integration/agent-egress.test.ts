import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { allowConsoleErrors } from '../setup-strict.js';

import { AgentSchema } from '@stablehand/contracts';
import { createTestApp, type TestAppHandle } from '../utils/test-app.js';
import { mintEgressLeaseToken } from '../../packages/stablehand/src/orchestrator/egress-lease.js';

const AGENT = {
  harness: 'langgraph',
  harnessConfig: { provider: 'openai', model: 'gpt-5.4-mini' },
  systemPrompt: 'Fix the failing test.',
  tools: [],
};

function manifest(name: string, egress?: Record<string, unknown>): Record<string, unknown> {
  return {
    apiVersion: 'stablehand.io/v1',
    kind: 'Agent',
    metadata: { name },
    spec: {
      harness: AGENT.harness,
      harnessConfig: AGENT.harnessConfig,
      instructions: AGENT.systemPrompt,
      ...(egress ? { egress } : {}),
    },
  };
}

describe('Agent egress setting and sandbox egress leases (ctx-3aef)', () => {
  let app: TestAppHandle['app'];
  let container: TestAppHandle['container'];
  let testApp: TestAppHandle | undefined;

  beforeEach(() => { allowConsoleErrors(); });

  beforeAll(async () => {
    testApp = await createTestApp({ dirPrefix: 'stablehand-agent-egress-' });
    app = testApp.app;
    container = testApp.container;
  });

  afterAll(async () => {
    await testApp?.close();
  });

  async function createAgent(payload: Record<string, unknown>) {
    return app.inject({ method: 'POST', url: '/api/agents', payload: { ...AGENT, ...payload } });
  }

  async function checkLease(sessionId: string, token: string) {
    return app.inject({ method: 'POST', url: '/api/egress/lease', payload: { sessionId, token } });
  }

  it('creates, reads, updates and clears an agent egress setting', async () => {
    const created = await createAgent({ name: 'egress-solver', egress: { mode: 'deny' } });
    expect(created.statusCode, created.body).toBe(201);
    const agent = AgentSchema.parse(created.json());
    expect(agent.egress).toEqual({ mode: 'deny' });
    expect(agent.metadata).toBeNull();

    const read = await app.inject({ method: 'GET', url: `/api/agents/${agent.id}` });
    expect(read.json().egress).toEqual({ mode: 'deny' });

    const allowed = await app.inject({
      method: 'PATCH',
      url: `/api/agents/${agent.id}`,
      payload: { egress: { mode: 'allow', rules: ['GET *', 'HEAD *'] } },
    });
    expect(allowed.statusCode, allowed.body).toBe(200);
    expect(allowed.json().egress).toEqual({ mode: 'allow', rules: ['GET *', 'HEAD *'] });

    const unrelated = await app.inject({
      method: 'PATCH',
      url: `/api/agents/${agent.id}`,
      payload: { description: 'still allowed' },
    });
    expect(unrelated.json().egress).toEqual({ mode: 'allow', rules: ['GET *', 'HEAD *'] });

    const cleared = await app.inject({ method: 'PATCH', url: `/api/agents/${agent.id}`, payload: { egress: null } });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().egress).toBeNull();
  });

  it('rejects invalid egress settings and the reserved metadata key', async () => {
    for (const egress of [
      { mode: 'allow' },
      { mode: 'default', rules: ['GET *'] },
      { mode: 'deny', rules: ['* * !internal'] },
      { mode: 'deny', rules: ['GET http://example.com/'] },
      { mode: 'wide-open' },
    ]) {
      const res = await createAgent({ name: `egress-invalid-${Math.random().toString(36).slice(2, 8)}`, egress });
      expect(res.statusCode, JSON.stringify(egress)).toBe(400);
      expect(res.json().code).toBe('invalid_agent_definition');
      expect(JSON.stringify(res.json().issues)).toContain('egress');
    }
    const reserved = await createAgent({ name: 'egress-reserved', metadata: { egress: { mode: 'deny' } } });
    expect(reserved.statusCode).toBe(400);
    expect(reserved.json().error).toMatch(/metadata\.egress is reserved/);
  });

  it('takes egress from the manifest and edits it only through the manifest', async () => {
    const created = await createAgent({
      name: 'egress-manifest',
      egress: { mode: 'deny', rules: ['GET pypi.org/simple/**'] },
      manifest: manifest('egress-manifest', { mode: 'deny', rules: ['GET pypi.org/simple/**'] }),
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id as string;
    expect(created.json().egress).toEqual({ mode: 'deny', rules: ['GET pypi.org/simple/**'] });

    const conflicting = await createAgent({
      name: 'egress-manifest-conflict',
      egress: { mode: 'allow', rules: ['GET *'] },
      manifest: manifest('egress-manifest-conflict', { mode: 'deny' }),
    });
    expect(conflicting.statusCode).toBe(400);
    expect(conflicting.json().details).toContain('egress');

    const direct = await app.inject({ method: 'PATCH', url: `/api/agents/${id}`, payload: { egress: { mode: 'deny' } } });
    expect(direct.statusCode).toBe(400);

    const replaced = await app.inject({
      method: 'PATCH',
      url: `/api/agents/${id}`,
      payload: { manifest: manifest('egress-manifest') },
    });
    expect(replaced.statusCode, replaced.body).toBe(200);
    expect(replaced.json().egress).toBeNull();
  });

  it('answers the egress proxy for a live session lease and refuses it once the session ends', async () => {
    const created = await createAgent({ name: 'egress-lease-agent', egress: { mode: 'deny' } });
    const agentId = created.json().id as string;
    const conversation = await container.db.createConversation(agentId);
    const session = await container.db.createSandboxSession({
      conversationId: conversation.id,
      agentId,
      harnessName: 'langgraph',
      status: 'ACTIVE',
      containerId: 'egress-test-container',
      containerName: 'egress-test-container',
    });
    const token = mintEgressLeaseToken(session.id, agentId);

    const live = await checkLease(session.id, token);
    expect(live.statusCode, live.body).toBe(200);
    expect(live.json()).toMatchObject({ sessionId: session.id, agentId, egress: { mode: 'deny' }, ttlSeconds: 30 });

    // A session that is still opening has no record yet; its signed lease is enough.
    const opening = await checkLease('opening-session', mintEgressLeaseToken('opening-session', agentId));
    expect(opening.statusCode).toBe(200);

    const otherAgent = await createAgent({ name: 'egress-lease-other' });
    const foreign = await checkLease(session.id, mintEgressLeaseToken(session.id, otherAgent.json().id as string));
    expect(foreign.statusCode).toBe(401);

    const forged = await checkLease(session.id, `${token.split('.')[0]}.forged`);
    expect([forged.statusCode, forged.json().code]).toEqual([401, 'invalid_lease']);

    const endedConversation = await container.db.createConversation(agentId);
    const endedSession = await container.db.createSandboxSession({
      conversationId: endedConversation.id,
      agentId,
      harnessName: 'langgraph',
      status: 'TERMINATED',
    });
    const ended = await checkLease(endedSession.id, mintEgressLeaseToken(endedSession.id, agentId));
    expect([ended.statusCode, ended.json().code]).toEqual([410, 'session_ended']);
  });
});
