import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { artifactRoutes } from '../artifacts.js';
import type { ArtifactStore } from '../../../artifact/artifact-store.js';
import type { DatabaseRepository } from '../../../database/repository.js';

function multipartBody(fields: Record<string, string>, file: { field: string; filename: string; contentType: string; body: string }) {
  const boundary = '----ctxmill-artifact-test';
  const chunks: string[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(`--${boundary}\r\n`);
    chunks.push(`Content-Disposition: form-data; name="${name}"\r\n\r\n`);
    chunks.push(`${value}\r\n`);
  }
  chunks.push(`--${boundary}\r\n`);
  chunks.push(`Content-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\n`);
  chunks.push(`Content-Type: ${file.contentType}\r\n\r\n`);
  chunks.push(`${file.body}\r\n`);
  chunks.push(`--${boundary}--\r\n`);
  return {
    body: chunks.join(''),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

async function createApp(
  repository: Partial<DatabaseRepository>,
  artifactStore: Partial<ArtifactStore>,
) {
  const app = Fastify({ logger: false });
  await app.register(multipart);
  await app.register(artifactRoutes, {
    prefix: '/api/artifacts',
    repository: repository as DatabaseRepository,
    artifactStore: artifactStore as ArtifactStore,
    bucket: 'artifacts',
  });
  return app;
}

describe('artifact routes', () => {
  const apps: Array<Awaited<ReturnType<typeof createApp>>> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('cleans up uploaded objects when multipart metadata activation fails', async () => {
    const repository = {
      saveArtifact: vi.fn().mockResolvedValue({ id: 'artifact-1' }),
      markArtifactUploadConfirmed: vi.fn().mockRejectedValue(new Error('db unavailable')),
      markArtifactUploadFailed: vi.fn().mockResolvedValue({ id: 'artifact-1', status: 'upload_failed' }),
    };
    const artifactStore = {
      upload: vi.fn().mockResolvedValue(undefined),
      headObject: vi.fn().mockResolvedValue({ sizeBytes: 12, contentType: 'text/plain' }),
      deleteObject: vi.fn().mockResolvedValue(undefined),
    };
    const app = await createApp(repository, artifactStore);
    apps.push(app);
    const multipart = multipartBody(
      { agentId: 'agent-1', name: 'report.txt' },
      { field: 'file', filename: 'report.txt', contentType: 'text/plain', body: 'artifact body' },
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/artifacts/upload',
      headers: { 'content-type': multipart.contentType },
      payload: multipart.body,
    });

    expect(response.statusCode).toBe(500);
    expect(repository.saveArtifact).toHaveBeenCalledWith(expect.objectContaining({
      status: 'pending_upload',
      sizeBytes: 0,
    }));
    expect(artifactStore.deleteObject).toHaveBeenCalledWith(expect.stringMatching(/^artifacts\/.+\/report\.txt$/));
    expect(repository.markArtifactUploadFailed).toHaveBeenCalledWith(expect.any(String));
  });

  it('keeps metadata recoverable when object deletion fails', async () => {
    const artifact = {
      id: 'artifact-1',
      agentId: 'agent-1',
      name: 'report.txt',
      mimeType: 'text/plain',
      sizeBytes: 12,
      storageKey: 'artifacts/artifact-1/report.txt',
      bucket: 'artifacts',
      status: 'active',
    };
    const repository = {
      getArtifact: vi.fn().mockResolvedValue(artifact),
      markArtifactDeleting: vi.fn().mockResolvedValue({ ...artifact, status: 'deleting' }),
      markArtifactDeleteFailed: vi.fn().mockResolvedValue({ ...artifact, status: 'delete_failed' }),
      deleteArtifact: vi.fn(),
    };
    const artifactStore = {
      headObject: vi.fn().mockResolvedValue({ sizeBytes: 12, contentType: 'text/plain' }),
      deleteObject: vi.fn().mockRejectedValue(new Error('s3 unavailable')),
    };
    const app = await createApp(repository, artifactStore);
    apps.push(app);

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/artifacts/artifact-1',
    });

    expect(response.statusCode).toBe(503);
    expect(repository.markArtifactDeleting).toHaveBeenCalledWith('artifact-1');
    expect(repository.markArtifactDeleteFailed).toHaveBeenCalledWith('artifact-1');
    expect(repository.deleteArtifact).not.toHaveBeenCalled();
  });
});
