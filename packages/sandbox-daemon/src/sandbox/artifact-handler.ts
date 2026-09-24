import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, relative, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { create } from '@bufbuild/protobuf';
import { ArtifactKindSchema, ArtifactMetadataSchema } from '@stablehand/contracts';
import {
  ArtifactMetaSchema,
  RegisterArtifactRequestSchema,
  ResolveArtifactRequestSchema,
} from '@stablehand/proto/sandbox/v1';

import { ArtifactStore } from '../artifact/artifact-store.js';
import { stringifyJsonWithBigInts } from './json-serialization.js';
import {
  assertTurnDeliveryContextCurrent,
  requireTurnDeliveryContext,
  snapshotTurnDeliveryCapability,
  type TurnDeliveryContext,
} from './turn-delivery-context.js';
import type { OrchestratorServiceClient } from './tool-proxy.js';

interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface ArtifactHandlerDeps {
  artifactStore: ArtifactStore;
  orchestratorClient: OrchestratorServiceClient;
  sandboxSessionId: string;
  agentId: string;
  workspaceDir: string;
  resolveDeliveryContext?: () => TurnDeliveryContext;
  logger?: Logger;
}

const MIME_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.html': 'text/html',
  '.xml': 'application/xml',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

const _maxSizeMb = Number(process.env.STABLEHAND_MAX_ARTIFACT_SIZE_MB ?? 100);
const MAX_ARTIFACT_SIZE_BYTES = (Number.isFinite(_maxSizeMb) && _maxSizeMb > 0 ? _maxSizeMb : 100) * 1024 * 1024;
/** Files at or below this size upload as retry-safe buffers instead of streams. */
const BUFFERED_UPLOAD_MAX_BYTES = 32 * 1024 * 1024;

function buildArtifactStorageKey(artifactId: string, name: string): string {
  const safeName = name.trim().replace(/[/\\]+/g, '_') || 'artifact';
  return `artifacts/${artifactId}/${safeName}`;
}

function detectMimeType(filename: string): string {
  const ext = extname(filename).toLowerCase();
  return MIME_TYPES[ext] ?? 'application/octet-stream';
}

function resolveWorkspacePath(workspaceDir: string, requestedPath: string): string | null {
  const resolvedWorkspaceDir = resolve(workspaceDir);
  const resolvedPath = resolve(resolvedWorkspaceDir, requestedPath);
  const relativePath = relative(resolvedWorkspaceDir, resolvedPath);

  if (relativePath === '..' || relativePath.startsWith('../') || relativePath.startsWith('..\\')) {
    return null;
  }

  return resolvedPath;
}

export function createArtifactHandlers(deps: ArtifactHandlerDeps): Map<string, (input: unknown) => Promise<string>> {
  const {
    artifactStore,
    orchestratorClient,
    sandboxSessionId,
    agentId,
    workspaceDir,
    resolveDeliveryContext,
    logger: maybeLogger,
  } = deps;
  const logger = maybeLogger ?? console;
  const handlers = new Map<string, (input: unknown) => Promise<string>>();

  handlers.set('artifact_upload', async (rawInput: unknown) => {
    const deliveryContext = resolveDeliveryContext?.()
      ?? requireTurnDeliveryContext({ sandboxSessionId, agentId });
    const input = rawInput as {
      path?: string;
      name?: string;
      mimeType?: string;
      kind?: string;
      metadata?: Record<string, unknown>;
    };

    if (!input.path) {
      return stringifyJsonWithBigInts({ error: 'path is required' });
    }
    const kind = input.kind === undefined
      ? undefined
      : ArtifactKindSchema.safeParse(input.kind);
    if (kind && !kind.success) {
      return stringifyJsonWithBigInts({
        error: 'kind must match ^[a-z0-9][a-z0-9_-]{0,63}$',
      });
    }
    const metadata = input.metadata === undefined
      ? undefined
      : ArtifactMetadataSchema.safeParse(input.metadata);
    if (metadata && !metadata.success) {
      return stringifyJsonWithBigInts({
        error: 'metadata must be a JSON object no larger than 16384 serialized bytes',
      });
    }

    const fullPath = resolveWorkspacePath(workspaceDir, input.path);
    if (!fullPath) {
      return stringifyJsonWithBigInts({ error: `Path must be within workspace: ${workspaceDir}` });
    }

    try {
      const fileStats = await stat(fullPath);
      if (!fileStats.isFile()) {
        return stringifyJsonWithBigInts({ error: `Path is not a regular file: ${input.path}` });
      }
      if (fileStats.size > MAX_ARTIFACT_SIZE_BYTES) {
        return stringifyJsonWithBigInts({
          error: `File exceeds max artifact size: ${fileStats.size} bytes > ${MAX_ARTIFACT_SIZE_BYTES} bytes`,
        });
      }

      const filename = input.name ?? basename(fullPath);
      const mimeType = input.mimeType ?? detectMimeType(fullPath);
      const artifactId = randomUUID();
      const effectiveTurnId = deliveryContext.identity.turnId;
      const storageKey = buildArtifactStorageKey(artifactId, filename);

      assertTurnDeliveryContextCurrent(deliveryContext);
      const contentHash = createHash('sha256');
      let streamedBytes = 0;
      if (fileStats.size <= BUFFERED_UPLOAD_MAX_BYTES) {
        // Buffered path: a Readable body is not retry-safe in the S3 client —
        // a transient failure drains the stream, and the retry then sends an
        // empty body against the original Content-Length ("You did not
        // provide the number of bytes specified by the Content-Length
        // header"). Buffers retry cleanly.
        const bytes = await readFile(fullPath);
        streamedBytes = bytes.byteLength;
        if (streamedBytes > MAX_ARTIFACT_SIZE_BYTES) {
          return stringifyJsonWithBigInts({
            error: `File exceeds max artifact size: ${streamedBytes} bytes > ${MAX_ARTIFACT_SIZE_BYTES} bytes`,
          });
        }
        contentHash.update(bytes);
        await artifactStore.upload(storageKey, bytes, mimeType, streamedBytes);
      } else {
        const hashingStream = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            streamedBytes += chunk.byteLength;
            if (streamedBytes > MAX_ARTIFACT_SIZE_BYTES) {
              callback(new Error(
                `File exceeds max artifact size while streaming: ${streamedBytes} bytes > ${MAX_ARTIFACT_SIZE_BYTES} bytes`,
              ));
              return;
            }
            contentHash.update(chunk);
            callback(null, chunk);
          },
        });
        await artifactStore.upload(
          storageKey,
          createReadStream(fullPath).pipe(hashingStream),
          mimeType,
          fileStats.size,
        );
      }
      const sha256 = contentHash.digest('hex');
      logger.info(`[artifact] uploaded ${storageKey} (${streamedBytes} bytes)`);

      let response: Awaited<ReturnType<OrchestratorServiceClient['registerArtifact']>>;
      try {
        response = await orchestratorClient.registerArtifact(
          create(RegisterArtifactRequestSchema, {
            turnId: effectiveTurnId,
            sandboxSessionId: deliveryContext.identity.sandboxSessionId,
            agentId: deliveryContext.identity.agentId,
            deliveryCapability: snapshotTurnDeliveryCapability(deliveryContext),
            artifact: create(ArtifactMetaSchema, {
              id: artifactId,
              agentId: deliveryContext.identity.agentId,
              turnId: effectiveTurnId,
              name: filename,
              mimeType,
              sizeBytes: BigInt(streamedBytes),
              storageKey,
              bucket: artifactStore.getBucket(),
              metadataJson: metadata?.success ? stringifyJsonWithBigInts(metadata.data) : '',
              createdAt: BigInt(Date.now()),
              kind: kind?.success ? kind.data : '',
              sha256,
            }),
          }),
          { signal: deliveryContext.abortController.signal },
        );
      } catch (rpcErr) {
        try {
          await artifactStore.deleteObject(storageKey);
        } catch (cleanupErr) {
          logger.warn('[artifact] failed to delete artifact after metadata registration error', cleanupErr);
        }
        throw rpcErr;
      }

      if (response.error) {
        try {
          await artifactStore.deleteObject(storageKey);
        } catch (cleanupErr) {
          logger.warn('[artifact] failed to delete artifact after metadata registration error response', cleanupErr);
        }
        return stringifyJsonWithBigInts({ error: `Upload failed: ${response.error}` });
      }

      return stringifyJsonWithBigInts({
        artifactId: response.artifactId || artifactId,
        name: filename,
        mimeType,
        sizeBytes: streamedBytes,
        sha256,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('[artifact] upload failed:', error);
      return stringifyJsonWithBigInts({ error: `Upload failed: ${message}` });
    }
  });

  handlers.set('artifact_download', async (rawInput: unknown) => {
    const deliveryContext = resolveDeliveryContext?.()
      ?? requireTurnDeliveryContext({ sandboxSessionId, agentId });
    const input = rawInput as { artifactId?: string; path?: string };

    if (!input.artifactId) {
      return stringifyJsonWithBigInts({ error: 'artifactId is required' });
    }

    try {
      const response = await orchestratorClient.resolveArtifact(
        create(ResolveArtifactRequestSchema, {
          artifactId: input.artifactId,
          agentId: deliveryContext.identity.agentId,
          turnId: deliveryContext.identity.turnId,
          sandboxSessionId: deliveryContext.identity.sandboxSessionId,
          deliveryCapability: snapshotTurnDeliveryCapability(deliveryContext),
        }),
        { signal: deliveryContext.abortController.signal },
      );

      if (response.error || !response.artifact) {
        return stringifyJsonWithBigInts({ error: response.error || 'Artifact not found' });
      }

      const artifact = response.artifact;
      assertTurnDeliveryContextCurrent(deliveryContext);
      const { body, contentType } = await artifactStore.download(artifact.storageKey);
      logger.info(`[artifact] downloaded ${artifact.storageKey} (${body.byteLength} bytes)`);

      const destination = input.path ?? artifact.name;
      const fullPath = resolveWorkspacePath(workspaceDir, destination);
      if (!fullPath) {
        return stringifyJsonWithBigInts({ error: `Path must be within workspace: ${workspaceDir}` });
      }

      assertTurnDeliveryContextCurrent(deliveryContext);
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, body);

      return stringifyJsonWithBigInts({
        path: fullPath,
        name: artifact.name,
        mimeType: contentType || artifact.mimeType,
        sizeBytes: body.byteLength,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('[artifact] download failed:', error);
      return stringifyJsonWithBigInts({ error: `Download failed: ${message}` });
    }
  });

  return handlers;
}
