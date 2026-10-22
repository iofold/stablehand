/**
 * ctx-9gy9: a provider-backed tool marked `requiresApproval` must pause on a
 * durable approval before it runs, through the real RequestTool path a
 * sandbox uses. Before this fix the delegate fallback called the HTTP handler
 * directly and the flag was decorative.
 */
import { type RequestToolRequest } from '@stablehand/proto/sandbox/v1';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { TypedEventBus } from '../../packages/stablehand/src/events/bus.js';
import { registerAgentHttpTools } from '../../packages/stablehand/src/orchestrator/http-tools.js';
import {
  createOrchestratorServiceImpl,
  DefaultOrchestratorToolRegistry,
} from '../../packages/stablehand/src/orchestrator/grpc/orchestrator-service.js';
import { mintTurnDeliveryCapability } from '../../packages/stablehand/src/orchestrator/grpc/turn-delivery-capability.js';
import { CanonicalLog } from '../../packages/stablehand/src/orchestrator/canonical/canonical-log.js';
import { InterruptManager } from '../../packages/stablehand/src/orchestrator/interrupt.js';
import { createToolApprovalGate } from '../../packages/stablehand/src/orchestrator/tool-approval-gate.js';
import { DefaultToolRegistry } from '../../packages/stablehand/src/tool/registry.js';
import { createTestDb, type TestDb } from '../utils/test-db.js';

const CALLBACK_SECRET = 'provider-approval-secret';

interface LiveTurn {
  agentId: string;
  turnId: string;
  sandboxSessionId: string;
  ownerId: string;
  fenceToken: number;
  leaseExpiresAt: number;
  restoreFenceToken: number;
  containerId: string | null;
}

describe('provider tools that require approval', () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
  });

  afterAll(async () => {
    await testDb?.close();
  });

  async function startLiveTurn(name: string, httpTools: unknown[]): Promise<LiveTurn> {
    const agent = await testDb.repo.createAgent({
      name,
      harness: 'langgraph',
      harnessConfig: JSON.stringify({ model: 'gpt-5.4-mini' }),
      systemPrompt: 'Publish approved drafts.',
      tools: [],
      metadata: { httpTools },
    });
    const conversation = await testDb.repo.createConversation(agent.id);
    const sandboxSession = await testDb.repo.createSandboxSession({
      conversationId: conversation.id,
      agentId: agent.id,
      harnessName: 'langgraph',
      containerName: `${name}-container`,
      containerId: `${name}-container-id`,
    });
    const turn = await testDb.repo.createTurn({
      sandboxSessionId: sandboxSession.id,
      agentId: agent.id,
      conversationId: conversation.id,
      mode: 'background',
    });
    const lease = await testDb.repo.claimTurnDeliveryLease({
      turnId: turn.id,
      ownerId: `${name}-owner`,
      leaseDurationMs: 60_000,
    });
    if (!lease) throw new Error('lease not granted');
    const activated = await testDb.repo.activateTurnDelivery({
      turnId: turn.id,
      sandboxSessionId: sandboxSession.id,
      ownerId: lease.ownerId,
      fenceToken: lease.fenceToken,
      expectedActiveGeneration: {
        restoreFenceToken: sandboxSession.restoreFenceToken,
        containerId: sandboxSession.containerId,
      },
    });
    expect(activated).toBe(true);
    return {
      agentId: agent.id,
      turnId: turn.id,
      sandboxSessionId: sandboxSession.id,
      ownerId: lease.ownerId,
      fenceToken: lease.fenceToken,
      leaseExpiresAt: lease.leaseExpiresAt,
      restoreFenceToken: sandboxSession.restoreFenceToken,
      containerId: sandboxSession.containerId,
    };
  }

  function toolRequest(live: LiveTurn, toolName: string, args: unknown, requestId: string): RequestToolRequest {
    return {
      $typeName: 'stablehand.sandbox.v1.RequestToolRequest',
      turnId: live.turnId,
      sandboxSessionId: live.sandboxSessionId,
      agentId: live.agentId,
      toolName,
      argsJson: JSON.stringify(args),
      requestId,
      deliveryCapability: mintTurnDeliveryCapability({
        turnId: live.turnId,
        sandboxSessionId: live.sandboxSessionId,
        agentId: live.agentId,
        ownerId: live.ownerId,
        fenceToken: live.fenceToken,
        leaseExpiresAtMs: live.leaseExpiresAt,
        restoreFenceToken: live.restoreFenceToken,
        ...(live.containerId === null ? {} : { containerId: live.containerId }),
      }, { mode: 'enforce', secret: CALLBACK_SECRET }),
    };
  }

  async function buildRuntime(agent: { id: string; name: string; metadata: Record<string, unknown> }) {
    const canonicalLog = new CanonicalLog({
      db: testDb.repo,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const eventBus = new TypedEventBus({
      persistEvent: async (type, _agentId, payload, parsedPayload, context) => {
        const persisted = await canonicalLog.ingest(
          type,
          parsedPayload ?? JSON.parse(payload) as Record<string, unknown>,
          context,
        );
        return persisted.length > 0;
      },
    });
    const interruptManager = new InterruptManager(eventBus, testDb.repo);
    const fetchFn = vi.fn(async () => new Response('{"scheduled":true}', { status: 200 }));
    const definitions = new DefaultToolRegistry();
    await registerAgentHttpTools(definitions, agent, undefined, fetchFn);
    const toolRegistry = new DefaultOrchestratorToolRegistry(
      definitions,
      (ctx) => ({
        agentId: ctx.agentId,
        conversationId: ctx.conversationId ?? '',
        turnId: ctx.turnId,
        requestId: ctx.requestId,
        workspaceDir: '/workspace',
      }),
      { approvalGate: createToolApprovalGate({ interruptManager, eventBus }) },
    );
    const service = createOrchestratorServiceImpl({
      eventBus,
      toolRegistry,
      repository: testDb.repo,
      callbackAuthConfig: { mode: 'enforce', secret: CALLBACK_SECRET },
    });
    return { service, interruptManager, fetchFn };
  }

  const scheduleTool = {
    name: 'schedule_post',
    description: 'Schedule an approved post',
    endpoint: 'https://publisher.example/schedule',
    method: 'POST',
    requiresApproval: true,
  };

  it('pauses the HTTP call on a durable interrupt and sends it only after approval', async () => {
    const live = await startLiveTurn('approval-http-approve', [scheduleTool]);
    const { service, interruptManager, fetchFn } = await buildRuntime({
      id: live.agentId,
      name: 'approval-http-approve',
      metadata: { httpTools: [scheduleTool] },
    });

    const pending = service.requestTool(
      toolRequest(live, 'schedule_post', { text: 'Ship notes, not slides.' }, 'req-approve'),
    );

    await vi.waitFor(async () => {
      const row = await testDb.repo.getPendingInterruptForTurn(live.turnId);
      expect(row?.toolName).toBe('schedule_post');
    }, { timeout: 5_000, interval: 25 });
    expect(fetchFn).not.toHaveBeenCalled();

    expect(await interruptManager.resolveForTurn(live.turnId, 'approve', undefined, live.agentId)).toBe(true);
    const response = await pending;
    expect(response.error).toBeFalsy();
    expect(JSON.parse(response.result)).toEqual({ scheduled: true });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    interruptManager.shutdown();
  });

  it('never sends a rejected call and hands the reviewer note to the model', async () => {
    const live = await startLiveTurn('approval-http-reject', [scheduleTool]);
    const { service, interruptManager, fetchFn } = await buildRuntime({
      id: live.agentId,
      name: 'approval-http-reject',
      metadata: { httpTools: [scheduleTool] },
    });

    const pending = service.requestTool(
      toolRequest(live, 'schedule_post', { text: 'Synergy!' }, 'req-reject'),
    );
    await vi.waitFor(async () => {
      expect(await testDb.repo.getPendingInterruptForTurn(live.turnId)).toBeDefined();
    }, { timeout: 5_000, interval: 25 });

    await interruptManager.resolveForTurn(live.turnId, 'reject', 'Too vague. Name the number.', live.agentId);
    const response = await pending;
    expect(JSON.parse(response.result)).toEqual({
      error: 'Tool call rejected: Too vague. Name the number.',
      rejected: true,
      note: 'Too vague. Name the number.',
    });
    expect(fetchFn).not.toHaveBeenCalled();
    interruptManager.shutdown();
  });

  it('runs an ungated HTTP tool straight away', async () => {
    const ungated = { ...scheduleTool, name: 'lookup_post', requiresApproval: false };
    const live = await startLiveTurn('approval-http-ungated', [ungated]);
    const { service, interruptManager, fetchFn } = await buildRuntime({
      id: live.agentId,
      name: 'approval-http-ungated',
      metadata: { httpTools: [ungated] },
    });

    const response = await service.requestTool(toolRequest(live, 'lookup_post', {}, 'req-ungated'));
    expect(response.error).toBeFalsy();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(await testDb.repo.getPendingInterruptForTurn(live.turnId)).toBeUndefined();
    interruptManager.shutdown();
  });
});
