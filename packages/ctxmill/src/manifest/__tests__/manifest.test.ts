import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentManifest } from '../types.js';
import type { AgentDefinition } from '../../types.js';
import { validateManifest, safeValidateManifest } from '../validate.js';
import { parseManifestString, serializeManifestYAML, serializeManifestJSON } from '../parser.js';
import { manifestToDefinition, definitionToManifest } from '../convert.js';
import { ManifestService } from '../service.js';

// ── Helpers ────────────────────────────────────────────────

function minimalManifest(): AgentManifest {
  return {
    apiVersion: 'ctxmill.io/v1',
    kind: 'Agent',
    metadata: { name: 'test-agent' },
    spec: {
      harness: 'langgraph',
      model: { provider: 'openai', id: 'gpt-4o' },
      instructions: 'You are a test agent.',
    },
  };
}

function fullManifest(): AgentManifest {
  return {
    apiVersion: 'ctxmill.io/v1',
    kind: 'Agent',
    metadata: {
      name: 'full-agent',
      displayName: 'Full Agent',
      description: 'A fully configured agent',
      labels: { team: 'platform', tier: 'gold' },
    },
    spec: {
      harness: 'openai-agents',
      model: {
        provider: 'anthropic',
        id: 'claude-sonnet-4-6',
        apiKeyRef: 'ANTHROPIC_KEY',
        temperature: 0.7,
        maxTokens: 4096,
        topP: 0.9,
        reasoning: 'medium',
        baseUrl: 'https://api.anthropic.com',
      },
      instructions: 'You are an advanced agent.',
      tools: [
        { ref: 'bash' },
        { mcp: { name: 'filesystem', command: 'npx', args: ['-y', '@mcp/fs'] } },
        { inline: { name: 'greet', description: 'Say hello', input: { type: 'object' } } },
      ],
      triggers: [{ event: 'agent.finished', filter: { status: 'ok' } }],
      emits: [{ event: 'report.ready', schema: { type: 'object' } }],
      hitl: { approvals: [{ tool: 'bash', timeout: 30, fallback: 'reject' }] },
      workspace: { snapshotRef: 'snap-1', maxSizeBytes: 1024 },
      resources: { maxRunDurationSeconds: 300, maxTokensPerRun: 100000 },
      mode: 'interactive',
    },
  };
}

// ── validate.ts ────────────────────────────────────────────

describe('validate', () => {
  it('validates a minimal manifest', () => {
    expect(() => validateManifest(minimalManifest())).not.toThrow();
  });

  it('validates a full manifest with all optional fields', () => {
    expect(() => validateManifest(fullManifest())).not.toThrow();
  });

  it('rejects invalid apiVersion', () => {
    const m = { ...minimalManifest(), apiVersion: 'v2' };
    const result = safeValidateManifest(m);
    expect(result.success).toBe(false);
  });

  it('rejects invalid kind', () => {
    const m = { ...minimalManifest(), kind: 'Service' };
    const result = safeValidateManifest(m);
    expect(result.success).toBe(false);
  });

  it('rejects empty name', () => {
    const m = minimalManifest();
    m.metadata.name = '';
    const result = safeValidateManifest(m);
    expect(result.success).toBe(false);
  });

  it('rejects name with uppercase letters', () => {
    const m = minimalManifest();
    m.metadata.name = 'TestAgent';
    const result = safeValidateManifest(m);
    expect(result.success).toBe(false);
  });

  it('rejects name starting with hyphen', () => {
    const m = minimalManifest();
    m.metadata.name = '-bad-name';
    const result = safeValidateManifest(m);
    expect(result.success).toBe(false);
  });

  it('accepts any harness string value', () => {
    const m = minimalManifest();
    m.spec.harness = 'custom-harness-xyz';
    expect(() => validateManifest(m)).not.toThrow();
  });

  it('rejects temperature above 2', () => {
    const m = minimalManifest();
    m.spec.model.temperature = 3;
    const result = safeValidateManifest(m);
    expect(result.success).toBe(false);
  });

  it('rejects temperature below 0', () => {
    const m = minimalManifest();
    m.spec.model.temperature = -0.5;
    const result = safeValidateManifest(m);
    expect(result.success).toBe(false);
  });

  it('rejects missing required fields (no spec)', () => {
    const result = safeValidateManifest({
      apiVersion: 'ctxmill.io/v1',
      kind: 'Agent',
      metadata: { name: 'x' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing required fields (no metadata)', () => {
    const result = safeValidateManifest({
      apiVersion: 'ctxmill.io/v1',
      kind: 'Agent',
      spec: {
        harness: 'langgraph',
        model: { provider: 'openai', id: 'gpt-4o' },
        instructions: 'hi',
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing instructions in spec', () => {
    const result = safeValidateManifest({
      apiVersion: 'ctxmill.io/v1',
      kind: 'Agent',
      metadata: { name: 'a1' },
      spec: {
        harness: 'langgraph',
        model: { provider: 'openai', id: 'gpt-4o' },
      },
    });
    expect(result.success).toBe(false);
  });

  it('safeValidateManifest returns data on success', () => {
    const result = safeValidateManifest(minimalManifest());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.metadata.name).toBe('test-agent');
    }
  });
});

// ── parser.ts ──────────────────────────────────────────────

describe('parser', () => {
  it('parses valid YAML string', () => {
    const yaml = `
apiVersion: ctxmill.io/v1
kind: Agent
metadata:
  name: yaml-agent
spec:
  harness: langgraph
  model:
    provider: openai
    id: gpt-4o
  instructions: Do stuff.
`;
    const parsed = parseManifestString(yaml);
    expect((parsed as AgentManifest).metadata.name).toBe('yaml-agent');
  });

  it('parses valid JSON string', () => {
    const json = JSON.stringify(minimalManifest());
    const parsed = parseManifestString(json);
    expect((parsed as AgentManifest).metadata.name).toBe('test-agent');
  });

  it('serializes to YAML and back', () => {
    const manifest = minimalManifest();
    const yamlStr = serializeManifestYAML(manifest);
    const parsed = parseManifestString(yamlStr);
    expect(parsed).toEqual(manifest);
  });

  it('serializes to JSON and back', () => {
    const manifest = minimalManifest();
    const jsonStr = serializeManifestJSON(manifest);
    const parsed = parseManifestString(jsonStr);
    expect(parsed).toEqual(manifest);
  });

  it('throws on invalid YAML', () => {
    expect(() => parseManifestString('{{{')).toThrow();
  });
});

// ── convert.ts ─────────────────────────────────────────────

describe('convert', () => {
  describe('manifestToDefinition', () => {
    it('maps model.id to model field', () => {
      const def = manifestToDefinition(minimalManifest());
      expect(def.model).toBe('gpt-4o');
    });

    it('maps instructions to systemPrompt', () => {
      const def = manifestToDefinition(minimalManifest());
      expect(def.systemPrompt).toBe('You are a test agent.');
    });

    it('maps tools correctly (ref, mcp name, inline name)', () => {
      const def = manifestToDefinition(fullManifest());
      expect(def.tools).toEqual(['bash', 'filesystem', 'greet']);
    });

    it('maps harness field', () => {
      const def = manifestToDefinition(fullManifest());
      expect(def.harness).toBe('openai-agents');
    });

    it('maps modelConfig correctly', () => {
      const def = manifestToDefinition(fullManifest());
      expect(def.modelConfig).toEqual({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        baseUrl: 'https://api.anthropic.com',
        apiKeyRef: 'ANTHROPIC_KEY',
        temperature: 0.7,
        maxTokens: 4096,
        topP: 0.9,
        reasoning: 'medium',
      });
    });

    it('defaults tools to empty array when not specified', () => {
      const def = manifestToDefinition(minimalManifest());
      expect(def.tools).toEqual([]);
    });

    it('maps description from metadata', () => {
      const def = manifestToDefinition(fullManifest());
      expect(def.description).toBe('A fully configured agent');
    });

    it('maps mode from spec', () => {
      const def = manifestToDefinition(fullManifest());
      expect(def.mode).toBe('interactive');
    });
  });

  describe('definitionToManifest', () => {
    it('creates proper K8s envelope', () => {
      const def: AgentDefinition = {
        name: 'my-agent',
        model: 'gpt-4o',
        tools: ['bash'],
        systemPrompt: 'Hello',
      };
      const m = definitionToManifest(def);
      expect(m.apiVersion).toBe('ctxmill.io/v1');
      expect(m.kind).toBe('Agent');
      expect(m.metadata.name).toBe('my-agent');
    });

    it('maps systemPrompt to instructions', () => {
      const def: AgentDefinition = {
        name: 'a1',
        model: 'gpt-4o',
        tools: [],
        systemPrompt: 'Be helpful',
      };
      const m = definitionToManifest(def);
      expect(m.spec.instructions).toBe('Be helpful');
    });

    it('maps tools to ref array', () => {
      const def: AgentDefinition = {
        name: 'a1',
        model: 'gpt-4o',
        tools: ['bash', 'read_file'],
        systemPrompt: 'hi',
      };
      const m = definitionToManifest(def);
      expect(m.spec.tools).toEqual([{ ref: 'bash' }, { ref: 'read_file' }]);
    });

    it('uses default provider openai when no modelConfig', () => {
      const def: AgentDefinition = {
        name: 'a1',
        model: 'gpt-4o',
        tools: [],
        systemPrompt: 'hi',
      };
      const m = definitionToManifest(def);
      expect(m.spec.model.provider).toBe('openai');
      expect(m.spec.model.id).toBe('gpt-4o');
    });

    it('preserves labels when passed', () => {
      const def: AgentDefinition = {
        name: 'a1',
        model: 'gpt-4o',
        tools: [],
        systemPrompt: 'hi',
      };
      const m = definitionToManifest(def, { env: 'prod', team: 'core' });
      expect(m.metadata.labels).toEqual({ env: 'prod', team: 'core' });
    });

    it('omits labels when none passed', () => {
      const def: AgentDefinition = {
        name: 'a1',
        model: 'gpt-4o',
        tools: [],
        systemPrompt: 'hi',
      };
      const m = definitionToManifest(def);
      expect(m.metadata.labels).toBeUndefined();
    });

    it('uses modelConfig.model over def.model when modelConfig present', () => {
      const def: AgentDefinition = {
        name: 'a1',
        model: 'gpt-4o',
        modelConfig: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        tools: [],
        systemPrompt: 'hi',
      };
      const m = definitionToManifest(def);
      expect(m.spec.model.id).toBe('claude-sonnet-4-6');
      expect(m.spec.model.provider).toBe('anthropic');
    });

    it('defaults harness to langgraph', () => {
      const def: AgentDefinition = {
        name: 'a1',
        model: 'gpt-4o',
        tools: [],
        systemPrompt: 'hi',
      };
      const m = definitionToManifest(def);
      expect(m.spec.harness).toBe('langgraph');
    });
  });
});

// ── service.ts (mocked DB) ────────────────────────────────

describe('ManifestService', () => {
  let service: ManifestService;
  let mockDb: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    mockDb = {
      listAgents: vi.fn().mockResolvedValue([]),
      createAgent: vi.fn().mockResolvedValue({ id: 'new-id', name: 'test-agent' }),
      updateAgent: vi.fn().mockResolvedValue({ id: 'existing-id' }),
      getAgent: vi.fn(),
      saveAgentManifest: vi.fn().mockResolvedValue(undefined),
      getAgentManifest: vi.fn().mockResolvedValue(null),
    };
    service = new ManifestService(mockDb as any);
  });

  it('importManifest creates new agent', async () => {
    const yamlStr = serializeManifestYAML(minimalManifest());
    const result = await service.importManifest(yamlStr);

    expect(result.created).toBe(true);
    expect(result.agentId).toBe('new-id');
    expect(mockDb.createAgent).toHaveBeenCalledOnce();
    expect(mockDb.createAgent.mock.calls[0][0].name).toBe('test-agent');
    expect(mockDb.createAgent.mock.calls[0][0].model).toBe('gpt-4o');
  });

  it('importManifest updates existing agent', async () => {
    mockDb.listAgents.mockResolvedValue([{ id: 'existing-id', name: 'test-agent' }]);

    const yamlStr = serializeManifestYAML(minimalManifest());
    const result = await service.importManifest(yamlStr);

    expect(result.created).toBe(false);
    expect(result.agentId).toBe('existing-id');
    expect(mockDb.updateAgent).toHaveBeenCalledOnce();
    expect(mockDb.saveAgentManifest).toHaveBeenCalledOnce();
    expect(mockDb.createAgent).not.toHaveBeenCalled();
  });

  it('exportManifest returns stored manifest as YAML', async () => {
    const stored = minimalManifest() as unknown as Record<string, unknown>;
    mockDb.getAgent.mockResolvedValue({
      id: 'a1',
      name: 'test-agent',
      model: 'gpt-4o',
      systemPrompt: 'hi',
      tools: [],
    });
    mockDb.getAgentManifest.mockResolvedValue(stored);

    const yaml = await service.exportManifest('a1', 'yaml');
    expect(yaml).toContain('test-agent');
    expect(yaml).toContain('ctxmill.io/v1');
  });

  it('exportManifest auto-generates from denormalized fields when no manifest stored', async () => {
    mockDb.getAgent.mockResolvedValue({
      id: 'a1',
      name: 'gen-agent',
      model: 'gpt-4o',
      harness: 'langgraph',
      systemPrompt: 'Be helpful.',
      tools: ['bash'],
      description: 'Auto-generated',
    });
    mockDb.getAgentManifest.mockResolvedValue(null);

    const yaml = await service.exportManifest('a1', 'yaml');
    expect(yaml).toContain('gen-agent');
    expect(yaml).toContain('Be helpful.');
    expect(yaml).toContain('bash');
  });

  it('exportManifest throws for unknown agent', async () => {
    mockDb.getAgent.mockResolvedValue(undefined);
    await expect(service.exportManifest('nonexistent')).rejects.toThrow('Agent not found');
  });

  it('syncFromDefinition creates manifest for agents without one', async () => {
    mockDb.getAgentManifest.mockResolvedValue(null);

    const def: AgentDefinition = {
      name: 'sync-agent',
      model: 'gpt-4o',
      tools: ['read_file'],
      systemPrompt: 'Sync me.',
    };
    await service.syncFromDefinition('a1', def);

    expect(mockDb.saveAgentManifest).toHaveBeenCalledOnce();
    const savedManifest = mockDb.saveAgentManifest.mock.calls[0][1];
    expect(savedManifest.metadata.name).toBe('sync-agent');
    expect(savedManifest.spec.instructions).toBe('Sync me.');
  });

  it('syncFromDefinition skips when manifest already exists', async () => {
    mockDb.getAgentManifest.mockResolvedValue({ apiVersion: 'ctxmill.io/v1' });

    const def: AgentDefinition = {
      name: 'sync-agent',
      model: 'gpt-4o',
      tools: [],
      systemPrompt: 'hi',
    };
    await service.syncFromDefinition('a1', def);

    expect(mockDb.saveAgentManifest).not.toHaveBeenCalled();
  });

  it('exportManifest returns JSON when format is json', async () => {
    mockDb.getAgent.mockResolvedValue({
      id: 'a1',
      name: 'json-agent',
      model: 'gpt-4o',
      systemPrompt: 'hi',
      tools: [],
    });
    mockDb.getAgentManifest.mockResolvedValue(minimalManifest());

    const json = await service.exportManifest('a1', 'json');
    const parsed = JSON.parse(json);
    expect(parsed.apiVersion).toBe('ctxmill.io/v1');
  });
});
