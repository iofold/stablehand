import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { create } from '@bufbuild/protobuf';
import {
  RegisterArtifactResponseSchema,
  TurnDeliveryCapabilitySchema,
} from '@ctxmill/proto/sandbox/v1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ArtifactStore } from '../../artifact/artifact-store.js';
import { createArtifactHandlers } from '../artifact-handler.js';
import type { OrchestratorServiceClient } from '../tool-proxy.js';

describe('artifact handlers', () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), 'ctxmill-artifact-handler-'));
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it('cleans up uploaded object and returns an error when metadata registration returns an error', async () => {
    await writeFile(join(workspaceDir, 'report.txt'), 'artifact body');

    const artifactStore = {
      upload: vi.fn().mockResolvedValue(undefined),
      deleteObject: vi.fn().mockResolvedValue(undefined),
      getBucket: vi.fn().mockReturnValue('artifacts'),
    } as unknown as ArtifactStore & {
      upload: ReturnType<typeof vi.fn>;
      deleteObject: ReturnType<typeof vi.fn>;
      getBucket: ReturnType<typeof vi.fn>;
    };
    const orchestratorClient = {
      registerArtifact: vi.fn().mockResolvedValue(create(RegisterArtifactResponseSchema, {
        artifactId: '',
        error: 'metadata unavailable',
      })),
      requestTool: vi.fn(),
      resolveArtifact: vi.fn(),
    } as unknown as OrchestratorServiceClient;
    const leaseExpiresAtMs = Date.now() + 60_000;
    const deliveryContext = {
      identity: {
        turnId: 'turn-1',
        sandboxSessionId: 'sandbox-session-1',
        agentId: 'agent-1',
        ownerId: 'owner-1',
        fenceToken: 1,
        restoreFenceToken: 0,
        containerId: 'container-1',
      },
      capability: create(TurnDeliveryCapabilitySchema, {
        ownerId: 'owner-1',
        fenceToken: 1n,
        leaseExpiresAtMs: BigInt(leaseExpiresAtMs),
        restoreFenceToken: 0n,
        containerId: 'container-1',
        agentId: 'agent-1',
        signature: 'ctxmill-open-turn-delivery-capability-v1',
      }),
      leaseExpiresAtMs,
      abortController: new AbortController(),
    };

    const handlers = createArtifactHandlers({
      artifactStore,
      orchestratorClient,
      sandboxSessionId: 'sandbox-session-1',
      agentId: 'agent-1',
      workspaceDir,
      resolveDeliveryContext: () => deliveryContext,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    });

    const result = await handlers.get('artifact_upload')?.({
      path: 'report.txt',
      kind: 'eval_report',
      metadata: { suite: 'smoke' },
    });

    expect(JSON.parse(result ?? '{}')).toEqual({ error: 'Upload failed: metadata unavailable' });
    expect(artifactStore.upload).toHaveBeenCalledTimes(1);
    expect(orchestratorClient.registerArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        turnId: 'turn-1',
        sandboxSessionId: 'sandbox-session-1',
        agentId: 'agent-1',
        deliveryCapability: expect.objectContaining({
          ownerId: 'owner-1',
          fenceToken: 1n,
        }),
        artifact: expect.objectContaining({
          kind: 'eval_report',
          metadataJson: '{"suite":"smoke"}',
        }),
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(artifactStore.deleteObject).toHaveBeenCalledWith(expect.stringMatching(/^artifacts\/.+\/report\.txt$/));
  });
});
