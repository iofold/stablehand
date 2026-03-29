import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ArtifactStore } from '../../artifact/artifact-store.js';
import type { DatabaseRepository } from '../../database/repository.js';

export interface ArtifactRouteOptions {
  artifactStore: ArtifactStore;
  repository: DatabaseRepository;
  /** S3 bucket name used when pre-registering artifacts (must match ArtifactStore's bucket). */
  bucket: string;
}

export async function artifactRoutes(
  app: FastifyInstance,
  opts: ArtifactRouteOptions,
): Promise<void> {
  const { artifactStore, repository, bucket } = opts;

  app.get('/', async (req, reply) => {
    const { agentId, runId, limit, offset } = req.query as {
      agentId?: string;
      runId?: string;
      limit?: string;
      offset?: string;
    };

    if (!agentId) {
      return reply.status(400).send({ error: 'agentId query parameter is required' });
    }

    if (runId) {
      const artifacts = await repository.listArtifactsForRun(runId);
      return reply.send({ artifacts });
    }

    const artifacts = await repository.listArtifactsForAgent(
      agentId,
      Number(limit) || 100,
      Number(offset) || 0,
    );
    return reply.send({ artifacts });
  });

  app.get('/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const artifact = await repository.getArtifact(id);
    if (!artifact) {
      return reply.status(404).send({ error: 'Artifact not found' });
    }
    return reply.send({ artifact });
  });

  app.get('/:id/download-url', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { expiresIn } = req.query as { expiresIn?: string };

    const artifact = await repository.getArtifact(id);
    if (!artifact) {
      return reply.status(404).send({ error: 'Artifact not found' });
    }

    const ttl = Math.min(Number(expiresIn) || 3600, 86400);
    const url = await artifactStore.getSignedDownloadUrl(artifact.storageKey, ttl);

    return reply.send({
      url,
      expiresIn: ttl,
      name: artifact.name,
      mimeType: artifact.mimeType,
      sizeBytes: artifact.sizeBytes,
    });
  });

  app.post('/upload-url', async (req, reply) => {
    const body = req.body as {
      agentId?: string;
      name?: string;
      mimeType?: string;
      sizeBytes?: number;
    };

    if (!body?.agentId || !body.name || !body.mimeType) {
      return reply.status(400).send({ error: 'agentId, name, and mimeType are required' });
    }

    const artifactId = randomUUID();
    const storageKey = `${body.agentId}/${artifactId}/${body.name}`;
    const ttl = 3600;

    const uploadUrl = await artifactStore.getSignedUploadUrl(storageKey, body.mimeType, ttl);

    // Pre-register the artifact in DB so callers can reference it by ID immediately
    await repository.saveArtifact({
      id: artifactId,
      agentId: body.agentId,
      name: body.name,
      mimeType: body.mimeType,
      sizeBytes: body.sizeBytes ?? 0,
      storageKey,
      bucket,
      status: 'active',
    });

    return reply.send({
      artifactId,
      uploadUrl,
      storageKey,
      expiresIn: ttl,
    });
  });

  app.delete('/:id', async (req, reply) => {
    const { id } = req.params as { id: string };

    const artifact = await repository.getArtifact(id);
    if (!artifact) {
      return reply.status(404).send({ error: 'Artifact not found' });
    }

    if (artifactStore) {
      try {
        await artifactStore.deleteObject(artifact.storageKey);
      } catch (err) {
        app.log.warn('Failed to delete S3 object %s: %s', artifact.storageKey, err);
      }
    }

    await repository.deleteArtifact(id);
    return reply.send({ deleted: true, id });
  });
}
