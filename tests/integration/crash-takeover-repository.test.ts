import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { TypedEventBus } from '../../packages/stablehand/src/events/bus.js';
import { CanonicalLog } from '../../packages/stablehand/src/orchestrator/canonical/canonical-log.js';
import { createTestDb, type TestDb } from '../utils/test-db.js';

/**
 * ADR 024 persistence contracts: previous-boot lease takeover, tool dedup
 * reclaim under the successor fence, idempotent projection re-staging, and
 * the delivery watermark read from tagged canonical frames.
 */
describe('crash takeover repository contracts (ADR 024)', () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
  });

  afterAll(async () => {
    await testDb?.close();
  });

  async function runningTurn(ownerId: string) {
    const agent = await testDb.repo.createAgent({
      name: `Takeover Agent ${Math.random()}`,
      harness: 'langgraph',
      harnessConfig: JSON.stringify({ model: 'gpt-5.4-mini' }),
      systemPrompt: 'Test takeover.',
      tools: [],
    });
    const conversation = await testDb.repo.createConversation(agent.id);
    const session = await testDb.repo.createSandboxSession({
      conversationId: conversation.id,
      agentId: agent.id,
      harnessName: 'langgraph',
      containerName: `takeover-${conversation.id}`,
      containerId: `container-${conversation.id}`,
    });
    const turn = await testDb.repo.createTurn({
      sandboxSessionId: session.id,
      agentId: agent.id,
      conversationId: conversation.id,
      mode: 'interactive',
    });
    const lease = await testDb.repo.claimTurnDeliveryLease({
      turnId: turn.id,
      ownerId,
      leaseDurationMs: 60_000,
    });
    expect(lease).toBeDefined();
    expect(await testDb.repo.activateTurnDelivery({
      turnId: turn.id,
      sandboxSessionId: session.id,
      ownerId: lease!.ownerId,
      fenceToken: lease!.fenceToken,
      expectedActiveGeneration: {
        restoreFenceToken: session.restoreFenceToken,
        containerId: session.containerId,
      },
    })).toBe(true);
    return { agent, conversation, session, turn, lease: lease! };
  }

  it('lets a later boot of the same instance take over an unexpired lease, but not another instance', async () => {
    const { turn } = await runningTurn('inst-a/boot-1/owner');

    await expect(testDb.repo.claimTurnDeliveryLease({
      turnId: turn.id,
      ownerId: 'inst-a/boot-2/owner',
      leaseDurationMs: 60_000,
    })).resolves.toBeUndefined();

    await expect(testDb.repo.claimTurnDeliveryLease({
      turnId: turn.id,
      ownerId: 'inst-b/boot-7/owner',
      leaseDurationMs: 60_000,
      previousBootTakeover: { instancePrefix: 'inst-b/', ownBootPrefix: 'inst-b/boot-7/' },
    })).resolves.toBeUndefined();

    const takeover = await testDb.repo.claimTurnDeliveryLease({
      turnId: turn.id,
      ownerId: 'inst-a/boot-2/owner',
      leaseDurationMs: 60_000,
      previousBootTakeover: { instancePrefix: 'inst-a/', ownBootPrefix: 'inst-a/boot-2/' },
    });
    expect(takeover).toMatchObject({ ownerId: 'inst-a/boot-2/owner', fenceToken: 2 });
    await expect(testDb.repo.isTurnDeliveryFenceCurrent(turn.id, {
      ownerId: 'inst-a/boot-1/owner',
      fenceToken: 1,
    })).resolves.toBe(false);
    await expect(testDb.repo.renewTurnDeliveryLease(turn.id, 'inst-a/boot-1/owner', 1, 60_000))
      .resolves.toBeUndefined();

    // The new boot does not steal its own leases from itself.
    await expect(testDb.repo.claimTurnDeliveryLease({
      turnId: turn.id,
      ownerId: 'inst-a/boot-2/other',
      leaseDurationMs: 60_000,
      previousBootTakeover: { instancePrefix: 'inst-a/', ownBootPrefix: 'inst-a/boot-2/' },
    })).resolves.toBeUndefined();
  });

  it('reclaims an in-progress tool request for the successor fence and fences out the dead executor', async () => {
    const { agent, session, turn, lease } = await runningTurn('inst-c/boot-1/owner');
    const authority = (ownerId: string, fenceToken: number) => ({
      turnId: turn.id,
      sandboxSessionId: session.id,
      agentId: agent.id,
      expectedDeliveryFence: { ownerId, fenceToken },
      expectedActiveGeneration: {
        restoreFenceToken: session.restoreFenceToken,
        containerId: session.containerId,
      },
    });

    await expect(testDb.repo.tryAdmitToolRequest({
      ...authority(lease.ownerId, lease.fenceToken),
      requestId: 'req-takeover-1',
      toolName: 'search',
    })).resolves.toBe('inserted');
    await expect(testDb.repo.tryAdmitToolRequest({
      ...authority(lease.ownerId, lease.fenceToken),
      requestId: 'req-takeover-1',
      toolName: 'search',
    })).resolves.toBe('duplicate');

    const successor = await testDb.repo.claimTurnDeliveryLease({
      turnId: turn.id,
      ownerId: 'inst-c/boot-2/owner',
      leaseDurationMs: 60_000,
      previousBootTakeover: { instancePrefix: 'inst-c/', ownBootPrefix: 'inst-c/boot-2/' },
    });
    expect(successor?.fenceToken).toBe(2);

    await expect(testDb.repo.tryAdmitToolRequest({
      ...authority(successor!.ownerId, successor!.fenceToken),
      requestId: 'req-takeover-1',
      toolName: 'search',
    })).resolves.toBe('reclaimed');
    await expect(testDb.repo.completeToolDedup(
      'req-takeover-1',
      'stale result',
      null,
      authority(lease.ownerId, lease.fenceToken),
    )).resolves.toBe(false);
    await expect(testDb.repo.completeToolDedup(
      'req-takeover-1',
      'fresh result',
      null,
      authority(successor!.ownerId, successor!.fenceToken),
    )).resolves.toBe(true);
    await expect(testDb.repo.tryAdmitToolRequest({
      ...authority(successor!.ownerId, successor!.fenceToken),
      requestId: 'req-takeover-1',
      toolName: 'search',
    })).resolves.toBe('duplicate');
    await expect(testDb.repo.getToolDedup('req-takeover-1')).resolves.toMatchObject({
      status: 'completed',
      result: 'fresh result',
    });
  });

  it('does not mint a new revision when re-staging an identical assistant projection', async () => {
    const { agent, conversation, turn, lease } = await runningTurn('inst-d/boot-1/owner');
    const fence = { ownerId: lease.ownerId, fenceToken: lease.fenceToken };
    const message = await testDb.repo.addCanonicalMessage({
      id: `canonical-${turn.id}-0`,
      agentId: agent.id,
      conversationId: conversation.id,
      turnId: turn.id,
      role: 'assistant',
      content: 'Let me check.',
      toolCalls: [{ id: 'tc-1', name: 'search', args: '{}', status: 'running' }],
      parts: [{ type: 'tool_call', id: 'tc-1', name: 'search', args: '{}', status: 'running' }],
    }, fence);
    expect(message?.messageRevision).toBe(0);

    const toolCalls = [{ id: 'tc-1', name: 'search', args: '{}', status: 'complete' }];
    const parts = [{
      type: 'tool_call',
      id: 'tc-1',
      name: 'search',
      args: '{}',
      status: 'complete',
      result: 'found',
      error: undefined,
    }];
    const first = await testDb.repo.stageAssistantMessageUpdate(message!.id, toolCalls, parts, fence);
    expect(first?.messageRevision).toBe(1);
    const replay = await testDb.repo.stageAssistantMessageUpdate(message!.id, toolCalls, parts, fence);
    expect(replay?.messageRevision).toBe(1);
  });

  it('reads the delivery watermark from the newest tagged frame of a turn', async () => {
    const { agent, conversation, turn, lease } = await runningTurn('inst-e/boot-1/owner');
    const canonicalLog = new CanonicalLog({
      db: testDb.repo,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const bus = new TypedEventBus({
      persistEvent: async (type, _agentId, payload, parsedPayload, context) => {
        const persisted = await canonicalLog.ingest(
          type,
          parsedPayload ?? JSON.parse(payload) as Record<string, unknown>,
          context,
        );
        return persisted.length > 0;
      },
    });
    const context = { deliveryFence: { ownerId: lease.ownerId, fenceToken: lease.fenceToken } };
    const base = { turnId: turn.id, agentId: agent.id, conversationId: conversation.id };

    await expect(testDb.repo.getTurnDeliveryWatermark(turn.id)).resolves.toBeUndefined();
    await bus.emitAsync('message.delta', {
      ...base,
      messageId: 'm',
      delta: 'hi',
      delivery: { id: 'delivery-x', seq: 3 },
      timestamp: 1,
    }, context);
    await bus.emitAsync('tool_call.started', {
      ...base,
      toolCallId: 'tc-1',
      toolName: 'search',
      args: {},
      delivery: { id: 'delivery-x', seq: 4 },
      timestamp: 2,
    }, context);
    await bus.emitAsync('ag_ui.event', {
      ...base,
      event: { type: 'STATE_DELTA', delta: [] },
      timestamp: 3,
    }, context);

    // The newest tagged-type frame carries no stamp (legacy writer): no watermark.
    await expect(testDb.repo.getTurnDeliveryWatermark(turn.id)).resolves.toBeUndefined();
    await bus.emitAsync('ag_ui.event', {
      ...base,
      event: { type: 'STATE_DELTA', delta: [] },
      delivery: { id: 'delivery-x', seq: 6 },
      timestamp: 4,
    }, context);
    await expect(testDb.repo.getTurnDeliveryWatermark(turn.id)).resolves.toEqual({
      deliveryId: 'delivery-x',
      deliverySeq: 6,
    });
  });
});
