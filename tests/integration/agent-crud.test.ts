import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { allowConsoleErrors } from '../setup-strict.js';

import { vi } from 'vitest';
import { AgentSchema } from '@ctxmill/contracts';
import { createTestApp, type TestAppHandle } from '../utils/test-app.js';
import { buildAgentDefinition } from '../../packages/ctxmill/src/orchestrator/agent-definition.js';

const VALID_AGENT = {
  name: 'test-agent',
  harness: 'langgraph',
  harnessConfig: { provider: 'openai', model: 'gpt-5.4-mini' },
  systemPrompt: 'You are a test agent.',
  tools: ['tool-a', 'tool-b'],
};

function canonicalManifest(
  name: string,
  spec: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    apiVersion: 'ctxmill.io/v1',
    kind: 'Agent',
    metadata: { name },
    spec: {
      harness: VALID_AGENT.harness,
      harnessConfig: VALID_AGENT.harnessConfig,
      instructions: VALID_AGENT.systemPrompt,
      tools: VALID_AGENT.tools.map((ref) => ({ ref })),
      ...spec,
    },
  };
}

describe('Agent CRUD & related endpoints', () => {
  let app: TestAppHandle['app'];
  let container: TestAppHandle['container'];
  let testApp: TestAppHandle | undefined;

  beforeEach(() => { allowConsoleErrors(); });

  beforeAll(async () => {
    testApp = await createTestApp({
      dirPrefix: 'ctxmill-agent-crud-',
    });
    app = testApp.app;
    container = testApp.container;
  });

  afterAll(async () => {
    await testApp?.close();
  });

  async function createAgent(overrides: Record<string, unknown> = {}) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agents',
      payload: { ...VALID_AGENT, ...overrides },
    });
    return res;
  }

  async function createActiveTurn(agentId: string, taskDescription: string, mode: 'interactive' | 'background' = 'background') {
    const agent = await container.db.getAgent(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }

    const conversation = await container.db.createConversation(agentId);
    const sandboxSession = await container.db.createSandboxSession({
      conversationId: conversation.id,
      agentId,
      harnessName: agent.harness,
      status: 'ACTIVE',
      containerId: 'test-container-id',
      containerName: 'test-container',
    });
    const turn = await container.db.createTurn({
      agentId,
      conversationId: conversation.id,
      mode,
      taskDescription,
      sandboxSessionId: sandboxSession.id,
    });
    container.sessionManager.onSessionReconnected(conversation.id, {
      sessionId: sandboxSession.id,
      conversationId: conversation.id,
      agentId,
      containerName: 'test-container',
      containerId: 'test-container-id',
      status: 'ACTIVE',
      harnessName: agent.harness,
    });
    container.sessionManager.startTurn(
      sandboxSession.id,
      turn.id,
      agentId,
      conversation.id,
      mode,
      taskDescription,
    );

    return { turn, conversation };
  }

  // ── POST /api/agents ───────────────────────────────────────

  describe('POST /api/agents', () => {
    it('creates agent with valid payload', async () => {
      const res = await createAgent({ name: 'create-valid' });
      expect(res.statusCode, res.body).toBe(201);
      const body = res.json();
      expect(body.id).toEqual(expect.any(String));
      expect(body.name).toBe('create-valid');
      expect(body.harness).toBe(VALID_AGENT.harness);
      expect(body.harnessConfig).toEqual(VALID_AGENT.harnessConfig);
      expect(body.tools).toEqual(VALID_AGENT.tools);
      expect(body).not.toHaveProperty('model');
      expect(() => AgentSchema.parse(body)).not.toThrow();
    });

    it('persists the complete compiled registration contract once', async () => {
      const res = await createAgent({
        name: 'complete-registration',
        nativeToolPolicy: { policy: 'deny', names: ['Write'] },
        workspaceContent: {
          files: [{ src: 'skills', dest: '.claude/skills' }],
        },
        mode: 'background',
        manifest: canonicalManifest('complete-registration', {
          nativeToolPolicy: { policy: 'deny', names: ['Write'] },
          workspace: {
            content: {
              files: [{ src: 'skills', dest: '.claude/skills' }],
            },
          },
          mode: 'background',
        }),
      });

      expect(res.statusCode, res.body).toBe(201);
      const body = res.json();
      expect(body).toMatchObject({
        nativeToolPolicy: { policy: 'deny', names: ['Write'] },
        workspaceContent: {
          files: [{ src: 'skills', dest: '.claude/skills' }],
        },
        mode: 'background',
      });

      const stored = await container.db.getAgent(body.id as string);
      if (!stored) {
        throw new Error('Expected created agent to be stored');
      }
      expect(stored.metadata).toMatchObject({
        nativeToolPolicy: { policy: 'deny', names: ['Write'] },
        workspaceContent: {
          files: [{ src: 'skills', dest: '.claude/skills' }],
        },
        mode: 'background',
      });
      expect(stored.manifest).toMatchObject({
        metadata: { name: 'complete-registration' },
      });
      expect(buildAgentDefinition(stored)).toMatchObject({
        nativeToolPolicy: { policy: 'deny', names: ['Write'] },
        workspaceContent: {
          files: [{ src: 'skills', dest: '.claude/skills' }],
        },
        mode: 'background',
      });
    });

    it('rejects non-canonical provider aliases', async () => {
      const res = await createAgent({
        name: 'reject-provider-alias',
        harnessConfig: { provider: 'gemini', model: 'gemini-3-flash-preview' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('Invalid harnessConfig');
    });

    it('rejects invalid or unrepresentable manifest snapshots', async () => {
      const invalid = await createAgent({
        name: 'invalid-manifest',
        manifest: { revision: 'not-a-canonical-manifest' },
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json().error).toBe('Invalid canonical agent manifest');

      const unrepresentable = await createAgent({
        name: 'unrepresentable-manifest',
        manifest: canonicalManifest('unrepresentable-manifest', {
          triggers: [{ event: 'invoice.ready' }],
        }),
      });
      expect(unrepresentable.statusCode).toBe(400);
      expect(unrepresentable.json().error).toBe('Invalid canonical agent manifest');
      expect(unrepresentable.json().details).toContain('triggers cannot be registered');
    });

    it('rejects any manifest-owned fields that disagree with the canonical manifest', async () => {
      const res = await createAgent({
        name: 'body-name',
        nativeToolPolicy: { policy: 'none' },
        manifest: canonicalManifest('manifest-name'),
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('Agent definition conflicts with canonical manifest');
      expect(res.json().details).toContain('name');
      expect(res.json().details).toContain('nativeToolPolicy');
    });

    it('rejects missing name', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/agents',
        payload: {
          harness: 'langgraph',
          harnessConfig: VALID_AGENT.harnessConfig,
          systemPrompt: 'x',
          tools: [],
        },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects missing harnessConfig', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/agents',
        payload: { name: 'x', harness: 'langgraph', systemPrompt: 'x', tools: [] },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects missing systemPrompt', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/agents',
        payload: { name: 'x', harness: 'langgraph', harnessConfig: VALID_AGENT.harnessConfig, tools: [] },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects missing tools', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/agents',
        payload: { name: 'x', harness: 'langgraph', harnessConfig: VALID_AGENT.harnessConfig, systemPrompt: 'x' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects non-array tools', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/agents',
        payload: {
          name: 'x',
          harness: 'langgraph',
          harnessConfig: VALID_AGENT.harnessConfig,
          systemPrompt: 'x',
          tools: 'not-array',
        },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects invalid harnessConfig for the selected harness', async () => {
      const res = await createAgent({
        name: 'invalid-harness-config',
        harnessConfig: { provider: 'invalid', model: 'gpt-5.4-mini' },
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toContain('Invalid harnessConfig');
      expect(Array.isArray(body.details)).toBe(true);
    });

    it('lists available harnesses when the selected harness is unknown', async () => {
      const res = await createAgent({
        name: 'unknown-harness',
        harness: 'missing-harness',
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe(
        'Unknown harness: missing-harness. Available: claude-agents, langgraph, pi-agent',
      );
    });

    it('rejects legacy model field payloads', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/agents',
        payload: {
          ...VALID_AGENT,
          model: 'gpt-5.4-mini',
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('Invalid agent definition');
    });

    it('returns managed HTTP tools top-level and keeps public metadata round-trip safe', async () => {
      const httpTool = {
        name: 'lookup-rate',
        description: 'Look up the current exchange rate',
        endpoint: 'https://api.example.com/rates',
        method: 'GET',
      };
      const created = await createAgent({
        name: 'managed-field-round-trip',
        tools: ['tool-a'],
        httpTools: [httpTool],
        resourceLimits: { cpus: 1 },
        mode: 'both',
        metadata: { owner: 'finance' },
      });

      expect(created.statusCode, created.body).toBe(201);
      expect(created.json()).toMatchObject({
        tools: ['tool-a'],
        httpTools: [httpTool],
        resourceLimits: { cpus: 1 },
        mode: 'both',
        metadata: { owner: 'finance' },
      });
      expect(created.json().metadata).not.toHaveProperty('httpTools');
      expect(created.json().metadata).not.toHaveProperty('resourceLimits');
      expect(created.json().metadata).not.toHaveProperty('mode');

      const updated = await app.inject({
        method: 'PATCH',
        url: `/api/agents/${created.json().id}`,
        payload: {
          systemPrompt: 'Round-trip metadata safely.',
          metadata: created.json().metadata,
        },
      });

      expect(updated.statusCode, updated.body).toBe(200);
      expect(updated.json()).toMatchObject({
        tools: ['tool-a'],
        httpTools: [httpTool],
        systemPrompt: 'Round-trip metadata safely.',
        metadata: { owner: 'finance' },
      });
    });

    it('rejects ambiguous collisions between tool references and inline HTTP tools', async () => {
      const res = await createAgent({
        name: 'ambiguous-http-tool-name',
        tools: ['lookup-rate'],
        httpTools: [{
          name: 'lookup-rate',
          description: 'Look up the current exchange rate',
          endpoint: 'https://api.example.com/rates',
        }],
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('cannot also be an HTTP tool');
    });

    it('rejects duplicate agent names as canonical deployment identities', async () => {
      const first = await createAgent({ name: 'unique-deployment-name' });
      expect(first.statusCode, first.body).toBe(201);

      const duplicate = await createAgent({ name: 'unique-deployment-name' });
      expect(duplicate.statusCode).toBe(409);
      expect(duplicate.json()).toMatchObject({
        code: 'agent_name_conflict',
        name: 'unique-deployment-name',
      });
    });
  });

  // ── PATCH /api/agents/:id ────────────────────────────────────

  describe('PATCH /api/agents/:id', () => {
    let agentId: string;

    beforeAll(async () => {
      const res = await createAgent({ name: 'update-target' });
      agentId = res.json().id;
    });

    it('updates name only', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/agents/${agentId}`,
        payload: { name: 'renamed-agent' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().name).toBe('renamed-agent');
    });

    it('updates harnessConfig only', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/agents/${agentId}`,
        payload: {
          harnessConfig: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().harnessConfig).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-6' });
    });

    it('rejects provider aliases on harnessConfig update', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/agents/${agentId}`,
        payload: {
          harnessConfig: { provider: 'gemini', model: 'gemini-3-flash-preview' },
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('Invalid harnessConfig');
    });

    it('updates multiple fields', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/agents/${agentId}`,
        payload: { name: 'multi-update', systemPrompt: 'updated prompt', tools: ['new-tool'] },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.name).toBe('multi-update');
      expect(body.systemPrompt).toBe('updated prompt');
      expect(body.tools).toEqual(['new-tool']);
    });

    it('clears nullable description and replaces public metadata exactly', async () => {
      const created = await createAgent({
        name: 'clear-agent-fields',
        description: 'Remove me',
        metadata: { owner: 'finance', obsolete: true },
      });
      expect(created.statusCode, created.body).toBe(201);

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/agents/${created.json().id}`,
        payload: {
          description: null,
          metadata: { owner: 'accounting' },
        },
      });

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().description).toBeNull();
      expect(res.json().metadata).toEqual({ owner: 'accounting' });

      const stored = await container.db.getAgent(created.json().id as string);
      expect(stored?.description).toBeNull();
      expect(stored?.metadata).toEqual({ owner: 'accounting' });
    });

    it('requires manifest-backed resource limits to be edited through the manifest', async () => {
      const created = await createAgent({
        name: 'resource-limits-manifest-agent',
        manifest: canonicalManifest('resource-limits-manifest-agent', {
          resources: {
            sandbox: { cpus: 1, memoryMb: 1024, timeoutSec: 300 },
          },
        }),
      });
      expect(created.statusCode, created.body).toBe(201);
      const manifestAgentId = created.json().id as string;

      const initial = await app.inject({
        method: 'GET',
        url: `/api/agents/${manifestAgentId}`,
      });
      expect(initial.statusCode).toBe(200);
      expect(initial.json().resourceLimits).toEqual({
        cpus: 1,
        memoryMb: 1024,
        timeoutSec: 300,
      });

      const updated = await app.inject({
        method: 'PATCH',
        url: `/api/agents/${manifestAgentId}`,
        payload: {
          resourceLimits: { cpus: 2, memoryMb: 2048, timeoutSec: 900 },
        },
      });
      expect(updated.statusCode).toBe(400);
      expect(updated.json().error).toBe('Manifest-backed agents must be edited through manifest');

      const unchanged = await app.inject({
        method: 'GET',
        url: `/api/agents/${manifestAgentId}`,
      });
      expect(unchanged.json().resourceLimits).toEqual({
        cpus: 1,
        memoryMb: 1024,
        timeoutSec: 300,
      });
    });

    it('updates and explicitly clears compiled manifest runtime fields', async () => {
      const created = await createAgent({
        name: 'runtime-field-update-agent',
        nativeToolPolicy: { policy: 'allow', names: ['Bash'] },
        workspaceContent: { files: [{ src: 'skills', dest: 'skills' }] },
        mode: 'background',
        manifest: canonicalManifest('runtime-field-update-agent', {
          nativeToolPolicy: { policy: 'allow', names: ['Bash'] },
          workspace: {
            content: {
              files: [{ src: 'skills', dest: 'skills' }],
            },
          },
          mode: 'background',
        }),
      });
      expect(created.statusCode, created.body).toBe(201);
      const runtimeAgentId = created.json().id as string;

      const updated = await app.inject({
        method: 'PATCH',
        url: `/api/agents/${runtimeAgentId}`,
        payload: {
          nativeToolPolicy: { policy: 'deny', names: ['Write'] },
          workspaceContent: { files: [{ src: 'hooks', dest: 'hooks' }] },
          mode: 'both',
          manifest: canonicalManifest('runtime-field-update-agent', {
            nativeToolPolicy: { policy: 'deny', names: ['Write'] },
            workspace: {
              content: {
                files: [{ src: 'hooks', dest: 'hooks' }],
              },
            },
            mode: 'both',
          }),
        },
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.json()).toMatchObject({
        nativeToolPolicy: { policy: 'deny', names: ['Write'] },
        workspaceContent: { files: [{ src: 'hooks', dest: 'hooks' }] },
        mode: 'both',
        manifest: {
          metadata: { name: 'runtime-field-update-agent' },
        },
      });

      const cleared = await app.inject({
        method: 'PATCH',
        url: `/api/agents/${runtimeAgentId}`,
        payload: {
          nativeToolPolicy: null,
          workspaceContent: null,
          mode: null,
          manifest: null,
        },
      });
      expect(cleared.statusCode).toBe(200);
      expect(cleared.json()).toMatchObject({
        nativeToolPolicy: null,
        workspaceContent: null,
        mode: null,
        manifest: null,
      });
    });

    it('replaces manifest-derived runtime fields without retaining stale API overrides', async () => {
      const created = await createAgent({
        name: 'manifest-replacement-agent',
        builtinToolPolicy: { policy: 'deny', names: ['emit-event'] },
        nativeToolPolicy: { policy: 'allow', names: ['Read'] },
        workspaceContent: { files: [{ src: 'old', dest: 'old' }] },
        mode: 'background',
        resourceLimits: { cpus: 2 },
        manifest: canonicalManifest('manifest-replacement-agent', {
          builtinToolPolicy: { policy: 'deny', names: ['emit-event'] },
          nativeToolPolicy: { policy: 'allow', names: ['Read'] },
          workspace: { content: { files: [{ src: 'old', dest: 'old' }] } },
          mode: 'background',
          resources: { sandbox: { cpus: 2 } },
        }),
      });
      expect(created.statusCode, created.body).toBe(201);

      const replaced = await app.inject({
        method: 'PATCH',
        url: `/api/agents/${created.json().id}`,
        payload: {
          manifest: canonicalManifest('manifest-replacement-agent', {
            builtinToolPolicy: { policy: 'all' },
            nativeToolPolicy: { policy: 'none' },
            mode: 'interactive',
            resources: { sandbox: { cpus: 1 } },
          }),
        },
      });

      expect(replaced.statusCode, replaced.body).toBe(200);
      expect(replaced.json()).toMatchObject({
        builtinToolPolicy: { policy: 'all' },
        nativeToolPolicy: { policy: 'none' },
        workspaceContent: null,
        mode: 'interactive',
        resourceLimits: { cpus: 1 },
      });
    });

    it('derives manifest-owned core fields and clears omitted description on replacement', async () => {
      const created = await createAgent({
        name: 'manifest-core-before',
        description: 'Remove this description',
        manifest: {
          ...canonicalManifest('manifest-core-before'),
          metadata: {
            name: 'manifest-core-before',
            description: 'Remove this description',
          },
        },
      });
      expect(created.statusCode, created.body).toBe(201);

      const replacementManifest = canonicalManifest('manifest-core-after', {
        instructions: 'Prompt from the replacement manifest.',
        tools: [{ ref: 'replacement-tool' }],
      });
      const replaced = await app.inject({
        method: 'PATCH',
        url: `/api/agents/${created.json().id}`,
        payload: { manifest: replacementManifest },
      });

      expect(replaced.statusCode, replaced.body).toBe(200);
      expect(replaced.json()).toMatchObject({
        name: 'manifest-core-after',
        systemPrompt: 'Prompt from the replacement manifest.',
        tools: ['replacement-tool'],
        description: null,
        manifest: replacementManifest,
      });
    });

    it('rejects direct definition edits to a manifest-backed agent', async () => {
      const created = await createAgent({
        name: 'manifest-core-guard',
        manifest: canonicalManifest('manifest-core-guard'),
      });
      expect(created.statusCode, created.body).toBe(201);

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/agents/${created.json().id}`,
        payload: { systemPrompt: 'This would leave the manifest stale.' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('Manifest-backed agents must be edited through manifest');

      const policyRes = await app.inject({
        method: 'PATCH',
        url: `/api/agents/${created.json().id}`,
        payload: { nativeToolPolicy: { policy: 'none' } },
      });

      expect(policyRes.statusCode).toBe(400);
      expect(policyRes.json().error).toBe('Manifest-backed agents must be edited through manifest');
    });

    it('rejects update with no fields', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/agents/${agentId}`,
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects harness change without harnessConfig', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/agents/${agentId}`,
        payload: { harness: 'claude-agents' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('harnessConfig is required');
    });

    it('rejects mismatched harnessConfig when changing harness', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/agents/${agentId}`,
        payload: {
          harness: 'claude-agents',
          harnessConfig: { provider: 'openai' },
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('Invalid harnessConfig');
    });

    it('rejects legacy model field updates', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/agents/${agentId}`,
        payload: { model: 'new-model' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('Invalid agent update');
    });

    it('rejects update on non-existent agent', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/agents/nonexistent-id',
        payload: { name: 'nope' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('rejects renaming an agent to another agent deployment identity', async () => {
      const first = await createAgent({ name: 'rename-source' });
      const second = await createAgent({ name: 'rename-target' });
      expect(first.statusCode, first.body).toBe(201);
      expect(second.statusCode, second.body).toBe(201);

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/agents/${first.json().id}`,
        payload: { name: 'rename-target' },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        code: 'agent_name_conflict',
        name: 'rename-target',
      });
    });
  });

  describe('GET /api/agents/:id', () => {
    it('returns parsed harnessConfig and omits legacy model fields', async () => {
      const created = await createAgent({ name: 'detail-agent' });
      const agentId = created.json().id;

      const res = await app.inject({
        method: 'GET',
        url: `/api/agents/${agentId}`,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.harness).toBe('langgraph');
      expect(body.harnessConfig).toEqual(VALID_AGENT.harnessConfig);
      expect(body).not.toHaveProperty('model');
      expect(body).not.toHaveProperty('modelConfig');
    });

    it('derives status from open turns instead of the stored column (ctx-1xb)', async () => {
      const created = await createAgent({ name: 'status-derivation-agent' });
      const agentId = created.json().id;

      let res = await app.inject({ method: 'GET', url: `/api/agents/${agentId}` });
      expect(res.json().status).toBe('idle');

      const { turn } = await createActiveTurn(agentId, 'status derivation task');
      res = await app.inject({ method: 'GET', url: `/api/agents/${agentId}` });
      expect(res.json().status).toBe('running');

      const listRes = await app.inject({ method: 'GET', url: '/api/agents' });
      const listed = listRes.json().find((entry: Record<string, unknown>) => entry.id === agentId);
      expect(listed.status).toBe('running');

      await container.db.finalizeTurnIfOpen(turn.id, {
        status: 'completed',
        completedAt: Date.now(),
        error: null,
      });
      res = await app.inject({ method: 'GET', url: `/api/agents/${agentId}` });
      expect(res.json().status).toBe('idle');
    });

    it('reports conversation, turn, and sandbox-session counts as distinct fields (ctx-ohq4)', async () => {
      const created = await createAgent({ name: 'counter-agent' });
      const agentId = created.json().id as string;

      // Conversation A: one ACTIVE sandbox session, three completed turns, two failed turns.
      const convA = await container.db.createConversation(agentId);
      const sandboxSession = await container.db.createSandboxSession({
        conversationId: convA.id,
        agentId,
        harnessName: VALID_AGENT.harness,
        status: 'ACTIVE',
        containerId: 'counter-container-id',
        containerName: 'counter-container',
      });
      for (let i = 0; i < 3; i++) {
        const turn = await container.db.createTurn({
          agentId,
          conversationId: convA.id,
          mode: 'background',
          taskDescription: `completed turn ${i}`,
          sandboxSessionId: sandboxSession.id,
        });
        await container.db.finalizeTurnIfOpen(turn.id, {
          status: 'completed',
          completedAt: Date.now(),
          error: null,
        });
      }
      for (let i = 0; i < 2; i++) {
        const turn = await container.db.createTurn({
          agentId,
          conversationId: convA.id,
          mode: 'background',
          taskDescription: `failed turn ${i}`,
          sandboxSessionId: sandboxSession.id,
        });
        await container.db.finalizeTurnIfOpen(turn.id, {
          status: 'error',
          completedAt: Date.now(),
          error: 'boom',
        });
      }

      // Conversation B: multi-turn conversation with no sandbox session at all.
      const convB = await container.db.createConversation(agentId);
      const completedNoSandbox = await container.db.createTurn({
        agentId,
        conversationId: convB.id,
        mode: 'interactive',
        taskDescription: 'completed without sandbox',
      });
      await container.db.finalizeTurnIfOpen(completedNoSandbox.id, {
        status: 'completed',
        completedAt: Date.now(),
        error: null,
      });
      await container.db.createTurn({
        agentId,
        conversationId: convB.id,
        mode: 'interactive',
        taskDescription: 'still in flight',
      });

      const expectedCounters = {
        conversationCount: 2,
        turnCount: 7,
        completedTurnCount: 4,
        failedTurnCount: 2,
        activeTurnCount: 1,
      };
      const expectedSandboxSessionsByStatus = {
        ACTIVE: 1,
        CHECKPOINTED: 0,
        RESTORING: 0,
        TERMINATED: 0,
      };
      const legacyFields = [
        'totalSessions',
        'completedSessions',
        'failedSessions',
        'activeSessions',
        'sessions',
        'sessionsByStatus',
        'recentTurns',
      ];

      const res = await app.inject({ method: 'GET', url: `/api/agents/${agentId}` });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject(expectedCounters);
      expect(body.sandboxSessionsByStatus).toEqual(expectedSandboxSessionsByStatus);
      for (const field of legacyFields) {
        expect(body).not.toHaveProperty(field);
      }

      const listRes = await app.inject({ method: 'GET', url: '/api/agents' });
      expect(listRes.statusCode).toBe(200);
      const listed = listRes.json().find((entry: Record<string, unknown>) => entry.id === agentId);
      expect(listed).toMatchObject(expectedCounters);
      expect(listed.sandboxSessionsByStatus).toEqual(expectedSandboxSessionsByStatus);
      for (const field of legacyFields) {
        expect(listed).not.toHaveProperty(field);
      }
    });
  });

  describe('GET /api/agents', () => {
    it('returns parsed harnessConfig in list responses and omits legacy model fields', async () => {
      await createAgent({ name: 'list-agent' });

      const res = await app.inject({
        method: 'GET',
        url: '/api/agents',
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body)).toBe(true);

      const agent = body.find((entry: Record<string, unknown>) => entry.name === 'list-agent');
      expect(agent).toEqual(expect.objectContaining({ name: 'list-agent' }));
      expect(agent?.harnessConfig).toEqual(VALID_AGENT.harnessConfig);
      expect(agent).not.toHaveProperty('model');
      expect(agent).not.toHaveProperty('modelConfig');
    });
  });

  // ── DELETE /api/agents/:id ─────────────────────────────────

  describe('DELETE /api/agents/:id', () => {
    it('deletes existing agent and GET returns 404', async () => {
      const created = await createAgent({ name: 'delete-me' });
      const id = created.json().id;

      const delRes = await app.inject({
        method: 'DELETE',
        url: `/api/agents/${id}`,
      });
      expect(delRes.statusCode).toBe(204);

      const getRes = await app.inject({
        method: 'GET',
        url: `/api/agents/${id}`,
      });
      expect(getRes.statusCode).toBe(404);
    });

    it('retains one durable agent.deleted tombstone after hard deletion', async () => {
      const created = await createAgent({ name: 'delete-with-tombstone' });
      const id = created.json().id as string;
      const busErrors: Array<{ source: string; event: string; error: string }> = [];
      container.eventBus.on('bus.error', (error) => {
        busErrors.push(error);
      });

      // Make the test deterministic: the create event belongs to the history
      // that hard deletion removes, while the delete event is the sole retained
      // lifecycle tombstone.
      await container.canonicalLog.drain();

      const delRes = await app.inject({
        method: 'DELETE',
        url: `/api/agents/${id}`,
      });
      expect(delRes.statusCode).toBe(204);

      const frames = await container.db.getFramesSince(id, 0, {
        channels: ['system'],
      });

      expect(busErrors).toEqual([]);
      expect(frames).toHaveLength(1);
      expect(frames[0]).toMatchObject({
        agentId: id,
        channel: 'system',
        sourceType: 'agent.deleted',
        type: 'agent.deleted',
      });
      expect(JSON.parse(frames[0]!.payload)).toEqual({
        agentId: id,
        timestamp: expect.any(Number),
      });
    });

    it('kills active sandbox sessions before deleting the agent', async () => {
      const created = await createAgent({ name: 'delete-active-agent' });
      const id = created.json().id as string;
      const stopSpy = vi.spyOn(container.containerManager, 'stopContainer');
      const removeSpy = vi.spyOn(container.containerManager, 'removeContainer');

      await createActiveTurn(id, 'Delete me while active');

      const delRes = await app.inject({
        method: 'DELETE',
        url: `/api/agents/${id}`,
      });

      expect(delRes.statusCode).toBe(204);
      expect(stopSpy).toHaveBeenCalledWith('test-container-id', 10);
      expect(removeSpy).toHaveBeenCalledWith('test-container-id', true);
      expect(await container.db.getSandboxSessionsByAgent(id)).toEqual([]);
    });

    it('removes label-matched orphan containers while deleting the agent', async () => {
      const created = await createAgent({ name: 'delete-orphaned-agent' });
      const id = created.json().id as string;
      const stopSpy = vi.spyOn(container.containerManager, 'stopContainer').mockResolvedValueOnce(undefined);
      const removeSpy = vi.spyOn(container.containerManager, 'removeContainer').mockResolvedValueOnce(undefined);
      vi.spyOn(container.containerManager, 'listManagedContainersWithLabels').mockResolvedValueOnce([
        {
          containerId: 'orphan-container-id',
          containerName: 'ctxmill-sandbox-orphan',
          sessionId: 'orphan-session-id',
          agentId: id,
          harnessName: 'langgraph',
          status: 'running',
          labels: { 'ctxmill.agent-id': id },
        },
      ]);

      const delRes = await app.inject({
        method: 'DELETE',
        url: `/api/agents/${id}`,
      });

      expect(delRes.statusCode).toBe(204);
      expect(stopSpy).toHaveBeenCalledWith('orphan-container-id', 10);
      expect(removeSpy).toHaveBeenCalledWith('orphan-container-id', true);
    });

    it('returns 404 for non-existent agent', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/agents/nonexistent-id',
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // ── GET /api/agents/:id/conversations ──────────────────────

  describe('GET /api/agents/:id/conversations', () => {
    let agentId: string;

    beforeAll(async () => {
      const res = await createAgent({ name: 'conv-agent' });
      agentId = res.json().id;
    });

    it('returns empty array initially', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/agents/${agentId}/conversations`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    });

    it('lists conversations after creating one', async () => {
      await container.db.createConversation(agentId);

      const res = await app.inject({
        method: 'GET',
        url: `/api/agents/${agentId}/conversations`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.length).toBe(1);
      expect(body[0].agentId).toBe(agentId);
    });
  });

  // ── GET /api/agents/:id/turns ──────────────────────────────

  describe('GET /api/agents/:id/turns', () => {
    let agentId: string;

    beforeAll(async () => {
      const res = await createAgent({ name: 'runs-agent' });
      agentId = res.json().id;
    });

    it('returns empty for fresh agent', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/agents/${agentId}/turns`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ turns: [] });
    });

    it('lists turns after creating one', async () => {
      const conv = await container.db.createConversation(agentId);
      const run = await container.db.createTurn({
        agentId,
        conversationId: conv.id,
        mode: 'background',
        taskDescription: 'test',
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/agents/${agentId}/turns`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.turns.length).toBeGreaterThanOrEqual(1);
      expect(body.turns.some((turn: { id: string }) => turn.id === run.id)).toBe(true);
    });
  });

  // ── GET /api/agents/:id/turns/:turnId ───────────────────────

  describe('GET /api/agents/:id/turns/:turnId', () => {
    let agentId: string;
    let runId: string;

    beforeAll(async () => {
      const res = await createAgent({ name: 'run-detail-agent' });
      agentId = res.json().id;
      const conv = await container.db.createConversation(agentId);
      const run = await container.db.createTurn({
        agentId,
        conversationId: conv.id,
        mode: 'background',
        taskDescription: 'detail test',
      });
      runId = run.id;
    });

    it('returns a turn with its conversation messages', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/agents/${agentId}/turns/${runId}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.turn).toEqual(expect.objectContaining({ id: runId }));
      expect(body.turn.id).toBe(runId);
      expect(body.turn.status).toBe('QUEUED');
      expect(Array.isArray(body.messages)).toBe(true);
    });

    it('returns derived COMPLETED status for a finished turn', async () => {
      const conv = await container.db.createConversation(agentId);
      const run = await container.db.createTurn({
        agentId,
        conversationId: conv.id,
        mode: 'background',
        taskDescription: 'completed detail test',
      });
      await container.db.finalizeTurnIfOpen(run.id, {
        status: 'completed',
        completedAt: Date.now(),
        error: null,
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/agents/${agentId}/turns/${run.id}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().turn).toEqual(expect.objectContaining({
        id: run.id,
        status: 'COMPLETED',
      }));
    });

    it('returns 404 for a non-existent turnId', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/agents/${agentId}/turns/nonexistent-turn`,
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 404 when given a conversationId instead of a turnId', async () => {
      const conversation = await container.db.createConversation(agentId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/agents/${agentId}/turns/${conversation.id}`,
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /api/agents/:id/secrets', () => {
    it('enforces the strict secret input contract and returns its canonical response', async () => {
      const created = await createAgent({ name: 'strict-secret-contract-agent' });
      expect(created.statusCode, created.body).toBe(201);
      const strictSecretAgentId = created.json().id as string;

      const invalid = await app.inject({
        method: 'POST',
        url: `/api/agents/${strictSecretAgentId}/secrets`,
        payload: { key: '   ', value: 'secret', unexpected: true },
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json().error).toBe('Invalid secret');

      const valid = await app.inject({
        method: 'POST',
        url: `/api/agents/${strictSecretAgentId}/secrets`,
        payload: { key: '  PROVIDER_TOKEN  ', value: '  byte-exact value  ' },
      });
      expect(valid.statusCode, valid.body).toBe(201);
      expect(valid.json()).toEqual({ key: 'PROVIDER_TOKEN' });
    });
  });

  describe('POST /api/ag-ui/:id/run', () => {
    let agentId: string;
    let conversationId: string;
    let runId: string;

    beforeAll(async () => {
      const res = await createAgent({ name: 'ag-ui-route-agent' });
      agentId = res.json().id;
      const conversation = await container.db.createConversation(agentId);
      conversationId = conversation.id;
      const run = await container.db.createTurn({
        id: `ag-ui-existing-run-${Date.now()}`,
        agentId,
        conversationId,
        mode: 'interactive',
      });
      runId = run.id;
    });

    it('rejects reconnect when runId and threadId do not match', async () => {
      const wrongConversation = await container.db.createConversation(agentId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/ag-ui/${agentId}/run`,
        payload: {
          threadId: wrongConversation.id,
          runId,
          messages: [{ id: 'msg-1', role: 'user', content: 'hello' }],
        },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual(expect.objectContaining({
        error: 'Run does not belong to the supplied threadId',
        runId,
        threadId: wrongConversation.id,
      }));
    });

    it('accepts an omitted threadId before rejecting completed run reconnects', async () => {
      const completedRunId = `ag-ui-completed-run-${Date.now()}`;
      await container.db.createTurn({
        id: completedRunId,
        agentId,
        conversationId,
        mode: 'interactive',
      });
      await container.db.finalizeTurnIfOpen(completedRunId, {
        status: 'completed',
        completedAt: Date.now(),
        error: null,
      });

      const res = await app.inject({
        method: 'POST',
        url: `/api/ag-ui/${agentId}/run`,
        payload: {
          runId: completedRunId,
          messages: [{ id: 'msg-1', role: 'user', content: 'hello' }],
        },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({
        error: 'Run already completed',
        runId: completedRunId,
      });
    });
  });

  // ── POST /api/agents/:id/turns/:turnId/cancel ─────────────────

  describe('POST /api/agents/:id/turns/:turnId/cancel', () => {
    it('cancels an existing turn', async () => {
      const created = await createAgent({ name: 'cancel-agent' });
      const agentId = created.json().id;
      const { turn } = await createActiveTurn(agentId, 'cancel me');

      const res = await app.inject({
        method: 'POST',
        url: `/api/agents/${agentId}/turns/${turn.id}/cancel`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().cancelled).toBe(true);
    });

    it('durably cancels a turn before its sandbox session is registered', async () => {
      const created = await createAgent({ name: 'cancel-before-sandbox-agent' });
      const agentId = created.json().id;
      const conversation = await container.db.createConversation(agentId);
      const turn = await container.db.createTurn({
        agentId,
        conversationId: conversation.id,
        mode: 'background',
        taskDescription: 'cancel before sandbox registration',
      });

      const res = await app.inject({
        method: 'POST',
        url: `/api/agents/${agentId}/turns/${turn.id}/cancel`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().cancelled).toBe(true);

      const cancelledTurn = await container.db.getTurn(turn.id);
      expect(cancelledTurn?.completedAt).toEqual(expect.any(Number));
      expect(cancelledTurn?.error).toBe('Turn cancelled');

      const readback = await app.inject({
        method: 'GET',
        url: `/api/agents/${agentId}/turns/${turn.id}`,
      });
      expect(readback.statusCode).toBe(200);
      expect(readback.json().turn.status).toBe('CANCELLED');
    });

    it('resolves a pending HITL interrupt when cancelling a turn', async () => {
      const created = await createAgent({ name: 'cancel-hitl-agent' });
      const agentId = created.json().id;
      const { turn } = await createActiveTurn(agentId, 'cancel pending approval');
      const now = Date.now();

      const interruptId = 'interrupt-cancel-hitl';
      await container.db.savePendingInterrupt({
        id: interruptId,
        turnId: turn.id,
        agentId,
        sandboxSessionId: turn.sandboxSessionId,
        toolCallId: 'approval-call',
        toolName: 'request-approval',
        args: { reason: 'test cancellation cleanup' },
        timeoutMs: 60_000,
        createdAt: now,
        expiresAt: now + 60_000,
      });

      const res = await app.inject({
        method: 'POST',
        url: `/api/agents/${agentId}/turns/${turn.id}/cancel`,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().cancelled).toBe(true);
      const interrupt = await container.db.getInterruptById(interruptId);
      expect(interrupt?.status).toBe('resolved');
      expect(interrupt?.resolvedAction).toBe('reject');
      expect(interrupt?.resolvedData).toBe('Turn cancelled');
    });
  });

  // ── GET /api/conversations?status=active ───────────────────────

  describe('GET /api/conversations?status=active', () => {
    it('returns active conversation summaries', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/conversations?status=active',
      });
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.json())).toBe(true);
    });
  });

  // ── Removed agent version history ──────────────────────────

  describe('GET /api/agents/:id/versions', () => {
    it('does not expose the retired version-history route', async () => {
      const created = await createAgent({ name: 'version-agent' });
      const agentId = created.json().id;

      const res = await app.inject({
        method: 'GET',
        url: `/api/agents/${agentId}/versions`,
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // ── GET /api/config ────────────────────────────────────────

  describe('GET /api/config', () => {
    it('returns config with system and agentDefaults sections', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/config',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toEqual(expect.objectContaining({ system: expect.any(Object), agentDefaults: expect.any(Object) }));
      expect(body.agentDefaults).not.toHaveProperty('model');
      expect(body).not.toHaveProperty('llm');
    });
  });

  // ── GET /api/catalogs/tools ────────────────────────────────

  describe('GET /api/catalogs/tools', () => {
    it('returns tool catalog array', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/catalogs/tools',
      });
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.json())).toBe(true);
    });
  });
});
