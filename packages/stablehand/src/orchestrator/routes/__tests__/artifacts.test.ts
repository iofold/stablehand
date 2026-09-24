import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { artifactRoutes } from '../artifacts.js';
import type { ArtifactStore } from '../../../artifact/artifact-store.js';
import type { DatabaseRepository } from '../../../database/repository.js';
import { TypedEventBus } from '../../../events/bus.js';

function multipartBody(fields: Record<string, string>, file: { field: string; filename: string; contentType: string; body: string }) {
  const boundary = '----stablehand-artifact-test';
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
  eventBus?: TypedEventBus,
) {
  const app = Fastify({ logger: false });
  await app.register(multipart);
  await app.register(artifactRoutes, {
    prefix: '/api/artifacts',
    repository: repository as DatabaseRepository,
    artifactStore: artifactStore as ArtifactStore,
    bucket: 'artifacts',
    eventBus,
  });
  return app;
}

describe('artifact routes', () => {
  const sha256 = 'a'.repeat(64);
  const apps: Array<Awaited<ReturnType<typeof createApp>>> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('registers kind and metadata and emits one typed event for signed uploads', async () => {
    const row = {
      id: 'artifact-1',
      agentId: 'agent-1',
      turnId: null,
      conversationId: null,
      name: 'report.json',
      mimeType: 'application/json',
      sizeBytes: 12,
      storageKey: 'artifacts/artifact-1/report.json',
      bucket: 'artifacts',
      kind: 'eval_report',
      metadata: { suite: 'smoke' },
      sha256,
      status: 'pending_upload',
      expiresAt: 123,
      createdAt: 1,
      updatedAt: 1,
    };
    const repository = { saveArtifact: vi.fn().mockResolvedValue(row) };
    const artifactStore = {
      getSignedUploadUrl: vi.fn().mockResolvedValue('https://storage.test/upload'),
    };
    const eventBus = new TypedEventBus();
    const emit = vi.spyOn(eventBus, 'emit');
    const app = await createApp(repository, artifactStore, eventBus);
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/artifacts/upload-url',
      payload: {
        agentId: 'agent-1',
        name: 'report.json',
        mimeType: 'application/json',
        sizeBytes: 12,
        kind: 'eval_report',
        metadata: { suite: 'smoke' },
        sha256,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(repository.saveArtifact).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'eval_report',
      metadata: { suite: 'smoke' },
      sha256,
      sizeBytes: 12,
    }));
    expect(emit).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith('artifact.created', expect.objectContaining({
      artifactId: expect.any(String),
      kind: 'eval_report',
      sha256,
    }));
  });

  it('rejects malformed uploader-attested hashes before registration', async () => {
    const repository = { saveArtifact: vi.fn() };
    const artifactStore = { getSignedUploadUrl: vi.fn() };
    const app = await createApp(repository, artifactStore);
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/artifacts/upload-url',
      payload: {
        agentId: 'agent-1',
        name: 'report.json',
        mimeType: 'application/json',
        sha256: 'not-a-sha256',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(repository.saveArtifact).not.toHaveBeenCalled();
    expect(artifactStore.getSignedUploadUrl).not.toHaveBeenCalled();
  });

  it('rejects oversized artifact metadata before storage or persistence', async () => {
    const repository = { saveArtifact: vi.fn() };
    const artifactStore = { getSignedUploadUrl: vi.fn() };
    const app = await createApp(repository, artifactStore);
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/artifacts/upload-url',
      payload: {
        agentId: 'agent-1',
        name: 'report.json',
        mimeType: 'application/json',
        kind: 'eval_report',
        metadata: { content: 'x'.repeat(16 * 1024) },
      },
    });

    expect(response.statusCode).toBe(413);
    expect(repository.saveArtifact).not.toHaveBeenCalled();
    expect(artifactStore.getSignedUploadUrl).not.toHaveBeenCalled();
  });

  it('rejects malformed artifact kinds', async () => {
    const repository = { saveArtifact: vi.fn() };
    const artifactStore = { getSignedUploadUrl: vi.fn() };
    const app = await createApp(repository, artifactStore);
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/artifacts/upload-url',
      payload: {
        agentId: 'agent-1',
        name: 'report.json',
        mimeType: 'application/json',
        kind: 'Eval Report',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(repository.saveArtifact).not.toHaveBeenCalled();
  });

  it('propagates kind and JSON metadata through multipart registration', async () => {
    const pending = {
      id: 'artifact-1',
      agentId: 'agent-1',
      turnId: null,
      conversationId: null,
      name: 'report.txt',
      mimeType: 'text/plain',
      sizeBytes: 0,
      storageKey: 'artifacts/artifact-1/report.txt',
      bucket: 'artifacts',
      kind: 'eval_report',
      metadata: { suite: 'smoke' },
      sha256,
      status: 'pending_upload',
      expiresAt: null,
      createdAt: 1,
      updatedAt: 1,
    };
    const repository = {
      saveArtifact: vi.fn().mockResolvedValue(pending),
      markArtifactUploadConfirmed: vi.fn().mockResolvedValue({
        ...pending,
        sizeBytes: 13,
        status: 'active',
      }),
    };
    const artifactStore = {
      upload: vi.fn().mockResolvedValue(undefined),
      headObject: vi.fn().mockResolvedValue({ sizeBytes: 13, contentType: 'text/plain' }),
    };
    const eventBus = new TypedEventBus();
    const emit = vi.spyOn(eventBus, 'emit');
    const app = await createApp(repository, artifactStore, eventBus);
    apps.push(app);
    const multipart = multipartBody(
      {
        agentId: 'agent-1',
        name: 'report.txt',
        kind: 'eval_report',
        metadata: '{"suite":"smoke"}',
        sha256,
      },
      { field: 'file', filename: 'report.txt', contentType: 'text/plain', body: 'artifact body' },
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/artifacts/upload',
      headers: { 'content-type': multipart.contentType },
      payload: multipart.body,
    });

    expect(response.statusCode).toBe(201);
    expect(repository.saveArtifact).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'eval_report',
      metadata: { suite: 'smoke' },
      sha256,
      sizeBytes: 13,
    }));
    expect(response.json()).toMatchObject({
      kind: 'eval_report',
      metadata: { suite: 'smoke' },
      sha256,
    });
    expect(emit).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith('artifact.created', expect.objectContaining({
      kind: 'eval_report',
      sizeBytes: 13,
      sha256,
    }));
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
      sizeBytes: 13,
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

  it('hides deleted tombstones from reads and repeated deletes', async () => {
    const artifact = {
      id: 'artifact-1',
      agentId: 'agent-1',
      turnId: null,
      conversationId: null,
      name: 'report.txt',
      mimeType: 'text/plain',
      sizeBytes: 12,
      storageKey: 'artifacts/artifact-1/report.txt',
      bucket: 'artifacts',
      kind: null,
      metadata: null,
      sha256: null,
      status: 'deleted',
      expiresAt: null,
      createdAt: 1,
      updatedAt: 2,
    };
    const repository = {
      getArtifact: vi.fn().mockResolvedValue(artifact),
      markArtifactDeleting: vi.fn().mockResolvedValue({ ...artifact, status: 'deleting' }),
      deleteArtifact: vi.fn().mockResolvedValue(artifact),
    };
    const artifactStore = {
      deleteObject: vi.fn().mockResolvedValue(undefined),
    };
    const app = await createApp(repository, artifactStore);
    apps.push(app);

    const [readResponse, deleteResponse] = await Promise.all([
      app.inject({ method: 'GET', url: '/api/artifacts/artifact-1' }),
      app.inject({ method: 'DELETE', url: '/api/artifacts/artifact-1' }),
    ]);

    expect(readResponse.statusCode).toBe(404);
    expect(deleteResponse.statusCode).toBe(404);
    expect(repository.markArtifactDeleting).not.toHaveBeenCalled();
    expect(repository.deleteArtifact).not.toHaveBeenCalled();
    expect(artifactStore.deleteObject).not.toHaveBeenCalled();
  });
});
