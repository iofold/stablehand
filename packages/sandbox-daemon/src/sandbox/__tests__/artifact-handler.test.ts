import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { create } from '@bufbuild/protobuf';
import { RegisterArtifactResponseSchema } from '@ctxmill/proto/sandbox/v1';
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

    const handlers = createArtifactHandlers({
      artifactStore,
      orchestratorClient,
      turnId: 'turn-1',
      agentId: 'agent-1',
      workspaceDir,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    });

    const result = await handlers.get('artifact_upload')?.({ path: 'report.txt' });

    expect(JSON.parse(result ?? '{}')).toEqual({ error: 'Upload failed: metadata unavailable' });
    expect(artifactStore.upload).toHaveBeenCalledTimes(1);
    expect(artifactStore.deleteObject).toHaveBeenCalledWith(expect.stringMatching(/^artifacts\/.+\/report\.txt$/));
  });
});
