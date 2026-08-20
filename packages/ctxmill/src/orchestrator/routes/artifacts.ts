import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ArtifactStore } from '../../artifact/artifact-store.js';
import type { DatabaseRepository } from '../../database/repository.js';
import type { TypedEventBus } from '../../events/bus.js';
import { ArtifactRegistrationService } from '../../artifact/registration-service.js';
import { validateArtifactRegistrationFields } from '../../artifact/validation.js';
import { ArtifactListResponseSchema, ArtifactSchema } from '@ctxmill/contracts';

export interface ArtifactRouteOptions {
  artifactStore: ArtifactStore;
  repository: DatabaseRepository;
  /** S3 bucket name used when pre-registering artifacts (must match ArtifactStore's bucket). */
  bucket: string;
  eventBus?: TypedEventBus;
  registrationService?: ArtifactRegistrationService;
}

function buildArtifactStorageKey(artifactId: string, name: string): string {
  const safeName = name.trim().replace(/[/\\]+/g, '_') || 'artifact';
  return `artifacts/${artifactId}/${safeName}`;
}

export async function artifactRoutes(
  app: FastifyInstance,
  opts: ArtifactRouteOptions,
): Promise<void> {
  const { artifactStore, repository, bucket, eventBus } = opts;
  const registrationService = opts.registrationService
    ?? new ArtifactRegistrationService({ repository, eventBus });

  // ctx-k6ad: mirror the gRPC no-oracle rule (orchestrator-service.ts:701).
  // A key scoped to an agent may only reach that agent's artifacts; unowned
  // rows (agentId null) stay resolvable; a cross-agent hit resolves to
  // undefined so callers report 404 rather than leaking existence.
  const visibleToBound = (
    artifactAgentId: string | null | undefined,
    boundAgentId: string | null,
  ): boolean => !boundAgentId || !artifactAgentId || artifactAgentId === boundAgentId;

  const resolveArtifactForRead = async (id: string, boundAgentId: string | null) => {
    const artifact = await repository.getArtifact(id);
    if (!artifact || artifact.status === 'deleted') return undefined;
    if (!visibleToBound(artifact.agentId, boundAgentId)) return undefined;
    if (artifact.status !== 'pending_upload') {
      return artifact;
    }

    const head = await artifactStore.headObject(artifact.storageKey);
    if (!head) {
      return artifact;
    }

    return await repository.markArtifactUploadConfirmed(id, {
      sizeBytes: head.sizeBytes,
      mimeType: head.contentType,
    }) ?? artifact;
  };

  app.get('/', { config: { capability: 'artifacts:read' } }, async (req, reply) => {
    const { agentId, turnId, limit, offset, search } = req.query as {
      agentId?: string;
      turnId?: string;
      limit?: string;
      offset?: string;
      search?: string;
    };
    const boundAgentId = req.apiPrincipal?.agentId ?? null;

    if (turnId) {
      const artifacts = await repository.listArtifactsForTurn(turnId);
      // ctx-k6ad: a scoped key sees only its agent's (and unowned) rows.
      const visible = boundAgentId
        ? artifacts.filter((a) => visibleToBound(a.agentId, boundAgentId))
        : artifacts;
      return reply.send(ArtifactListResponseSchema.parse({ artifacts: visible, total: visible.length }));
    }

    // ctx-k6ad: a scoped key is pinned to its own agent; the query param is
    // ignored so it can neither enumerate all agents nor target another.
    const effectiveAgentId = boundAgentId ?? agentId;

    if (!effectiveAgentId) {
      const result = await repository.listAllArtifacts(
        Number(limit) || 100,
        Number(offset) || 0,
        search,
      );
      return reply.send(ArtifactListResponseSchema.parse(result));
    }

    const artifacts = await repository.listArtifactsForAgent(
      effectiveAgentId,
      Number(limit) || 100,
      Number(offset) || 0,
    );
    return reply.send(ArtifactListResponseSchema.parse({ artifacts, total: artifacts.length }));
  });

  app.get('/:id', { config: { capability: 'artifacts:read' } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const boundAgentId = req.apiPrincipal?.agentId ?? null;
    const artifact = await repository.getArtifact(id);
    if (
      !artifact
      || artifact.status === 'deleted'
      || !visibleToBound(artifact.agentId, boundAgentId)
    ) {
      return reply.status(404).send({ error: 'Artifact not found' });
    }
    // ctx-iqzy S10: the entity route emits exactly the contract shape.
    return reply.send(ArtifactSchema.parse(artifact));
  });

  app.get('/:id/download', { config: { capability: 'artifacts:read' } }, async (req, reply) => {
    const { id } = req.params as { id: string };

    const artifact = await resolveArtifactForRead(id, req.apiPrincipal?.agentId ?? null);
    if (!artifact) {
      return reply.status(404).send({ error: 'Artifact not found' });
    }

    if (artifact.status !== 'active') {
      return reply.status(409).send({ error: 'Artifact upload is not confirmed', status: artifact.status });
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

  app.get('/:id/download-url', { config: { capability: 'artifacts:read' } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { expiresInSec } = req.query as { expiresInSec?: string };

    const artifact = await resolveArtifactForRead(id, req.apiPrincipal?.agentId ?? null);
    if (!artifact) {
      return reply.status(404).send({ error: 'Artifact not found' });
    }

    if (artifact.status !== 'active') {
      return reply.status(409).send({ error: 'Artifact upload is not confirmed', status: artifact.status });
    }

    const ttl = Math.min(Number(expiresInSec) || 3600, 86400);
    const url = await artifactStore.getSignedDownloadUrl(artifact.storageKey, ttl);

    return reply.send({
      url,
      expiresInSec: ttl,
      name: artifact.name,
      mimeType: artifact.mimeType,
      sizeBytes: artifact.sizeBytes,
    });
  });

  app.post('/upload-url', { config: { capability: 'artifacts:write' } }, async (req, reply) => {
    const body = req.body as {
      agentId?: string;
      name?: string;
      mimeType?: string;
      sizeBytes?: number;
      kind?: unknown;
      metadata?: unknown;
      sha256?: unknown;
    };

    // ctx-k6ad: a scoped key can only create artifacts for its own agent —
    // the caller-supplied agentId is overridden, never trusted.
    const boundAgentId = req.apiPrincipal?.agentId ?? null;
    const uploadAgentId = boundAgentId ?? body?.agentId;

    if (!uploadAgentId || !body.name || !body.mimeType) {
      return reply.status(400).send({ error: 'agentId, name, and mimeType are required' });
    }
    const registrationFields = validateArtifactRegistrationFields(body);
    if (!registrationFields.success) {
      return reply
        .status(registrationFields.reason === 'metadata_too_large' ? 413 : 400)
        .send({ error: registrationFields.error });
    }

    const artifactId = randomUUID();
    const storageKey = buildArtifactStorageKey(artifactId, body.name);
    const ttl = 3600;

    const uploadUrl = await artifactStore.getSignedUploadUrl(storageKey, body.mimeType, ttl);

    // Pre-register the artifact in DB so callers can reference it by ID immediately
    await registrationService.register({
      id: artifactId,
      agentId: uploadAgentId,
      name: body.name,
      mimeType: body.mimeType,
      sizeBytes: body.sizeBytes ?? 0,
      storageKey,
      bucket,
      status: 'pending_upload',
      expiresAt: Date.now() + ttl * 1000,
      ...(registrationFields.kind ? { kind: registrationFields.kind } : {}),
      ...(registrationFields.metadata ? { metadata: registrationFields.metadata } : {}),
      ...(registrationFields.sha256 ? { sha256: registrationFields.sha256 } : {}),
    });

    return reply.send({
      artifactId,
      uploadUrl,
      storageKey,
      expiresInSec: ttl,
    });
  });

  app.post('/upload', { config: { capability: 'artifacts:write' } }, async (req, reply) => {
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

    // ctx-k6ad: a scoped key can only create artifacts for its own agent —
    // the multipart agentId field is overridden, never trusted.
    const boundAgentId = req.apiPrincipal?.agentId ?? null;
    const agentId = boundAgentId ?? fields.agentId;
    const nameOverride = fields.name;

    const name = nameOverride || filename;
    const mimeType = mimetype;

    if (!agentId) {
      return reply.status(400).send({ error: 'agentId is required' });
    }
    if (!name) {
      return reply.status(400).send({ error: 'File name could not be determined' });
    }
    let metadata: unknown;
    if (fields.metadata !== undefined) {
      try {
        metadata = JSON.parse(fields.metadata) as unknown;
      } catch {
        return reply.status(400).send({ error: 'metadata must be valid JSON' });
      }
    }
    const registrationFields = validateArtifactRegistrationFields({
      kind: fields.kind,
      metadata,
      sha256: fields.sha256,
    });
    if (!registrationFields.success) {
      return reply
        .status(registrationFields.reason === 'metadata_too_large' ? 413 : 400)
        .send({ error: registrationFields.error });
    }

    const artifactId = randomUUID();
    const storageKey = buildArtifactStorageKey(artifactId, name);

    await registrationService.register({
      id: artifactId,
      agentId,
      name,
      mimeType,
      sizeBytes: fileBuffer.length,
      storageKey,
      bucket,
      status: 'pending_upload',
      ...(registrationFields.kind ? { kind: registrationFields.kind } : {}),
      ...(registrationFields.metadata ? { metadata: registrationFields.metadata } : {}),
      ...(registrationFields.sha256 ? { sha256: registrationFields.sha256 } : {}),
    });

    try {
      await artifactStore.upload(storageKey, fileBuffer, mimeType, fileBuffer.length);
    } catch (err) {
      await repository.markArtifactUploadFailed(artifactId);
      app.log.warn('Failed to upload artifact object %s: %s', storageKey, err);
      return reply.status(502).send({ error: 'Artifact object upload failed', artifactId });
    }

    const head = await artifactStore.headObject(storageKey);
    if (!head) {
      await repository.markArtifactUploadFailed(artifactId);
      await artifactStore.deleteObject(storageKey).catch((err) => {
        app.log.warn('Failed to clean up unconfirmed artifact object %s: %s', storageKey, err);
      });
      return reply.status(502).send({ error: 'Artifact object upload could not be confirmed', artifactId });
    }

    let artifact;
    try {
      artifact = await repository.markArtifactUploadConfirmed(artifactId, {
        sizeBytes: head.sizeBytes,
        mimeType: head.contentType,
      });
    } catch (err) {
      await artifactStore.deleteObject(storageKey).catch((cleanupErr) => {
        app.log.warn('Failed to clean up artifact object %s after DB activation failure: %s', storageKey, cleanupErr);
      });
      await repository.markArtifactUploadFailed(artifactId).catch((markErr) => {
        app.log.warn('Failed to mark artifact upload failed %s: %s', artifactId, markErr);
      });
      throw err;
    }

    if (!artifact) {
      await artifactStore.deleteObject(storageKey).catch((err) => {
        app.log.warn('Failed to clean up artifact object %s after missing DB activation row: %s', storageKey, err);
      });
      return reply.status(500).send({ error: 'Artifact metadata activation failed', artifactId });
    }

    // ctx-iqzy S10: the 201 body is the full artifact entity, not a subset.
    return reply.status(201).send(ArtifactSchema.parse(artifact));
  });

  app.delete('/:id', async (req, reply) => {
    const { id } = req.params as { id: string };

    const artifact = await resolveArtifactForRead(id, req.apiPrincipal?.agentId ?? null);
    if (!artifact) {
      return reply.status(404).send({ error: 'Artifact not found' });
    }

    const deleting = await repository.markArtifactDeleting(id);
    if (!deleting) {
      return reply.status(404).send({ error: 'Artifact not found' });
    }

    try {
      await artifactStore.deleteObject(artifact.storageKey);
    } catch (err) {
      app.log.warn('Failed to delete S3 object %s: %s', artifact.storageKey, err);
      await repository.markArtifactDeleteFailed(id);
      return reply.status(503).send({ error: 'Artifact object delete failed', artifactId: id });
    }

    await repository.deleteArtifact(id);
    // ctx-iqzy S20: first-class, webhook-subscribable lifecycle event
    // (artifact.created has been subscribable since WO-2; deletion was not).
    eventBus?.emit('artifact.deleted', {
      artifactId: id,
      agentId: artifact.agentId ?? null,
      timestamp: Date.now(),
    });
    // ctx-iqzy S16: hard deletes return 204, like agents and webhooks.
    return reply.status(204).send();
  });
}
