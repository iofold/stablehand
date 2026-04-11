import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ArtifactStore } from '../../artifact/artifact-store.js';
import type { DatabaseRepository } from '../../database/repository.js';
import type { TypedEventBus } from '../../events/bus.js';

export interface ArtifactRouteOptions {
  artifactStore: ArtifactStore;
  repository: DatabaseRepository;
  /** S3 bucket name used when pre-registering artifacts (must match ArtifactStore's bucket). */
  bucket: string;
  eventBus?: TypedEventBus;
}

export async function artifactRoutes(
  app: FastifyInstance,
  opts: ArtifactRouteOptions,
): Promise<void> {
  const { artifactStore, repository, bucket, eventBus } = opts;

  app.get('/', async (req, reply) => {
    const { agentId, sessionId, limit, offset } = req.query as {
      agentId?: string;
      sessionId?: string;
      limit?: string;
      offset?: string;
    };

    if (sessionId) {
      const artifacts = await repository.listArtifactsForSession(sessionId);
      return reply.send({ artifacts });
    }

    if (!agentId) {
      return reply.status(400).send({ error: 'agentId or sessionId is required' });
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
    return reply.send(artifact);
  });

  app.get('/:id/download', async (req, reply) => {
    const { id } = req.params as { id: string };

    const artifact = await repository.getArtifact(id);
    if (!artifact) {
      return reply.status(404).send({ error: 'Artifact not found' });
    }

    const { body, contentType } = await artifactStore.download(artifact.storageKey);

    return reply
      .header('Content-Type', contentType)
      .header(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent(artifact.name)}"`,
      )
      .header('Content-Length', body.length)
      .send(body);
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

    eventBus?.emit('custom', {
      type: 'artifact.created',
      agentId: body.agentId,
      payload: {
        artifactId,
        name: body.name,
        mimeType: body.mimeType,
        sizeBytes: body.sizeBytes ?? 0,
      },
      timestamp: Date.now(),
    });

    return reply.send({
      artifactId,
      uploadUrl,
      storageKey,
      expiresIn: ttl,
    });
  });

  app.post('/upload', async (req, reply) => {
    // Use req.parts() to iterate through all parts and collect fields + file
    const parts = req.parts();
    let fileBuffer: Buffer | null = null;
    let filename = '';
    let mimetype = 'application/octet-stream';
    const fields: Record<string, string> = {};

    for await (const part of parts) {
      if (part.type === 'file') {
        filename = part.filename || '';
        mimetype = part.mimetype || 'application/octet-stream';
        // Buffer the file stream
        const chunks: Buffer[] = [];
        for await (const chunk of part.file) {
          chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        }
        fileBuffer = Buffer.concat(chunks);
      } else if (part.type === 'field') {
        fields[part.fieldname] = String(part.value);
      }
    }

    if (!fileBuffer) {
      return reply.status(400).send({ error: 'No file provided' });
    }

    const agentId = fields.agentId;
    const nameOverride = fields.name;

    const name = nameOverride || filename;
    const mimeType = mimetype;

    if (!agentId) {
      return reply.status(400).send({ error: 'agentId is required' });
    }
    if (!name) {
      return reply.status(400).send({ error: 'File name could not be determined' });
    }

    const artifactId = randomUUID();
    const storageKey = `${agentId}/${artifactId}/${name}`;

    await artifactStore.upload(storageKey, fileBuffer, mimeType, fileBuffer.length);

    const head = await artifactStore.headObject(storageKey);
    const sizeBytes = head?.sizeBytes ?? 0;

    await repository.saveArtifact({
      id: artifactId,
      agentId,
      name,
      mimeType,
      sizeBytes,
      storageKey,
      bucket,
      status: 'active',
    });

    if (eventBus) {
      eventBus.emit('custom', {
        type: 'artifact.created',
        agentId,
        payload: {
          artifactId,
          name,
          mimeType,
          sizeBytes,
        },
        timestamp: Date.now(),
      });
    }

    return reply.status(201).send({
      id: artifactId,
      agentId,
      name,
      mimeType,
      sizeBytes,
      storageKey,
      bucket,
      status: 'active',
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
    eventBus?.emit('custom', {
      type: 'artifact.deleted',
      agentId: artifact.agentId,
      payload: { artifactId: id },
      timestamp: Date.now(),
    });
    return reply.send({ deleted: true, id });
  });
}
