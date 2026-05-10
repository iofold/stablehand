import { dirname, join, normalize, resolve } from 'node:path';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { validateAndExtractTarball } from '../../../workspace/tar-upload.js';
import { isBlockedPath, resolveBaseDir, validateSandboxPath } from '../agent-helpers.js';
import { chownRecursive, getRequestAgent, safeError } from './helpers.js';
import type { AgentSubRouteOptions } from './types.js';

export async function fileRoutes(
  app: FastifyInstance,
  opts: AgentSubRouteOptions,
): Promise<void> {
  const { db, dataDir, sessionManager, settingsService, loadAgent } = opts;

  app.get(
    '/:id/files',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Querystring: { path?: string; sessionId?: string };
      }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;
      const query = request.query as { path?: string; sessionId?: string };
      const agent = getRequestAgent(request);
      let conversationId: string | null | undefined;
      let sandboxSessionId: string | undefined;

      if (query.sessionId) {
        const run = await db.getTurn(query.sessionId);
        if (!run || run.agentId !== id) {
          return reply.status(404).send({ error: 'Session not found', sessionId: query.sessionId });
        }
        conversationId = run.conversationId;
        sandboxSessionId = run.sessionId ?? undefined;
      }

      const baseDir = resolveBaseDir(agent, {
        conversationId,
        sandboxSessionId,
        dataDir,
      });
      if (!baseDir) {
        return reply.status(500).send({ error: 'Agent has no workspace configured' });
      }
      const requestedPath = query.path || '.';

      const pathError = validateSandboxPath(baseDir, requestedPath);
      if (pathError) {
        return reply.status(pathError.status).send(pathError.body);
      }

      const targetDir = resolve(baseDir, normalize(requestedPath));

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
        Querystring: { path?: string; sessionId?: string };
      }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;
      const query = request.query as { path?: string; sessionId?: string };
      const agent = getRequestAgent(request);
      let conversationId: string | null | undefined;
      let sandboxSessionId: string | undefined;

      if (!query.path) {
        return reply.status(400).send({ error: 'path query parameter is required' });
      }

      if (query.sessionId) {
        const run = await db.getTurn(query.sessionId);
        if (!run || run.agentId !== id) {
          return reply.status(404).send({ error: 'Session not found', sessionId: query.sessionId });
        }
        conversationId = run.conversationId;
        sandboxSessionId = run.sessionId ?? undefined;
      }

      const baseDir = resolveBaseDir(agent, {
        conversationId,
        sandboxSessionId,
        dataDir,
      });
      if (!baseDir) {
        return reply.status(500).send({ error: 'Agent has no workspace configured' });
      }
      const targetFile = resolve(baseDir, normalize(query.path));

      const pathError = validateSandboxPath(baseDir, query.path);
      if (pathError) {
        return reply.status(pathError.status).send(pathError.body);
      }

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
        Querystring: { sessionId?: string };
        Body: { path: string; content: string };
      }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;
      const query = request.query as { sessionId?: string };
      const body = request.body as { path?: string; content?: string };
      const agent = getRequestAgent(request);
      let conversationId: string | null | undefined;
      let sandboxSessionId: string | undefined;

      if (!body.path || typeof body.content !== 'string') {
        return reply.status(400).send({ error: 'path and content are required' });
      }

      if (query.sessionId) {
        const run = await db.getTurn(query.sessionId);
        if (!run || run.agentId !== id) {
          return reply.status(404).send({ error: 'Session not found', sessionId: query.sessionId });
        }
        conversationId = run.conversationId;
        sandboxSessionId = run.sessionId ?? undefined;
      }

      const baseDir = resolveBaseDir(agent, {
        conversationId,
        sandboxSessionId,
        dataDir,
      });
      if (!baseDir) {
        return reply.status(500).send({ error: 'Agent has no workspace configured' });
      }
      const targetFile = resolve(baseDir, normalize(body.path));

      const pathError = validateSandboxPath(baseDir, body.path);
      if (pathError) {
        return reply.status(pathError.status).send(pathError.body);
      }

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
        Querystring: { sessionId?: string };
        Body: { path: string; content: string };
      }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;
      const query = request.query as { sessionId?: string };
      const body = request.body as { path?: string; content?: string };
      const agent = getRequestAgent(request);
      let conversationId: string | null | undefined;
      let sandboxSessionId: string | undefined;

      if (!body.path || typeof body.content !== 'string') {
        return reply.status(400).send({ error: 'path and content are required' });
      }

      if (query.sessionId) {
        const run = await db.getTurn(query.sessionId);
        if (!run || run.agentId !== id) {
          return reply.status(404).send({ error: 'Session not found', sessionId: query.sessionId });
        }
        conversationId = run.conversationId;
        sandboxSessionId = run.sessionId ?? undefined;
      }

      const baseDir = resolveBaseDir(agent, {
        conversationId,
        sandboxSessionId,
        dataDir,
      });
      if (!baseDir) {
        return reply.status(500).send({ error: 'Agent has no workspace configured' });
      }
      const targetFile = resolve(baseDir, normalize(body.path));

      const pathError = validateSandboxPath(baseDir, body.path);
      if (pathError) {
        return reply.status(pathError.status).send(pathError.body);
      }

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
        Querystring: { path?: string; sessionId?: string };
      }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;
      const query = request.query as { path?: string; sessionId?: string };
      const agent = getRequestAgent(request);
      let conversationId: string | null | undefined;
      let sandboxSessionId: string | undefined;

      if (!query.path) {
        return reply.status(400).send({ error: 'path query parameter is required' });
      }

      if (query.sessionId) {
        const run = await db.getTurn(query.sessionId);
        if (!run || run.agentId !== id) {
          return reply.status(404).send({ error: 'Session not found', sessionId: query.sessionId });
        }
        conversationId = run.conversationId;
        sandboxSessionId = run.sessionId ?? undefined;
      }

      const baseDir = resolveBaseDir(agent, {
        conversationId,
        sandboxSessionId,
        dataDir,
      });
      if (!baseDir) {
        return reply.status(500).send({ error: 'Agent has no workspace configured' });
      }
      const targetFile = resolve(baseDir, normalize(query.path));

      const pathError = validateSandboxPath(baseDir, query.path);
      if (pathError) {
        return reply.status(pathError.status).send(pathError.body);
      }

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
        const allSessions = await db.getActiveSandboxSessions();
        const agentSessions = allSessions.filter((session) => session.agentId === agent.id);

        if (agentSessions.length > 0) {
          const force = request.query.force === 'true';
          if (!force) {
            return reply.status(409).send({
              error: 'Agent has active sessions. Kill them first or use ?force=true',
              activeSessions: agentSessions.map((session) => session.id),
            });
          }

          if (sessionManager) {
            for (const session of agentSessions) {
              try {
                await sessionManager.killSession(session.id);
              } catch (err) {
                console.error(`[agents] failed to kill session ${session.id} during force upload:`, err);
              }
            }
          }
        }
      } catch (err) {
        return reply.status(500).send(safeError('Failed to check active sessions', err));
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

        const oldDir = `${baseDir}.old`;

        await rm(oldDir, { recursive: true, force: true });

        const baseExists = await stat(baseDir).then(() => true, () => false);
        if (baseExists) {
          await rename(baseDir, oldDir);
        }
        await rename(tempDir, baseDir);

        await rm(oldDir, { recursive: true, force: true });

        await chownRecursive(baseDir, 1000, 1000);

        return reply.status(201).send({ files: result.files, totalBytes: result.totalBytes });
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
