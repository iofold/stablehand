import { describe, expect, test, vi } from 'vitest';

import type { DatabaseRepository } from '../../packages/ctxmill/src/database/repository.js';
import { RunStartupService } from '../../packages/ctxmill/src/orchestrator/run-startup-service.js';

type StoredAgent = NonNullable<Awaited<ReturnType<DatabaseRepository['getAgent']>>>;

function createService() {
  return new RunStartupService({
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  });
}

function createAgent(overrides: Partial<StoredAgent> = {}): StoredAgent {
  return {
    id: 'agent-1',
    name: 'assistant',
    harness: 'langgraph',
    harnessConfig: '{"model":"gpt-5.4-mini"}',
    systemPrompt: 'You are helpful.',
    tools: ['search'],
    description: 'Agent description',
    workspaceDir: '/tmp/project/agents/assistant',
    status: 'ready',
    manifest: null,
    version: 1,
    metadata: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function createExecutionMocks() {
  const db = {
    addMessage: vi.fn().mockResolvedValue({ id: 'msg-1' }),
    createConversation: vi.fn().mockResolvedValue({ id: 'conv-new', agentId: 'agent-1' }),
    createTurn: vi.fn().mockImplementation(async (input: { id?: string }) => ({ id: input.id ?? 'turn-1' })),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
    getConversation: vi.fn().mockResolvedValue({ id: 'conv-existing', agentId: 'agent-1' }),
    getMessages: vi.fn().mockResolvedValue([
      {
        id: 'msg-user-1',
        agentId: 'agent-1',
        conversationId: 'conv-existing',
        role: 'user',
        content: 'hello',
        createdAt: Date.now(),
      },
    ]),
    getTurn: vi.fn().mockResolvedValue(null),
    updateTurn: vi.fn().mockResolvedValue(undefined),
  } satisfies Parameters<RunStartupService['configureExecution']>[0]['db'];

  const eventBus = {
    emit: vi.fn(),
  };

  const sessionManager = {
    checkConcurrencyLimit: vi.fn(),
  };

  const agentSessionService = {
    executeSession: vi.fn().mockResolvedValue(undefined),
  };

  return {
    db,
    eventBus,
    sessionManager,
    agentSessionService,
  };
}

describe('RunStartupService', () => {
  describe('buildAgentDefinition', () => {
    test('includes all required AgentDefinition fields', () => {
      const service = createService();
      const agent = createAgent({
        manifest: {
          resourceLimits: { cpus: 2, memoryMb: 512 },
          spec: {
            workspace: {
              content: {
                files: [{ src: 'seed/prompt.md', dest: 'prompt.md' }],
              },
            },
          },
        },
        metadata: {
          nativeTools: { allowlist: ['bash'] },
          owner: 'ops',
        },
      });

      expect(service.buildAgentDefinition(agent)).toEqual({
        name: 'assistant',
        harness: 'langgraph',
        harnessConfig: { model: 'gpt-5.4-mini' },
        tools: ['search'],
        systemPrompt: 'You are helpful.',
        description: 'Agent description',
        metadata: {
          nativeTools: { allowlist: ['bash'] },
          owner: 'ops',
        },
        workspaceDir: '/tmp/project/agents/assistant',
        projectDir: '/tmp/project/agents',
        resourceLimits: { cpus: 2, memoryMb: 512 },
        nativeTools: { allowlist: ['bash'] },
        workspaceContent: {
          files: [{ src: 'seed/prompt.md', dest: 'prompt.md' }],
        },
      });
    });

    test('includes projectDir derived from workspaceDir', () => {
      const service = createService();
      const agent = createAgent({ workspaceDir: '/repo/workspaces/agent-a' });

      expect(service.buildAgentDefinition(agent).projectDir).toBe('/repo/workspaces');
    });

    test('includes nativeTools from metadata before manifest spec', () => {
      const service = createService();
      const agent = createAgent({
        manifest: {
          spec: {
            nativeTools: { allowlist: ['manifest-tool'] },
          },
        },
        metadata: {
          nativeTools: { blocklist: ['metadata-tool'] },
        },
      });

      expect(service.buildAgentDefinition(agent).nativeTools).toEqual({
        blocklist: ['metadata-tool'],
      });
    });

    test('includes workspaceContent from manifest spec', () => {
      const service = createService();
      const agent = createAgent({
        manifest: {
          spec: {
            workspace: {
              content: {
                files: [{ src: 'templates/base.txt', dest: 'base.txt' }],
              },
            },
          },
        },
      });

      expect(service.buildAgentDefinition(agent).workspaceContent).toEqual({
        files: [{ src: 'templates/base.txt', dest: 'base.txt' }],
      });
    });
  });

  describe('parseHarnessConfig', () => {
    test('returns parsed object for valid JSON object', () => {
      const service = createService();

      expect(service.parseHarnessConfig('{"model":"gpt-5.4","temperature":0.1}')).toEqual({
        model: 'gpt-5.4',
        temperature: 0.1,
      });
    });

    test('returns {} for null and undefined input', () => {
      const service = createService();

      expect(service.parseHarnessConfig(null)).toEqual({});
      expect(service.parseHarnessConfig(undefined)).toEqual({});
    });

    test('throws for invalid JSON string', () => {
      const service = createService();

      expect(() => service.parseHarnessConfig('{invalid')).toThrow();
    });

    test('throws for non-object JSON array', () => {
      const service = createService();

      expect(() => service.parseHarnessConfig('["x"]')).toThrow('Stored harnessConfig must be a JSON object');
    });

    test('throws for non-object JSON string', () => {
      const service = createService();

      expect(() => service.parseHarnessConfig('"hello"')).toThrow('Stored harnessConfig must be a JSON object');
    });
  });

  describe('resolveResourceLimits', () => {
    test('uses manifest.resourceLimits when present', () => {
      const service = createService();
      const agent = createAgent({
        manifest: {
          resourceLimits: { cpus: 4 },
          spec: { resources: { cpus: 2 } },
        },
        metadata: { resourceLimits: { cpus: 1 } },
      });

      expect(service.resolveResourceLimits(agent)).toEqual({ cpus: 4 });
    });

    test('falls back to manifest.spec.resources', () => {
      const service = createService();
      const agent = createAgent({
        manifest: {
          spec: { resources: { memoryMb: 768 } },
        },
        metadata: { resourceLimits: { memoryMb: 256 } },
      });

      expect(service.resolveResourceLimits(agent)).toEqual({ memoryMb: 768 });
    });

    test('falls back to metadata.resourceLimits', () => {
      const service = createService();
      const agent = createAgent({
        metadata: { resourceLimits: { timeoutSec: 30 } },
      });

      expect(service.resolveResourceLimits(agent)).toEqual({ timeoutSec: 30 });
    });

    test('returns undefined when no source has limits', () => {
      const service = createService();

      expect(service.resolveResourceLimits(createAgent())).toBeUndefined();
    });
  });

  describe('extractManifestFields', () => {
    test('extracts nativeTools from metadata or manifest spec', () => {
      const service = createService();

      expect(
        service.extractManifestFields(
          createAgent({
            manifest: { spec: { nativeTools: { allowlist: ['manifest-tool'] } } },
            metadata: { nativeTools: { blocklist: ['metadata-tool'] } },
          }),
        ),
      ).toEqual({
        nativeTools: { blocklist: ['metadata-tool'] },
      });
    });

    test('extracts workspaceContent from manifest spec', () => {
      const service = createService();

      expect(
        service.extractManifestFields(
          createAgent({
            manifest: {
              spec: {
                workspace: {
                  content: {
                    files: [{ src: 'input.txt', dest: 'output.txt' }],
                  },
                },
              },
            },
          }),
        ),
      ).toEqual({
        workspaceContent: {
          files: [{ src: 'input.txt', dest: 'output.txt' }],
        },
      });
    });

    test('returns empty when manifest has no fields', () => {
      const service = createService();

      expect(service.extractManifestFields(createAgent())).toEqual({});
    });
  });

  describe('prepareRunStart', () => {
    test('creates a conversation for a fresh interactive run and emits canonical startup events', async () => {
      const service = createService();
      const mocks = createExecutionMocks();
      mocks.db.getMessages.mockResolvedValue([
        {
          id: 'msg-user-1',
          agentId: 'agent-1',
          conversationId: 'conv-new',
          role: 'user',
          content: 'hello there',
          createdAt: Date.now(),
        },
      ]);

      service.configureExecution(mocks);

      const start = await service.prepareRunStart({
        agent: createAgent(),
        agentId: 'agent-1',
        content: 'hello there',
        mode: 'interactive',
      });

      expect(mocks.db.createConversation).toHaveBeenCalledWith('agent-1');
      expect(mocks.db.addMessage).toHaveBeenCalledWith({
        agentId: 'agent-1',
        conversationId: 'conv-new',
        role: 'user',
        content: 'hello there',
      });
      expect(mocks.sessionManager.checkConcurrencyLimit).toHaveBeenCalledWith('agent-1');
      expect(mocks.eventBus.emit).toHaveBeenNthCalledWith(1, 'user.message', expect.objectContaining({
        agentId: 'agent-1',
        conversationId: 'conv-new',
        messageId: 'msg-1',
        content: 'hello there',
      }));
      expect(mocks.eventBus.emit).toHaveBeenNthCalledWith(2, 'turn.pending', expect.objectContaining({
        turnId: 'turn-1',
        agentId: 'agent-1',
        conversationId: 'conv-new',
        mode: 'interactive',
      }));
      expect(start).toMatchObject({
        conversationId: 'conv-new',
        turnId: 'turn-1',
        messageId: 'msg-1',
        mode: 'interactive',
        taskDescription: 'hello there',
      });
    });

    test('reuses an existing conversation and suppresses user.message when requested', async () => {
      const service = createService();
      const mocks = createExecutionMocks();
      mocks.db.getMessages.mockResolvedValue([
        {
          id: 'msg-user-1',
          agentId: 'agent-1',
          conversationId: 'conv-existing',
          role: 'user',
          content: 'background task',
          createdAt: Date.now(),
        },
      ]);
      service.configureExecution(mocks);

      const start = await service.prepareRunStart({
        agent: createAgent(),
        agentId: 'agent-1',
        content: 'background task',
        mode: 'background',
        conversationId: 'conv-existing',
        requestedTurnId: 'turn-custom',
        emitUserMessageEvent: false,
      });

      expect(mocks.db.getConversation).toHaveBeenCalledWith('conv-existing');
      expect(mocks.db.createTurn).toHaveBeenCalledWith({
        id: 'turn-custom',
        agentId: 'agent-1',
        conversationId: 'conv-existing',
        mode: 'background',
        taskDescription: 'background task',
      });
      expect(mocks.eventBus.emit).toHaveBeenCalledTimes(1);
      expect(mocks.eventBus.emit).toHaveBeenCalledWith('turn.pending', expect.objectContaining({
        turnId: 'turn-custom',
        conversationId: 'conv-existing',
        mode: 'background',
        taskDescription: 'background task',
      }));
      expect(start.turnId).toBe('turn-custom');
    });

    test('rejects missing required existing conversation ids', async () => {
      const service = createService();
      const mocks = createExecutionMocks();
      service.configureExecution(mocks);

      await expect(service.prepareRunStart({
        agent: createAgent(),
        agentId: 'agent-1',
        content: 'hello there',
        mode: 'interactive',
        requireExistingConversation: true,
      })).rejects.toThrow('Conversation id is required');
    });

    test('rejects conversations owned by another agent', async () => {
      const service = createService();
      const mocks = createExecutionMocks();
      mocks.db.getConversation.mockResolvedValue({ id: 'conv-existing', agentId: 'agent-2' });
      service.configureExecution(mocks);

      await expect(service.prepareRunStart({
        agent: createAgent(),
        agentId: 'agent-1',
        content: 'hello there',
        mode: 'interactive',
        conversationId: 'conv-existing',
      })).rejects.toThrow('Conversation conv-existing not found for agent agent-1');
    });

    test('rejects duplicate requested turn ids before mutating conversation state', async () => {
      const service = createService();
      const mocks = createExecutionMocks();
      mocks.db.getTurn.mockResolvedValue({ id: 'turn-custom' });
      service.configureExecution(mocks);

      await expect(service.prepareRunStart({
        agent: createAgent(),
        agentId: 'agent-1',
        content: 'hello there',
        mode: 'interactive',
        conversationId: 'conv-existing',
        requestedTurnId: 'turn-custom',
      })).rejects.toThrow('Turn already exists for id turn-custom');

      expect(mocks.db.addMessage).not.toHaveBeenCalled();
      expect(mocks.db.createTurn).not.toHaveBeenCalled();
    });

    test('rolls back the user message when turn creation fails after message persistence', async () => {
      const service = createService();
      const mocks = createExecutionMocks();
      mocks.sessionManager.checkConcurrencyLimit.mockImplementation(() => {
        throw new Error('limit reached');
      });
      service.configureExecution(mocks);

      await expect(service.prepareRunStart({
        agent: createAgent(),
        agentId: 'agent-1',
        content: 'hello there',
        mode: 'interactive',
      })).rejects.toThrow('limit reached');

      expect(mocks.db.deleteMessage).toHaveBeenCalledWith('msg-1');
      expect(mocks.db.createTurn).not.toHaveBeenCalled();
    });
  });

  describe('launchPreparedRun', () => {
    test('passes the canonical conversation and turn ids through to executeSession', async () => {
      const service = createService();
      const mocks = createExecutionMocks();
      service.configureExecution(mocks);

      await service.launchPreparedRun({
        agentDef: service.buildAgentDefinition(createAgent()),
        conversationId: 'conv-1',
        turnId: 'turn-1',
        messageId: 'msg-1',
        messages: [],
        mode: 'background',
        taskDescription: 'hello',
      }, 'agent-1');

      expect(mocks.agentSessionService.executeSession).toHaveBeenCalledWith({
        agentDef: expect.objectContaining({ name: 'assistant' }),
        messages: [],
        agentId: 'agent-1',
        conversationId: 'conv-1',
        sessionId: 'turn-1',
        mode: 'background',
        taskDescription: 'hello',
      });
    });

    test('swallows executeSession errors after persisting the turn error by default', async () => {
      const service = createService();
      const executeSession = vi.fn().mockRejectedValue(new Error('boom'));
      const updateTurn = vi.fn().mockResolvedValue(undefined);

      service.configureExecution({
        db: {
          addMessage: vi.fn(),
          createConversation: vi.fn(),
          createTurn: vi.fn(),
          deleteMessage: vi.fn(),
          getConversation: vi.fn(),
          getMessages: vi.fn(),
          getTurn: vi.fn(),
          updateTurn,
        } as unknown as Parameters<typeof service.configureExecution>[0]['db'],
        agentSessionService: { executeSession },
      });

      await expect(service.launchPreparedRun({
        agentDef: service.buildAgentDefinition(createAgent()),
        conversationId: 'conv-1',
        turnId: 'turn-1',
        messageId: 'msg-1',
        messages: [],
        mode: 'interactive',
        taskDescription: 'hello',
      }, 'agent-1')).resolves.toBeUndefined();

      expect(updateTurn).toHaveBeenCalledWith('turn-1', expect.objectContaining({ error: 'boom' }));
    });

    test('rethrows executeSession errors when requested', async () => {
      const service = createService();
      const executeSession = vi.fn().mockRejectedValue(new Error('boom'));

      service.configureExecution({
        db: {
          addMessage: vi.fn(),
          createConversation: vi.fn(),
          createTurn: vi.fn(),
          deleteMessage: vi.fn(),
          getConversation: vi.fn(),
          getMessages: vi.fn(),
          getTurn: vi.fn(),
          updateTurn: vi.fn().mockResolvedValue(undefined),
        } as unknown as Parameters<typeof service.configureExecution>[0]['db'],
        agentSessionService: { executeSession },
      });

      await expect(service.launchPreparedRun({
        agentDef: service.buildAgentDefinition(createAgent()),
        conversationId: 'conv-1',
        turnId: 'turn-1',
        messageId: 'msg-1',
        messages: [],
        mode: 'interactive',
        taskDescription: 'hello',
      }, 'agent-1', { rethrowOnError: true })).rejects.toThrow('boom');
    });
  });
});
