import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { allowConsoleErrors } from '../setup-strict.js';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';

import { createContainer } from '../../packages/ctxmill/src/config/container.js';
import { createServer } from '../../packages/ctxmill/src/orchestrator/server.js';
import type { AppContainer } from '../../packages/ctxmill/src/config/container.js';
import { MockOverlayFactory } from '../../packages/ctxmill/src/workspace/mock-overlay.js';

describe('File operations, Skills, and Feedback API', () => {
  let app: FastifyInstance;
  let container: AppContainer;
  let dataDir: string;
  let agentId: string;

  beforeEach(() => { allowConsoleErrors(); });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'ctxmill-fileops-skills-test-'));

    container = await createContainer(
      {
        preset: 'local',
        database: { url: 'postgres://ctxmill:ctxmill@localhost:5433/ctxmill' },
        llm: { provider: 'anthropic', model: 'claude-sonnet-4-6', apiKey: 'test-key-not-used' },
      },
      dataDir,
    );

    const envFactory = new MockOverlayFactory();

    app = await createServer({
      db: container.db,
      agentRunService: container.agentRunService,
      runRegistry: container.runRegistry,
      eventBus: container.eventBus,
      dataDir,
      envFactory,
    });

    await app.ready();

    // Create a test agent
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/agents',
      payload: {
        name: 'file-ops-skills-test-agent',
        harness: 'langgraph',
        harnessConfig: { provider: 'openai', model: 'gpt-5-mini' },
        systemPrompt: 'You are a test agent.',
        tools: [],
      },
    });
    expect(createRes.statusCode).toBe(201);
    agentId = createRes.json().id;
  });

  afterAll(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // POST /api/agents/:id/files — Create file
  // ═══════════════════════════════════════════════════════════════════════════

  describe('POST /api/agents/:id/files (create file)', () => {
    it('creates a new file and returns 201 with path and size', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/agents/${agentId}/files`,
        payload: { path: 'hello.txt', content: 'Hello, world!' },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.path).toBe('hello.txt');
      expect(body.size).toBe(13);
    });

    it('creates a file in a nested directory (auto-creates parents)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/agents/${agentId}/files`,
        payload: { path: 'deep/nested/dir/file.txt', content: 'nested content' },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.path).toBe('deep/nested/dir/file.txt');
      expect(body.size).toBeGreaterThan(0);
    });

    it('rejects missing path with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/agents/${agentId}/files`,
        payload: { content: 'orphan content' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('rejects missing content with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/agents/${agentId}/files`,
        payload: { path: 'no-content.txt' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('rejects path traversal (../../evil.txt) with 403', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/agents/${agentId}/files`,
        payload: { path: '../../evil.txt', content: 'bad' },
      });

      expect(res.statusCode).toBe(403);
    });

    it('rejects blocked path (.env) with 403', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/agents/${agentId}/files`,
        payload: { path: '.env', content: 'SECRET=oops' },
      });

      expect(res.statusCode).toBe(403);
    });

    it('verifies created file content via GET /files/read', async () => {
      // Create the file
      await app.inject({
        method: 'POST',
        url: `/api/agents/${agentId}/files`,
        payload: { path: 'readable.txt', content: 'read me back' },
      });

      // Read it back
      const readRes = await app.inject({
        method: 'GET',
        url: `/api/agents/${agentId}/files/read?path=readable.txt`,
      });

      expect(readRes.statusCode).toBe(200);
      const body = readRes.json();
      expect(body.content).toBe('read me back');
      expect(body.path).toBe('readable.txt');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PUT /api/agents/:id/files — Update file
  // ═══════════════════════════════════════════════════════════════════════════

  describe('PUT /api/agents/:id/files (update file)', () => {
    it('updates an existing file and returns 200', async () => {
      // Create first
      await app.inject({
        method: 'POST',
        url: `/api/agents/${agentId}/files`,
        payload: { path: 'update-me.txt', content: 'original' },
      });

      const res = await app.inject({
        method: 'PUT',
        url: `/api/agents/${agentId}/files`,
        payload: { path: 'update-me.txt', content: 'updated content' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.path).toBe('update-me.txt');
      expect(body.size).toBe(15); // 'updated content'.length
    });

    it('verifies updated content via GET /files/read', async () => {
      const readRes = await app.inject({
        method: 'GET',
        url: `/api/agents/${agentId}/files/read?path=update-me.txt`,
      });

      expect(readRes.statusCode).toBe(200);
      expect(readRes.json().content).toBe('updated content');
    });

    it('rejects non-existent file with 404', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/agents/${agentId}/files`,
        payload: { path: 'does-not-exist.txt', content: 'nope' },
      });

      expect(res.statusCode).toBe(404);
    });

    it('rejects missing path with 400', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/agents/${agentId}/files`,
        payload: { content: 'orphan' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('rejects path traversal with 403', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/agents/${agentId}/files`,
        payload: { path: '../../../etc/passwd', content: 'bad' },
      });

      expect(res.statusCode).toBe(403);
    });

    it('rejects blocked path (.env) with 403', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/agents/${agentId}/files`,
        payload: { path: '.env', content: 'SECRET=oops' },
      });

      expect(res.statusCode).toBe(403);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // DELETE /api/agents/:id/files — Delete file
  // ═══════════════════════════════════════════════════════════════════════════

  describe('DELETE /api/agents/:id/files (delete file)', () => {
    it('deletes an existing file and returns 204', async () => {
      // Create a file to delete
      await app.inject({
        method: 'POST',
        url: `/api/agents/${agentId}/files`,
        payload: { path: 'delete-me.txt', content: 'doomed' },
      });

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/agents/${agentId}/files?path=delete-me.txt`,
      });

      expect(res.statusCode).toBe(204);
    });

    it('verifies deleted file is gone via GET /files/read', async () => {
      const readRes = await app.inject({
        method: 'GET',
        url: `/api/agents/${agentId}/files/read?path=delete-me.txt`,
      });

      expect(readRes.statusCode).toBe(400);
    });

    it('rejects missing path query parameter with 400', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/agents/${agentId}/files`,
      });

      expect(res.statusCode).toBe(400);
    });

    it('rejects deleting a directory with 400', async () => {
      // The 'deep' directory was created by the nested-dir create test
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/agents/${agentId}/files?path=deep`,
      });

      expect(res.statusCode).toBe(400);
    });

    it('rejects path traversal with 403', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/agents/${agentId}/files?path=../../evil.txt`,
      });

      expect(res.statusCode).toBe(403);
    });

    it('rejects blocked path (.env) with 403', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/agents/${agentId}/files?path=.env`,
      });

      expect(res.statusCode).toBe(403);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // GET /api/agents/:id/skills — List skills
  // ═══════════════════════════════════════════════════════════════════════════

  describe('GET /api/agents/:id/skills (list skills)', () => {
    it('returns empty arrays when no skills exist', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/agents/${agentId}/skills`,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.skills).toEqual([]);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // POST /api/agents/:id/skills — Create skill
  // ═══════════════════════════════════════════════════════════════════════════

  describe('POST /api/agents/:id/skills (create skill)', () => {
    it('creates a skill and returns 201', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/agents/${agentId}/skills`,
        payload: {
          name: 'greet-user',
          description: 'Greets the user warmly',
          instructions: 'Say hello to the user by name.',
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.name).toBe('greet-user');
      expect(body.description).toBeDefined();
    });

    it('shows the created skill in the listing', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/agents/${agentId}/skills`,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      const found = body.skills.find((s: any) => s.name === 'greet-user');
      expect(found).toBeDefined();
    });

    it('rejects missing name with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/agents/${agentId}/skills`,
        payload: {
          description: 'no name',
          instructions: 'do something',
        },
      });

      expect(res.statusCode).toBe(400);
    });

    it('rejects missing description with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/agents/${agentId}/skills`,
        payload: {
          name: 'no-desc',
          instructions: 'do something',
        },
      });

      expect(res.statusCode).toBe(400);
    });

    it('rejects missing instructions with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/agents/${agentId}/skills`,
        payload: {
          name: 'no-instr',
          description: 'has a description',
        },
      });

      expect(res.statusCode).toBe(400);
    });

    it('rejects invalid name with uppercase letters with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/agents/${agentId}/skills`,
        payload: {
          name: 'InvalidName',
          description: 'bad name',
          instructions: 'do something',
        },
      });

      expect(res.statusCode).toBe(400);
    });

    it('rejects invalid name with spaces with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/agents/${agentId}/skills`,
        payload: {
          name: 'has spaces',
          description: 'bad name',
          instructions: 'do something',
        },
      });

      expect(res.statusCode).toBe(400);
    });

    it('rejects invalid name with special chars with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/agents/${agentId}/skills`,
        payload: {
          name: 'bad_name!',
          description: 'bad name',
          instructions: 'do something',
        },
      });

      expect(res.statusCode).toBe(400);
    });

    it('rejects name longer than 64 characters with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/agents/${agentId}/skills`,
        payload: {
          name: 'a'.repeat(65),
          description: 'too long name',
          instructions: 'do something',
        },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PUT /api/agents/:id/skills/:skillName — Update skill
  // ═══════════════════════════════════════════════════════════════════════════

  describe('PUT /api/agents/:id/skills/:skillName (update skill)', () => {
    it('updates description and returns 200', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/agents/${agentId}/skills/greet-user`,
        payload: { description: 'Updated greeting skill' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.description).toBe('Updated greeting skill');
    });

    it('updates instructions and returns 200', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/agents/${agentId}/skills/greet-user`,
        payload: { instructions: 'Greet user with enthusiasm!' },
      });

      expect(res.statusCode).toBe(200);
    });

    it('rejects update with no fields with 400', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/agents/${agentId}/skills/greet-user`,
        payload: {},
      });

      expect(res.statusCode).toBe(400);
    });

    it('rejects non-existent skill with 404', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/agents/${agentId}/skills/nonexistent-skill`,
        payload: { description: 'nope' },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // DELETE /api/agents/:id/skills/:skillName — Delete skill
  // ═══════════════════════════════════════════════════════════════════════════

  describe('DELETE /api/agents/:id/skills/:skillName (delete skill)', () => {
    it('deletes a created skill and returns 204', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/agents/${agentId}/skills/greet-user`,
      });

      expect(res.statusCode).toBe(204);
    });

    it('verifies the deleted skill is gone from the listing', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/agents/${agentId}/skills`,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      const found = body.skills.find((s: any) => s.name === 'greet-user');
      expect(found).toBeUndefined();
    });

    it('rejects non-existent skill with 404', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/agents/${agentId}/skills/nonexistent-skill`,
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // POST /api/agents/:id/feedback — Submit feedback
  // ═══════════════════════════════════════════════════════════════════════════

  describe('POST /api/agents/:id/feedback (submit feedback)', () => {
    let conversationId: string;

    beforeAll(async () => {
      // Create a real conversation for FK-safe feedback tests
      const conv = await container.db.createConversation(agentId);
      conversationId = conv.id;
    });

    it('submits thumbs_up feedback and returns 201', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/agents/${agentId}/feedback`,
        payload: {
          conversationId,
          type: 'thumbs_up',
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.feedbackId).toBeDefined();
      expect(body.type).toBe('thumbs_up');
    });

    it('submits thumbs_down feedback with comment and returns 201', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/agents/${agentId}/feedback`,
        payload: {
          conversationId,
          type: 'thumbs_down',
          comment: 'Not helpful at all',
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.feedbackId).toBeDefined();
      expect(body.type).toBe('thumbs_down');
    });

    it('rejects missing conversationId with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/agents/${agentId}/feedback`,
        payload: {
          type: 'thumbs_up',
        },
      });

      expect(res.statusCode).toBe(400);
    });

    it('rejects missing type with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/agents/${agentId}/feedback`,
        payload: {
          conversationId,
        },
      });

      expect(res.statusCode).toBe(400);
    });

    it('rejects invalid type with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/agents/${agentId}/feedback`,
        payload: {
          conversationId,
          type: 'stars_5',
        },
      });

      expect(res.statusCode).toBe(400);
    });
  });
});
