import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { triggerConversationId } from '../../packages/stablehand/src/config/container.js';
import type { PreparedTurnStart } from '../../packages/stablehand/src/orchestrator/turn-startup-service.js';
import { TurnFinalizer } from '../../packages/stablehand/src/orchestrator/turn-finalizer.js';
import { createTestApp, type TestAppHandle } from '../utils/test-app.js';
import { createTestDb } from '../utils/test-db.js';

/**
 * The inbox agent example seeds against a real orchestrator (Postgres,
 * spine, trigger consumer, budgets, scoped keys, HTTP tools) and its sender
 * delivers the synthetic emails through POST /api/triggers/emit. Only the
 * sandbox harness is faked: each admitted run is recorded and finalized.
 * Replies in a thread must land in the conversation of their first email.
 */

const execFileAsync = promisify(execFile);
const EXAMPLE = fileURLToPath(new URL('../../packages/examples/inbox-agent/', import.meta.url));
const WORKSPACE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MASTER_TOKEN = 'inbox-agent-master-token';

interface LaunchedRun {
  turnId: string;
  conversationId: string;
  mode: PreparedTurnStart['mode'];
  task: string;
}

interface SeededAgent {
  id: string;
  name: string;
  mode: string | null;
  tools: string[];
  metadata: Record<string, unknown> | null;
  httpTools: Array<{ name: string; endpoint: string; requiresApproval?: boolean }>;
}

describe('inbox agent', () => {
  let testApp: TestAppHandle | undefined;
  let mailpit: Server | undefined;
  let mailpitUrl = '';
  let webhookKey = '';
  const sentMail: Array<Record<string, unknown>> = [];
  const launches: LaunchedRun[] = [];
  const previousEnv = {
    allowlist: process.env.STABLEHAND_EGRESS_ALLOWLIST,
    token: process.env.STABLEHAND_API_TOKEN,
  };

  function restore(name: string, value: string | undefined): void {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  async function resetDatabase(): Promise<void> {
    const reset = await createTestDb();
    await reset.close();
  }

  beforeAll(async () => {
    await resetDatabase();
    process.env.STABLEHAND_EGRESS_ALLOWLIST = '127.0.0.1';
    process.env.STABLEHAND_API_TOKEN = MASTER_TOKEN;
    // A stand-in for Mailpit's send API: records what the agent would send.
    mailpit = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      if (request.method === 'POST' && request.url === '/api/v1/send') {
        sentMail.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ ID: `mailpit-${sentMail.length}` }));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve) => mailpit!.listen(0, '127.0.0.1', resolve));
    mailpitUrl = `http://127.0.0.1:${(mailpit.address() as AddressInfo).port}`;
    testApp = await createTestApp({ dirPrefix: 'stablehand-inbox-agent-' });
    await testApp.app.listen({ host: '127.0.0.1', port: 0 });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    try {
      await testApp?.close();
      await new Promise<void>((resolve) => (mailpit ? mailpit.close(() => resolve()) : resolve()));
    } finally {
      restore('STABLEHAND_EGRESS_ALLOWLIST', previousEnv.allowlist);
      restore('STABLEHAND_API_TOKEN', previousEnv.token);
      await resetDatabase();
    }
  });

  function apiUrl(): string {
    const { port } = testApp!.app.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async function runScript(script: string, args: string[], env: Record<string, string>): Promise<string> {
    const childEnv: NodeJS.ProcessEnv = { ...process.env, API_URL: apiUrl(), ...env };
    delete childEnv.MAIL_PROVIDER;
    delete childEnv.MAIL_API_KEY;
    delete childEnv.INBOX_WEBHOOK_KEY;
    Object.assign(childEnv, env);
    const { stdout } = await execFileAsync(process.execPath, ['--experimental-strip-types', `${EXAMPLE}${script}`, ...args], {
      cwd: WORKSPACE_ROOT,
      env: childEnv,
      timeout: 90_000,
    });
    return stdout;
  }

  const inject = (method: 'GET' | 'POST', url: string, payload?: unknown) => testApp!.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${MASTER_TOKEN}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });

  async function inboxAgent(): Promise<SeededAgent> {
    const agents = (await inject('GET', '/api/agents')).json<SeededAgent[]>();
    const agent = agents.find((candidate) => candidate.name === 'inbox-agent');
    if (!agent) throw new Error('inbox-agent was not seeded');
    return agent;
  }

  it('seeds the agent, its send tool, the thread-keyed trigger, a budget and a key that can only deliver emails', async () => {
    const first = await runScript('seed.ts', [], { STABLEHAND_API_TOKEN: MASTER_TOKEN, MAILPIT_API: mailpitUrl });
    expect(first).toContain('created inbox-agent');
    expect(first).toContain(`send_email -> ${mailpitUrl}/api/v1/send, asks for approval on every call`);
    expect(first).toContain('custom.inbox.email -> inbox-agent, one conversation per {{payload.threadId}}');
    webhookKey = /^INBOX_WEBHOOK_KEY=(cmk_\S+)$/m.exec(first)?.[1] ?? '';
    expect(webhookKey).toMatch(/^cmk_/);

    const second = await runScript('seed.ts', [], { STABLEHAND_API_TOKEN: MASTER_TOKEN, MAILPIT_API: mailpitUrl });
    expect(second).toContain('updated inbox-agent');
    expect(second).toContain('inbox-webhook exists');
    expect(second).not.toContain('INBOX_WEBHOOK_KEY=');

    const agent = await inboxAgent();
    expect(agent.mode).toBe('both');
    expect(agent.tools).toEqual(['edit_document']);
    expect(agent.metadata).toMatchObject({ defaultTags: { campaign: 'inbox-agent' } });
    expect(agent.httpTools).toEqual([expect.objectContaining({
      name: 'send_email',
      endpoint: `${mailpitUrl}/api/v1/send`,
      requiresApproval: true,
    })]);

    const triggers = (await inject('GET', `/api/triggers?agentId=${agent.id}`))
      .json<Array<{ eventType: string; conversationKey?: string; taskTemplate: string }>>();
    expect(triggers).toEqual([expect.objectContaining({
      eventType: 'custom.inbox.email',
      conversationKey: '{{payload.threadId}}',
    })]);
    expect(triggers[0]!.taskTemplate).toContain('from: Fernway Support <support@fernway.example>');

    const budgets = (await inject('GET', '/api/budgets'))
      .json<{ policies: Array<{ name: string; doc: { selector: Record<string, string>; limits: Record<string, number> } }> }>().policies;
    expect(budgets).toEqual([expect.objectContaining({
      name: 'inbox-agent weekly budget',
      doc: expect.objectContaining({ selector: { campaign: 'inbox-agent' }, limits: { costUsd: 2, turns: 60 } }),
    })]);

    const keys = (await inject('GET', '/api/keys')).json<{ keys: Array<{ name: string; capabilities: string[]; status: string }> }>().keys;
    expect(keys).toEqual([expect.objectContaining({
      name: 'inbox-webhook',
      capabilities: ['triggers:emit:custom.inbox.*'],
      status: 'active',
    })]);
  }, 180_000);

  it('gives each email its own run and keeps each thread in one conversation', async () => {
    const { app, container } = testApp!;
    const agent = await inboxAgent();
    const finalizer = new TurnFinalizer({ db: container.db, eventBus: container.eventBus });
    vi.spyOn(container.turnStartupService, 'launchPreparedTurn').mockImplementation(async (start, agentId, options) => {
      if (agentId !== agent.id || launches.some((launch) => launch.turnId === start.turnId)) return;
      launches.push({ turnId: start.turnId, conversationId: start.conversationId, mode: start.mode, task: start.taskDescription });
      await finalizer.finalize({ turnId: start.turnId, agentId, conversationId: start.conversationId, status: 'completed' });
      options?.onSuccess?.();
    });

    const sent = await runScript('send-email.ts', [
      `${EXAMPLE}emails/01-late-delivery.eml`,
      `${EXAMPLE}emails/04-brake-repair.eml`,
    ], { INBOX_WEBHOOK_KEY: webhookKey });
    expect(sent).toContain('01-late-delivery.eml: "Where is my bike? Order FW-10482"');
    await vi.waitFor(() => expect(launches).toHaveLength(2), { timeout: 30_000, interval: 50 });

    const replies = await runScript('send-email.ts', ['--follow-ups'], { INBOX_WEBHOOK_KEY: webhookKey });
    expect(replies).toContain('Sending 2 email(s)');
    await vi.waitFor(() => expect(launches).toHaveLength(4), { timeout: 30_000, interval: 50 });

    const runFor = (text: string) => {
      const run = launches.find((launch) => launch.task.includes(text));
      if (!run) throw new Error(`no run for ${text}`);
      return run;
    };
    const delivery = runFor('tracking page still says "preparing"');
    const deliveryReply = runFor('Could the courier bring the bike to my office');
    const brakes = runFor('(serial FW-EB-7734)');
    const brakesReply = runFor('could they look at\nthe bell too');

    expect(delivery.conversationId).toBe(triggerConversationId(agent.id, '<fw10482.maya@example.com>'));
    expect(deliveryReply.conversationId).toBe(delivery.conversationId);
    expect(brakesReply.conversationId).toBe(brakes.conversationId);
    expect(brakes.conversationId).not.toBe(delivery.conversationId);
    expect(launches.every((launch) => launch.mode === 'background')).toBe(true);

    expect(deliveryReply.task).toContain('In-Reply-To: <fw10482.maya.2@example.com>');
    expect(deliveryReply.task).toContain('References: <fw10482.maya@example.com> <reply.fw10482@fernway.example> <fw10482.maya.2@example.com>');
    expect(deliveryReply.task).toContain('to: maya.lindqvist@example.com');
    expect(deliveryReply.task).not.toContain('{{');

    // The thread's conversation holds both emails, in order.
    const conversation = await inject('GET', `/api/agents/${agent.id}/turns`);
    const turns = conversation.json<{ turns: Array<{ conversationId: string; status: string; tags?: Record<string, string> | null }> }>().turns;
    expect(turns.filter((turn) => turn.conversationId === delivery.conversationId)).toHaveLength(2);
    for (const turn of turns) {
      expect(turn.status).toBe('COMPLETED');
      expect(turn.tags).toMatchObject({ campaign: 'inbox-agent' });
    }
    const messages = await container.db.getMessages(delivery.conversationId);
    expect(messages.filter((message) => message.role === 'user').map((message) => message.content.includes('Thursday works')))
      .toEqual([false, true]);

    // The delivery key can only deliver emails.
    const refused = await app.inject({
      method: 'POST',
      url: '/api/triggers/emit',
      headers: { authorization: `Bearer ${webhookKey}` },
      payload: { type: 'custom.factory.week', payload: {} },
    });
    expect(refused.statusCode).toBe(403);
  }, 120_000);

  it('sends an approved reply through the agent\'s send_email tool, which always asks first', async () => {
    const { container } = testApp!;
    const agent = await inboxAgent();
    const tool = container.toolRegistry.getTool('send_email', agent.id);
    expect(tool?.requiresApproval).toBe(true);

    const provider = container.toolRegistry.getProvider('send_email', agent.id);
    if (!provider) throw new Error('send_email has no provider');
    const result = await provider.execute('send_email', {
      From: { Email: 'support@fernway.example', Name: 'Fernway Support' },
      To: [{ Email: 'maya.lindqvist@example.com' }],
      Subject: 'Re: Where is my bike? Order FW-10482',
      Text: 'Hi Maya,\n\nYour bike arrives on Thursday.\n\nFernway Support',
      Headers: { 'In-Reply-To': '<fw10482.maya@example.com>', References: '<fw10482.maya@example.com>' },
    }, { agentId: agent.id, conversationId: 'conversation-1', workspaceDir: '/workspace' });

    expect(JSON.parse(result)).toEqual({ ID: 'mailpit-1' });
    expect(sentMail).toEqual([expect.objectContaining({
      To: [{ Email: 'maya.lindqvist@example.com' }],
      Headers: { 'In-Reply-To': '<fw10482.maya@example.com>', References: '<fw10482.maya@example.com>' },
    })]);
  });
});
