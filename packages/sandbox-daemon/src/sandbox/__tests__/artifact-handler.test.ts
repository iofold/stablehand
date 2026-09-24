import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { create } from '@bufbuild/protobuf';
import {
  RegisterArtifactResponseSchema,
  TurnDeliveryCapabilitySchema,
} from '@stablehand/proto/sandbox/v1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ArtifactStore } from '../../artifact/artifact-store.js';
import { createArtifactHandlers } from '../artifact-handler.js';
import type { OrchestratorServiceClient } from '../tool-proxy.js';

describe('artifact handlers', () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), 'stablehand-artifact-handler-'));
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it('cleans up uploaded object and returns an error when metadata registration returns an error', async () => {
    await writeFile(join(workspaceDir, 'report.txt'), 'artifact body');

    const artifactStore = {
      upload: vi.fn().mockImplementation(async (
        _key: string,
        body: AsyncIterable<Uint8Array>,
      ) => {
        for await (const chunk of body) {
          // S3 consumes the stream before resolving the upload.
          void chunk;
        }
      }),
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
        signature: 'stablehand-open-turn-delivery-capability-v1',
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

  it('uploads small files as retry-safe buffers while registering the exact content sha256', async () => {
    const content = Buffer.from('artifact body');
    const expectedSha256 = createHash('sha256').update(content).digest('hex');
    await writeFile(join(workspaceDir, 'report.txt'), content);

    let uploaded = Buffer.alloc(0);
    const upload = vi.fn().mockImplementation(async (
      _key: string,
      body: Buffer | AsyncIterable<Uint8Array>,
    ) => {
      // Small files must arrive as Buffers: a Readable body is not
      // retry-safe in the S3 client (drained stream + fixed Content-Length
      // on retry ⇒ IncompleteBody).
      expect(Buffer.isBuffer(body)).toBe(true);
      uploaded = Buffer.from(body as Buffer);
    });
    const artifactStore = {
      upload,
      deleteObject: vi.fn(),
      getBucket: vi.fn().mockReturnValue('artifacts'),
    } as unknown as ArtifactStore;
    const registerArtifact = vi.fn().mockResolvedValue(create(RegisterArtifactResponseSchema, {
      artifactId: 'artifact-1',
    }));
    const orchestratorClient = {
      registerArtifact,
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
        signature: 'stablehand-open-turn-delivery-capability-v1',
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
    });

    const result = await handlers.get('artifact_upload')?.({ path: 'report.txt' });

    expect(uploaded).toEqual(content);
    expect(registerArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        artifact: expect.objectContaining({ sha256: expectedSha256 }),
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(JSON.parse(result ?? '{}')).toMatchObject({ sha256: expectedSha256 });
  });
});
