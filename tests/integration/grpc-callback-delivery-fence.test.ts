import {
  type ArtifactMeta,
  type EmitEventRequest,
  type RegisterArtifactRequest,
  type RequestToolRequest,
} from '@ctxmill/proto/sandbox/v1';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { TypedEventBus } from '../../packages/ctxmill/src/events/bus.js';
import {
  CALLBACK_AGENT_HEADER,
  CALLBACK_SESSION_HEADER,
  CALLBACK_TOKEN_HEADER,
  mintGrpcCallbackToken,
  validateGrpcCallbackAuth,
} from '../../packages/ctxmill/src/orchestrator/grpc/callback-auth.js';
import {
  createOrchestratorServiceImpl,
  DefaultOrchestratorToolRegistry,
  registerDefaultToolHandlers,
} from '../../packages/ctxmill/src/orchestrator/grpc/orchestrator-service.js';
import { mintTurnDeliveryCapability } from '../../packages/ctxmill/src/orchestrator/grpc/turn-delivery-capability.js';
import { CanonicalLog } from '../../packages/ctxmill/src/orchestrator/canonical/canonical-log.js';
import { InterruptManager } from '../../packages/ctxmill/src/orchestrator/interrupt.js';
import { createTestDb, type TestDb } from '../utils/test-db.js';

const CALLBACK_SECRET = 'integration-callback-secret';
const FAILED_PRECONDITION_CODE = 9;

async function expectConnectCode(
  promise: Promise<unknown>,
  code: number,
): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(Error);
  if (
    typeof error !== 'object'
    || error === null
    || !('code' in error)
  ) {
    throw new Error('Expected an error with a Connect code');
  }
  expect(error.code).toBe(code);
}

describe('sandbox callback delivery fence', () => {
  let testDb: TestDb;

  const withDeliveryCapability = <T extends {
    turnId: string;
    sandboxSessionId: string;
    agentId: string;
  }>(
    request: T,
    input: {
      ownerId: string;
      fenceToken: number;
      leaseExpiresAt: number;
      restoreFenceToken: number;
      containerId: string | null;
    },
  ) => Object.assign(request, {
    deliveryCapability: mintTurnDeliveryCapability({
      turnId: request.turnId,
      sandboxSessionId: request.sandboxSessionId,
      agentId: request.agentId,
      ownerId: input.ownerId,
      fenceToken: input.fenceToken,
      leaseExpiresAtMs: input.leaseExpiresAt,
      restoreFenceToken: input.restoreFenceToken,
      ...(input.containerId === null ? {} : { containerId: input.containerId }),
    }, { mode: 'enforce', secret: CALLBACK_SECRET }),
  });

  beforeAll(async () => {
    testDb = await createTestDb();
  });

  afterAll(async () => {
    await testDb?.close();
  });

  it('admits valid-HMAC live callbacks and rejects the same sandbox after lease expiry', async () => {
    const agent = await testDb.repo.createAgent({
      name: 'Callback Fence Agent',
      harness: 'claude-agents',
      harnessConfig: JSON.stringify({ model: 'claude-sonnet-4-6' }),
      systemPrompt: 'Test callback ownership.',
      tools: [],
    });
    const conversation = await testDb.repo.createConversation(agent.id);
    const sandboxSession = await testDb.repo.createSandboxSession({
      conversationId: conversation.id,
      agentId: agent.id,
      harnessName: 'claude-agents',
      containerName: 'callback-runtime-generation-one',
      containerId: 'callback-container-generation-one',
    });
    const turn = await testDb.repo.createTurn({
      sandboxSessionId: sandboxSession.id,
      agentId: agent.id,
      conversationId: conversation.id,
      mode: 'interactive',
    });
    const lease = await testDb.repo.claimTurnDeliveryLease({
      turnId: turn.id,
      ownerId: 'callback-integration-owner',
      leaseDurationMs: 60_000,
    });
    expect(lease).toBeDefined();
    expect(await testDb.repo.activateTurnDelivery({
      turnId: turn.id,
      sandboxSessionId: sandboxSession.id,
      ownerId: lease!.ownerId,
      fenceToken: lease!.fenceToken,
      expectedActiveGeneration: {
        restoreFenceToken: sandboxSession.restoreFenceToken,
        containerId: sandboxSession.containerId,
      },
    })).toBe(true);

    const canonicalLog = new CanonicalLog({
      db: testDb.repo,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
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
    const eventListener = vi.fn();
    (eventBus.on as unknown as (
      event: string,
      handler: (payload: unknown) => void,
    ) => void)('callback.integration', eventListener);
    const toolHandler = vi.fn().mockResolvedValue('live-tool-result');
    const toolRegistry = new DefaultOrchestratorToolRegistry();
    toolRegistry.set('callback-probe', toolHandler);
    const service = createOrchestratorServiceImpl({
      eventBus,
      toolRegistry,
      repository: testDb.repo,
      callbackAuthConfig: {
        mode: 'enforce',
        secret: CALLBACK_SECRET,
      },
    });

    const headers = new Headers({
      [CALLBACK_SESSION_HEADER]: sandboxSession.id,
      [CALLBACK_AGENT_HEADER]: agent.id,
      [CALLBACK_TOKEN_HEADER]: mintGrpcCallbackToken(
        sandboxSession.id,
        agent.id,
        CALLBACK_SECRET,
      ),
    });
    const authenticate = (request: unknown): void => {
      validateGrpcCallbackAuth(
        { mode: 'enforce', secret: CALLBACK_SECRET },
        headers,
        request,
      );
    };

    const liveToolRequest = withDeliveryCapability<RequestToolRequest>({
      $typeName: 'ctxmill.sandbox.v1.RequestToolRequest',
      turnId: turn.id,
      sandboxSessionId: sandboxSession.id,
      agentId: agent.id,
      toolName: 'callback-probe',
      argsJson: '{"live":true}',
      requestId: 'callback-tool-live',
    }, {
      ownerId: lease!.ownerId,
      fenceToken: lease!.fenceToken,
      leaseExpiresAt: lease!.leaseExpiresAt,
      restoreFenceToken: sandboxSession.restoreFenceToken,
      containerId: sandboxSession.containerId,
    });
    const liveEventRequest = withDeliveryCapability<EmitEventRequest>({
      $typeName: 'ctxmill.sandbox.v1.EmitEventRequest',
      turnId: turn.id,
      sandboxSessionId: sandboxSession.id,
      agentId: agent.id,
      eventType: 'callback.integration',
      payloadJson: '{"live":true}',
    }, {
      ownerId: lease!.ownerId,
      fenceToken: lease!.fenceToken,
      leaseExpiresAt: lease!.leaseExpiresAt,
      restoreFenceToken: sandboxSession.restoreFenceToken,
      containerId: sandboxSession.containerId,
    });
    const liveArtifact: ArtifactMeta = {
      $typeName: 'ctxmill.sandbox.v1.ArtifactMeta',
      id: 'callback-artifact-live',
      turnId: turn.id,
      agentId: agent.id,
      name: 'live.txt',
      mimeType: 'text/plain',
      sizeBytes: 4n,
      storageKey: 'callbacks/live.txt',
      bucket: 'artifacts',
      metadataJson: '',
      createdAt: BigInt(Date.now()),
      kind: 'callback_probe',
    };
    const liveArtifactRequest = withDeliveryCapability<RegisterArtifactRequest>({
      $typeName: 'ctxmill.sandbox.v1.RegisterArtifactRequest',
      turnId: turn.id,
      sandboxSessionId: sandboxSession.id,
      agentId: agent.id,
      artifact: liveArtifact,
    }, {
      ownerId: lease!.ownerId,
      fenceToken: lease!.fenceToken,
      leaseExpiresAt: lease!.leaseExpiresAt,
      restoreFenceToken: sandboxSession.restoreFenceToken,
      containerId: sandboxSession.containerId,
    });

    for (const request of [
      liveToolRequest,
      liveEventRequest,
      liveArtifactRequest,
    ]) {
      expect(() => authenticate(request)).not.toThrow();
    }
    await expect(service.requestTool(liveToolRequest)).resolves.toMatchObject({
      result: 'live-tool-result',
    });
    await expect(service.emitEvent(liveEventRequest)).resolves.toBeDefined();
    await expect(service.registerArtifact(liveArtifactRequest)).resolves.toMatchObject({
      artifactId: 'callback-artifact-live',
    });
    await canonicalLog.drain();

    expect(toolHandler).toHaveBeenCalledOnce();
    expect(await testDb.repo.getToolDedup('callback-tool-live')).toMatchObject({
      status: 'completed',
    });
    expect(eventListener).toHaveBeenCalledOnce();
    expect(await testDb.repo.getArtifact('callback-artifact-live')).toMatchObject({
      kind: 'callback_probe',
    });
    const liveFrames = await canonicalLog.replayTurnTail(turn.id);
    expect(liveFrames.length).toBeGreaterThan(0);

    await testDb.conn.pgClient`
      UPDATE turn_delivery_leases
      SET
        lease_expires_at = floor(extract(epoch from clock_timestamp()) * 1000)::bigint - 1,
        updated_at = floor(extract(epoch from clock_timestamp()) * 1000)::bigint
      WHERE turn_id = ${turn.id}
    `;
    const successorLease = await testDb.repo.claimTurnDeliveryLease({
      turnId: turn.id,
      ownerId: 'callback-successor-owner',
      leaseDurationMs: 60_000,
    });
    expect(successorLease).toMatchObject({
      ownerId: 'callback-successor-owner',
      fenceToken: lease!.fenceToken + 1,
    });

    const staleToolRequest: RequestToolRequest = {
      ...liveToolRequest,
      requestId: 'callback-tool-stale',
    };
    const staleEventRequest: EmitEventRequest = {
      ...liveEventRequest,
      payloadJson: '{"stale":true}',
    };
    const staleArtifactRequest: RegisterArtifactRequest = {
      ...liveArtifactRequest,
      artifact: {
        ...liveArtifact,
        id: 'callback-artifact-stale',
        name: 'stale.txt',
        storageKey: 'callbacks/stale.txt',
      },
    };
    for (const request of [
      staleToolRequest,
      staleEventRequest,
      staleArtifactRequest,
    ]) {
      expect(() => authenticate(request)).not.toThrow();
    }

    await expectConnectCode(
      service.requestTool(staleToolRequest),
      FAILED_PRECONDITION_CODE,
    );
    await expectConnectCode(
      service.emitEvent(staleEventRequest),
      FAILED_PRECONDITION_CODE,
    );
    await expectConnectCode(
      service.registerArtifact(staleArtifactRequest),
      FAILED_PRECONDITION_CODE,
    );
    await canonicalLog.drain();

    expect(toolHandler).toHaveBeenCalledOnce();
    expect(await testDb.repo.getToolDedup('callback-tool-stale')).toBeUndefined();
    expect(eventListener).toHaveBeenCalledOnce();
    expect(await canonicalLog.replayTurnTail(turn.id)).toHaveLength(liveFrames.length);
    expect(await testDb.repo.getArtifact('callback-artifact-stale')).toBeUndefined();
  });

  it('rejects callbacks from a predecessor runtime generation without borrowing the successor generation', async () => {
    const agent = await testDb.repo.createAgent({
      name: 'Callback Generation Agent',
      harness: 'claude-agents',
      harnessConfig: JSON.stringify({ model: 'claude-sonnet-4-6' }),
      systemPrompt: 'Test callback generation ownership.',
      tools: [],
    });
    const conversation = await testDb.repo.createConversation(agent.id);
    const sandboxSession = await testDb.repo.createSandboxSession({
      conversationId: conversation.id,
      agentId: agent.id,
      harnessName: 'claude-agents',
      containerName: 'callback-runtime-generation-zero',
      containerId: 'callback-container-generation-zero',
    });
    const turn = await testDb.repo.createTurn({
      sandboxSessionId: sandboxSession.id,
      agentId: agent.id,
      conversationId: conversation.id,
      mode: 'interactive',
    });
    const lease = await testDb.repo.claimTurnDeliveryLease({
      turnId: turn.id,
      ownerId: 'callback-generation-owner',
      leaseDurationMs: 60_000,
    });
    expect(lease).toBeDefined();
    expect(await testDb.repo.activateTurnDelivery({
      turnId: turn.id,
      sandboxSessionId: sandboxSession.id,
      ownerId: lease!.ownerId,
      fenceToken: lease!.fenceToken,
      expectedActiveGeneration: {
        restoreFenceToken: sandboxSession.restoreFenceToken,
        containerId: sandboxSession.containerId,
      },
    })).toBe(true);

    const toolHandler = vi.fn().mockResolvedValue('generation-tool-result');
    const toolRegistry = new DefaultOrchestratorToolRegistry();
    toolRegistry.set('generation-probe', toolHandler);
    const service = createOrchestratorServiceImpl({
      eventBus: new TypedEventBus(),
      toolRegistry,
      repository: testDb.repo,
      callbackAuthConfig: {
        mode: 'enforce',
        secret: CALLBACK_SECRET,
      },
    });
    const predecessorRequest = withDeliveryCapability<RequestToolRequest>({
      $typeName: 'ctxmill.sandbox.v1.RequestToolRequest',
      turnId: turn.id,
      sandboxSessionId: sandboxSession.id,
      agentId: agent.id,
      toolName: 'generation-probe',
      argsJson: '{}',
      requestId: 'callback-generation-predecessor',
    }, {
      ownerId: lease!.ownerId,
      fenceToken: lease!.fenceToken,
      leaseExpiresAt: lease!.leaseExpiresAt,
      restoreFenceToken: sandboxSession.restoreFenceToken,
      containerId: sandboxSession.containerId,
    });

    const successorRestoreFenceToken = sandboxSession.restoreFenceToken + 1;
    const successorContainerId = 'callback-container-generation-one';
    await testDb.conn.pgClient`
      UPDATE sandbox_sessions
      SET
        restore_fence_token = ${successorRestoreFenceToken},
        container_id = ${successorContainerId},
        container_name = 'callback-runtime-generation-one',
        updated_at = floor(extract(epoch from clock_timestamp()) * 1000)::bigint
      WHERE id = ${sandboxSession.id}
    `;

    await expectConnectCode(
      service.requestTool(predecessorRequest),
      FAILED_PRECONDITION_CODE,
    );
    expect(toolHandler).not.toHaveBeenCalled();
    expect(
      await testDb.repo.getToolDedup('callback-generation-predecessor'),
    ).toBeUndefined();

    const successorRequest = withDeliveryCapability<RequestToolRequest>({
      ...predecessorRequest,
      requestId: 'callback-generation-successor',
    }, {
      ownerId: lease!.ownerId,
      fenceToken: lease!.fenceToken,
      leaseExpiresAt: lease!.leaseExpiresAt,
      restoreFenceToken: successorRestoreFenceToken,
      containerId: successorContainerId,
    });
    await expect(service.requestTool(successorRequest)).resolves.toMatchObject({
      result: 'generation-tool-result',
    });
    expect(toolHandler).toHaveBeenCalledOnce();
  });

  it('cannot persist an approval interrupt after delivery ownership changes', async () => {
    const agent = await testDb.repo.createAgent({
      name: 'Callback Approval Fence Agent',
      harness: 'claude-agents',
      harnessConfig: JSON.stringify({ model: 'claude-sonnet-4-6' }),
      systemPrompt: 'Test approval callback ownership.',
      tools: [],
    });
    const conversation = await testDb.repo.createConversation(agent.id);
    const sandboxSession = await testDb.repo.createSandboxSession({
      conversationId: conversation.id,
      agentId: agent.id,
      harnessName: 'claude-agents',
      containerName: 'callback-approval-runtime',
      containerId: 'callback-approval-container',
    });
    const turn = await testDb.repo.createTurn({
      sandboxSessionId: sandboxSession.id,
      agentId: agent.id,
      conversationId: conversation.id,
      mode: 'interactive',
    });
    const lease = await testDb.repo.claimTurnDeliveryLease({
      turnId: turn.id,
      ownerId: 'callback-approval-owner-a',
      leaseDurationMs: 60_000,
    });
    expect(lease).toBeDefined();
    expect(await testDb.repo.activateTurnDelivery({
      turnId: turn.id,
      sandboxSessionId: sandboxSession.id,
      ownerId: lease!.ownerId,
      fenceToken: lease!.fenceToken,
      expectedActiveGeneration: {
        restoreFenceToken: sandboxSession.restoreFenceToken,
        containerId: sandboxSession.containerId,
      },
    })).toBe(true);

    const canonicalLog = new CanonicalLog({
      db: testDb.repo,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
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
    const requestedListener = vi.fn();
    eventBus.on('interrupt.requested', requestedListener);
    const interrupts = new InterruptManager(eventBus, testDb.repo);
    const toolRegistry = new DefaultOrchestratorToolRegistry();
    registerDefaultToolHandlers(toolRegistry, {
      eventBus,
      interruptManager: interrupts,
      repository: testDb.repo,
    });
    const service = createOrchestratorServiceImpl({
      eventBus,
      toolRegistry,
      repository: testDb.repo,
      callbackAuthConfig: {
        mode: 'enforce',
        secret: CALLBACK_SECRET,
      },
    });

    let installationEntered!: () => void;
    const enteredInstallation = new Promise<void>((resolve) => {
      installationEntered = resolve;
    });
    let releaseInstallation!: () => void;
    const installationGate = new Promise<void>((resolve) => {
      releaseInstallation = resolve;
    });
    const installPendingInterrupt =
      testDb.repo.installPendingInterruptIfSandboxCallbackCurrent.bind(testDb.repo);
    vi.spyOn(
      testDb.repo,
      'installPendingInterruptIfSandboxCallbackCurrent',
    ).mockImplementation(async (...args) => {
      installationEntered();
      await installationGate;
      return installPendingInterrupt(...args);
    });

    const approvalRequest = withDeliveryCapability<RequestToolRequest>({
      $typeName: 'ctxmill.sandbox.v1.RequestToolRequest',
      turnId: turn.id,
      sandboxSessionId: sandboxSession.id,
      agentId: agent.id,
      toolName: 'request-approval',
      argsJson: '{"reason":"confirm takeover safety"}',
      requestId: 'callback-approval-stale',
    }, {
      ownerId: lease!.ownerId,
      fenceToken: lease!.fenceToken,
      leaseExpiresAt: lease!.leaseExpiresAt,
      restoreFenceToken: sandboxSession.restoreFenceToken,
      containerId: sandboxSession.containerId,
    });
    const staleRequest = service.requestTool(approvalRequest);
    await enteredInstallation;

    await testDb.conn.pgClient`
      UPDATE turn_delivery_leases
      SET
        lease_expires_at = floor(extract(epoch from clock_timestamp()) * 1000)::bigint - 1,
        updated_at = floor(extract(epoch from clock_timestamp()) * 1000)::bigint
      WHERE turn_id = ${turn.id}
    `;
    const successor = await testDb.repo.claimTurnDeliveryLease({
      turnId: turn.id,
      ownerId: 'callback-approval-owner-b',
      leaseDurationMs: 60_000,
    });
    expect(successor).toMatchObject({
      ownerId: 'callback-approval-owner-b',
      fenceToken: lease!.fenceToken + 1,
    });
    releaseInstallation();

    await expectConnectCode(staleRequest, FAILED_PRECONDITION_CODE);
    await canonicalLog.drain();

    expect(
      await testDb.repo.getPendingInterruptForTurn(turn.id),
    ).toBeUndefined();
    expect(requestedListener).not.toHaveBeenCalled();
    expect(await canonicalLog.replayTurnTail(turn.id)).toEqual([]);
    expect(interrupts.hasPendingForTurn(turn.id)).toBe(false);

    interrupts.shutdown();
  });
});
