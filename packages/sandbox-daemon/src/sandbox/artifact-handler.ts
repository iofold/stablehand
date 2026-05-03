import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, relative, resolve } from 'node:path';
import { create } from '@bufbuild/protobuf';
import {
  ArtifactMetaSchema,
  RegisterArtifactRequestSchema,
  ResolveArtifactRequestSchema,
} from '@ctxmill/proto/sandbox/v1';

import { ArtifactStore } from '../artifact/artifact-store.js';
import { stringifyJsonWithBigInts } from './json-serialization.js';
import type { OrchestratorServiceClient } from './tool-proxy.js';

interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface ArtifactHandlerDeps {
  artifactStore: ArtifactStore;
  orchestratorClient: OrchestratorServiceClient;
  sessionId: string | { current: string };
  agentId: string;
  workspaceDir: string;
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

const _maxSizeMb = Number(process.env.CTXMILL_MAX_ARTIFACT_SIZE_MB ?? 100);
const MAX_ARTIFACT_SIZE_BYTES = (Number.isFinite(_maxSizeMb) && _maxSizeMb > 0 ? _maxSizeMb : 100) * 1024 * 1024;

function buildArtifactStorageKey(artifactId: string, name: string): string {
  const safeName = name.trim().replace(/[/\\]+/g, '_') || 'artifact';
  return `artifacts/${artifactId}/${safeName}`;
}

function detectMimeType(filename: string): string {
  const ext = extname(filename).toLowerCase();
  return MIME_TYPES[ext] ?? 'application/octet-stream';
}

function getEffectiveSessionId(sessionId: string | { current: string }): string {
  return typeof sessionId === 'string' ? sessionId : sessionId.current;
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
  const { artifactStore, orchestratorClient, sessionId, agentId, workspaceDir, logger: maybeLogger } = deps;
  const logger = maybeLogger ?? console;
  const handlers = new Map<string, (input: unknown) => Promise<string>>();

  handlers.set('artifact_upload', async (rawInput: unknown) => {
    const input = rawInput as {
      path?: string;
      name?: string;
      mimeType?: string;
      metadata?: Record<string, unknown>;
    };

    if (!input.path) {
      return stringifyJsonWithBigInts({ error: 'path is required' });
    }

    const fullPath = resolveWorkspacePath(workspaceDir, input.path);
    if (!fullPath) {
      return stringifyJsonWithBigInts({ error: `Path must be within workspace: ${workspaceDir}` });
    }

    try {
      const fileBuffer = await readFile(fullPath);
      if (fileBuffer.byteLength > MAX_ARTIFACT_SIZE_BYTES) {
        return stringifyJsonWithBigInts({
          error: `File exceeds max artifact size: ${fileBuffer.byteLength} bytes > ${MAX_ARTIFACT_SIZE_BYTES} bytes`,
        });
      }

      const filename = input.name ?? basename(fullPath);
      const mimeType = input.mimeType ?? detectMimeType(fullPath);
      const artifactId = randomUUID();
      const effectiveSessionId = getEffectiveSessionId(sessionId);
      const storageKey = buildArtifactStorageKey(artifactId, filename);

      await artifactStore.upload(storageKey, fileBuffer, mimeType);
      logger.info(`[artifact] uploaded ${storageKey} (${fileBuffer.byteLength} bytes)`);

      let response: Awaited<ReturnType<OrchestratorServiceClient['registerArtifact']>>;
      try {
        response = await orchestratorClient.registerArtifact(
          create(RegisterArtifactRequestSchema, {
            sessionId: effectiveSessionId,
            agentId,
            artifact: create(ArtifactMetaSchema, {
              id: artifactId,
              agentId,
              sessionId: effectiveSessionId,
              name: filename,
              mimeType,
              sizeBytes: BigInt(fileBuffer.byteLength),
              storageKey,
              bucket: artifactStore.getBucket(),
              metadataJson: input.metadata ? stringifyJsonWithBigInts(input.metadata) : '',
              createdAt: BigInt(Date.now()),
            }),
          }),
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
        sizeBytes: fileBuffer.byteLength,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('[artifact] upload failed:', error);
      return stringifyJsonWithBigInts({ error: `Upload failed: ${message}` });
    }
  });

  handlers.set('artifact_download', async (rawInput: unknown) => {
    const input = rawInput as { artifactId?: string; path?: string };

    if (!input.artifactId) {
      return stringifyJsonWithBigInts({ error: 'artifactId is required' });
    }

    try {
      const response = await orchestratorClient.resolveArtifact(
        create(ResolveArtifactRequestSchema, {
          artifactId: input.artifactId,
          agentId,
        }),
      );

      if (response.error || !response.artifact) {
        return stringifyJsonWithBigInts({ error: response.error || 'Artifact not found' });
      }

      const artifact = response.artifact;
      const { body, contentType } = await artifactStore.download(artifact.storageKey);
      logger.info(`[artifact] downloaded ${artifact.storageKey} (${body.byteLength} bytes)`);

      const destination = input.path ?? artifact.name;
      const fullPath = resolveWorkspacePath(workspaceDir, destination);
      if (!fullPath) {
        return stringifyJsonWithBigInts({ error: `Path must be within workspace: ${workspaceDir}` });
      }

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
