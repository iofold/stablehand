import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { digestWorkspace } from '../../../workspace/digest.js';
import { validateAndExtractTarball } from '../../../workspace/tar-upload.js';
import { isBlockedPath, resolveWorkspaceTarget } from '../agent-helpers.js';
import { chownRecursive, getRequestAgent, safeError } from './helpers.js';
import type { AgentSubRouteOptions } from './types.js';

export async function fileRoutes(
  app: FastifyInstance,
  opts: AgentSubRouteOptions,
): Promise<void> {
  const { db, dataDir, sessionManager, settingsService, loadAgent } = opts;

  const toWorkspaceRevision = (state: {
    revision: number;
    sha256: string;
    fileCount: number;
    totalBytes: number;
    appliedAt: number;
  }): {
    revision: number;
    sha256: string;
    fileCount: number;
    totalBytes: number;
    appliedAt: number;
  } => ({
    revision: state.revision,
    sha256: state.sha256,
    fileCount: state.fileCount,
    totalBytes: state.totalBytes,
    appliedAt: state.appliedAt,
  });

  app.get(
    '/:id/files',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Querystring: { path?: string; conversationId?: string };
      }>,
      reply: FastifyReply,
    ) => {
      const query = request.query as { path?: string; conversationId?: string };
      const requestedPath = query.path || '.';
      const resolvedTarget = await resolveWorkspaceTarget(request, reply, { db, dataDir }, requestedPath);
      if (!resolvedTarget) return;
      const targetDir = resolvedTarget.target;

      try {
        const dirEntries = await readdir(targetDir, { withFileTypes: true });
        const entries = await Promise.all(
          dirEntries
            .filter((entry) => !entry.name.startsWith('.') && entry.name !== 'node_modules' && !isBlockedPath(entry.name))
            .map(async (entry) => {
              const entryPath = join(targetDir, entry.name);
              let size = 0;
              try {
                const entryStat = await stat(entryPath);
                size = entryStat.size;
              } catch (err) {
                request.log.warn({ err }, 'Failed to stat file');
              }
              return {
                name: entry.name,
                type: entry.isDirectory() ? ('directory' as const) : ('file' as const),
                size,
              };
            }),
        );

        return reply.send({ entries });
      } catch (err) {
        return reply.status(400).send(safeError('Cannot read directory', err));
      }
    },
  );

  app.get(
    '/:id/files/read',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Querystring: { path?: string; conversationId?: string };
      }>,
      reply: FastifyReply,
    ) => {
      const query = request.query as { path?: string; conversationId?: string };

      if (!query.path) {
        return reply.status(400).send({ error: 'path query parameter is required' });
      }

      const resolvedTarget = await resolveWorkspaceTarget(request, reply, { db, dataDir }, query.path);
      if (!resolvedTarget) return;
      const targetFile = resolvedTarget.target;

      try {
        const fileStat = await stat(targetFile);

        if (fileStat.isDirectory()) {
          return reply.status(400).send({ error: 'Path is a directory, not a file' });
        }

        if (fileStat.size > 50 * 1024) {
          return reply.status(400).send({
            error: 'File too large',
            size: fileStat.size,
            maxSize: 50 * 1024,
          });
        }

        const content = await readFile(targetFile, 'utf-8');
        return reply.send({
          path: query.path,
          content,
          size: fileStat.size,
        });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return reply.status(404).send({ error: 'File not found' });
        }
        return reply.status(400).send(safeError('Cannot read file', err));
      }
    },
  );

  app.post(
    '/:id/files',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Querystring: { conversationId?: string };
        Body: { path: string; content: string };
      }>,
      reply: FastifyReply,
    ) => {
      const body = request.body as { path?: string; content?: string };

      if (!body.path || typeof body.content !== 'string') {
        return reply.status(400).send({ error: 'path and content are required' });
      }

      const resolvedTarget = await resolveWorkspaceTarget(request, reply, { db, dataDir }, body.path);
      if (!resolvedTarget) return;
      const targetFile = resolvedTarget.target;

      try {
        await mkdir(dirname(targetFile), { recursive: true });
        await writeFile(targetFile, body.content, 'utf-8');
        const fileStat = await stat(targetFile);
        return reply.status(201).send({ path: body.path, size: fileStat.size });
      } catch (err) {
        return reply.status(400).send(safeError('Cannot create file', err));
      }
    },
  );

  app.put(
    '/:id/files',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Querystring: { conversationId?: string };
        Body: { path: string; content: string };
      }>,
      reply: FastifyReply,
    ) => {
      const body = request.body as { path?: string; content?: string };

      if (!body.path || typeof body.content !== 'string') {
        return reply.status(400).send({ error: 'path and content are required' });
      }

      const resolvedTarget = await resolveWorkspaceTarget(request, reply, { db, dataDir }, body.path);
      if (!resolvedTarget) return;
      const targetFile = resolvedTarget.target;

      try {
        const fileStat = await stat(targetFile);
        if (fileStat.isDirectory()) {
          return reply.status(400).send({ error: 'Path is a directory, not a file' });
        }

        await writeFile(targetFile, body.content, 'utf-8');
        const updatedStat = await stat(targetFile);
        return reply.send({ path: body.path, size: updatedStat.size });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return reply.status(404).send({ error: 'File not found' });
        }
        return reply.status(400).send(safeError('Cannot update file', err));
      }
    },
  );

  app.delete(
    '/:id/files',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Querystring: { path?: string; conversationId?: string };
      }>,
      reply: FastifyReply,
    ) => {
      const query = request.query as { path?: string; conversationId?: string };

      if (!query.path) {
        return reply.status(400).send({ error: 'path query parameter is required' });
      }

      const resolvedTarget = await resolveWorkspaceTarget(request, reply, { db, dataDir }, query.path);
      if (!resolvedTarget) return;
      const targetFile = resolvedTarget.target;

      try {
        const fileStat = await stat(targetFile);
        if (fileStat.isDirectory()) {
          return reply.status(400).send({ error: 'Path is a directory, not a file' });
        }

        await unlink(targetFile);
        return reply.status(204).send();
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return reply.status(404).send({ error: 'File not found' });
        }
        return reply.status(400).send(safeError('Cannot delete file', err));
      }
    },
  );

  app.get(
    '/:id/workspace',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const state = await db.getAgentWorkspaceState(request.params.id);
      if (!state) {
        return reply.status(404).send({
          error: 'Workspace revision not found',
          code: 'workspace_revision_not_found',
        });
      }
      return reply.send(toWorkspaceRevision(state));
    },
  );

  app.post(
    '/:id/workspace',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{ Params: { id: string }; Querystring: { force?: string } }>,
      reply: FastifyReply,
    ) => {
      const agent = getRequestAgent(request);

      if (!agent.workspaceDir) {
        return reply.status(400).send({ error: 'Agent has no workspace configured' });
      }

      const contentType = request.headers['content-type'] ?? '';
      if (!contentType.includes('application/gzip') && !contentType.includes('application/x-gzip')) {
        return reply.status(415).send({ error: 'Content-Type must be application/gzip' });
      }

      try {
        const allSandboxSessions = await db.getActiveSandboxSessions();
        const agentSandboxSessions = allSandboxSessions.filter(
          (sandboxSession) => sandboxSession.agentId === agent.id,
        );

        if (agentSandboxSessions.length > 0) {
          const force = request.query.force === 'true';
          if (!force) {
            return reply.status(409).send({
              error: 'Agent has active sandbox sessions. Kill them first or use ?force=true',
              activeSandboxSessions: agentSandboxSessions.map((sandboxSession) => sandboxSession.id),
            });
          }

          if (sessionManager) {
            for (const sandboxSession of agentSandboxSessions) {
              try {
                await sessionManager.killSession(sandboxSession.id);
              } catch (err) {
                console.error(
                  `[agents] failed to kill sandbox session ${sandboxSession.id} during force upload:`,
                  err,
                );
              }
            }
          }
        }
      } catch (err) {
        return reply.status(500).send(safeError('Failed to check active sandbox sessions', err));
      }

      const baseDir = agent.workspaceDir;
      const tempDir = await mkdtemp(join(dirname(baseDir), '.upload-'));
      try {
        const maxTarBytes = settingsService
          ? (await settingsService.getAll()).maxTarUploadBytes
          : undefined;
        const result = await validateAndExtractTarball(request.raw, tempDir, {
          maxBytes: maxTarBytes,
        });

        const oldDir = `${baseDir}.old-${randomUUID()}`;
        const baseExists = await stat(baseDir).then(() => true, () => false);
        const digest = await digestWorkspace(tempDir);
        if (digest.fileCount !== result.files || digest.totalBytes !== result.totalBytes) {
          throw new Error(
            'Extracted workspace accounting did not match the applied filesystem',
          );
        }

        await chownRecursive(tempDir, 1000, 1000);
        if (baseExists) {
          await rename(baseDir, oldDir);
        }

        let workspaceSwapped = false;
        try {
          await rename(tempDir, baseDir);
          workspaceSwapped = true;

          const appliedAt = Date.now();
          const state = await db.recordAgentWorkspaceRevision(agent.id, {
            ...digest,
            appliedAt,
          });

          // The revision row is the commit point. Backup cleanup is best
          // effort and cannot make an applied deployment fail afterwards.
          await rm(oldDir, { recursive: true, force: true }).catch((cleanupError: unknown) => {
            request.log.warn({ err: cleanupError, oldDir }, 'Failed to remove old workspace backup');
          });

          return reply.status(201).send(toWorkspaceRevision(state));
        } catch (swapError) {
          if (workspaceSwapped) {
            await rm(baseDir, { recursive: true, force: true });
          }
          if (baseExists) {
            await rename(oldDir, baseDir);
          }
          throw swapError;
        }
      } catch (err) {
        await rm(tempDir, { recursive: true, force: true });

        if (err instanceof Error && err.message.includes('size exceeds')) {
          return reply.status(413).send({ error: err.message });
        }
        return reply.status(400).send(safeError('Failed to extract workspace tarball', err));
      }
    },
  );
}
