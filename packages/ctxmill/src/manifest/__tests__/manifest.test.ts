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
      harnessConfig: { provider: 'openai', model: 'gpt-4o' },
      instructions: 'You are a test agent.',
    },
  };
}

function minimalLegacyManifest(): AgentManifest {
  return {
    apiVersion: 'ctxmill.io/v1',
    kind: 'Agent',
    metadata: { name: 'legacy-agent' },
    spec: {
      harness: 'langgraph',
      model: { provider: 'openai', id: 'gpt-4o' },
      instructions: 'You are a legacy test agent.',
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
      harness: 'claude-agents',
      harnessConfig: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
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
      workspace: { content: { files: [{ src: 'data.json', dest: 'data.json' }] } },
      resources: { maxSessionDurationSeconds: 300, maxTokensPerSession: 100000 },
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

  it('validates a legacy manifest with spec.model', () => {
    expect(() => validateManifest(minimalLegacyManifest())).not.toThrow();
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
    if (m.spec.harnessConfig) {
      m.spec.harnessConfig.temperature = 3;
    }
    const result = safeValidateManifest(m);
    expect(result.success).toBe(false);
  });

  it('rejects temperature below 0', () => {
    const m = minimalManifest();
    if (m.spec.harnessConfig) {
      m.spec.harnessConfig.temperature = -0.5;
    }
    const result = safeValidateManifest(m);
    expect(result.success).toBe(false);
  });

  it('rejects spec with both model and harnessConfig', () => {
    const result = safeValidateManifest({
      ...minimalManifest(),
      spec: {
        ...minimalManifest().spec,
        model: { provider: 'openai', id: 'gpt-4o' },
      },
    });
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

  it('validates nativeTools with allowlist', () => {
    const m = minimalManifest();
    m.spec.nativeTools = { allowlist: ['bash', 'read_file'] };
    expect(() => validateManifest(m)).not.toThrow();
  });

  it('validates nativeTools with blocklist', () => {
    const m = minimalManifest();
    m.spec.nativeTools = { blocklist: ['rm', 'curl'] };
    expect(() => validateManifest(m)).not.toThrow();
  });

  it('validates workspace content with files', () => {
    const m = minimalManifest();
    m.spec.workspace = {
      content: {
        files: [{ src: 'config.json', dest: '/workspace/config.json' }],
      },
    };
    expect(() => validateManifest(m)).not.toThrow();
  });

  it('rejects nativeTools with unknown fields', () => {
    const result = safeValidateManifest({
      ...minimalManifest(),
      spec: {
        ...minimalManifest().spec,
        nativeTools: {
          allowlist: ['bash'],
          unexpected: true,
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty file src', () => {
    const m = minimalManifest();
    m.spec.workspace = {
      content: {
        files: [{ src: '', dest: '/workspace/config.json' }],
      },
    };
    const result = safeValidateManifest(m);
    expect(result.success).toBe(false);
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
  harnessConfig:
    provider: openai
    model: gpt-4o
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
    it('maps harnessConfig into AgentDefinition', () => {
      const def = manifestToDefinition(minimalManifest());
      expect(def.harnessConfig).toEqual({
        provider: 'openai',
        model: 'gpt-4o',
      });
    });

    it('maps legacy model config into harnessConfig', () => {
      const def = manifestToDefinition(minimalLegacyManifest());
      expect(def.harnessConfig).toEqual({
        provider: 'openai',
        model: 'gpt-4o',
      });
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
      expect(def.harness).toBe('claude-agents');
    });

    it('maps full harnessConfig correctly', () => {
      const def = manifestToDefinition(fullManifest());
      expect(def.harnessConfig).toEqual({
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

    it('converts nativeTools allowlist and blocklist', () => {
      const m = minimalManifest();
      m.spec.nativeTools = {
        allowlist: ['bash', 'read_file'],
        blocklist: ['rm'],
      };

      const def = manifestToDefinition(m);
      expect(def.nativeTools).toEqual({
        allowlist: ['bash', 'read_file'],
        blocklist: ['rm'],
      });
    });

    it('converts workspace content with files', () => {
      const m = minimalManifest();
      m.spec.workspace = {
        content: {
          files: [{ src: 'README.md', dest: '/workspace/README.md' }],
        },
      };

      const def = manifestToDefinition(m);
      expect(def.workspaceContent).toEqual({
        files: [{ src: 'README.md', dest: '/workspace/README.md' }],
      });
    });

    it('omits nativeTools when not set', () => {
      const def = manifestToDefinition(minimalManifest());
      expect(def.nativeTools).toBeUndefined();
    });

    it('passes projectDir from context', () => {
      const def = manifestToDefinition(minimalManifest(), { projectDir: '/tmp/project' });
      expect(def.projectDir).toBe('/tmp/project');
    });
  });

  describe('definitionToManifest', () => {
    it('creates proper K8s envelope', () => {
      const def: AgentDefinition = {
        name: 'my-agent',
        harness: 'langgraph',
        harnessConfig: { provider: 'openai', model: 'gpt-4o' },
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
        harness: 'langgraph',
        harnessConfig: { provider: 'openai', model: 'gpt-4o' },
        tools: [],
        systemPrompt: 'Be helpful',
      };
      const m = definitionToManifest(def);
      expect(m.spec.instructions).toBe('Be helpful');
    });

    it('maps tools to ref array', () => {
      const def: AgentDefinition = {
        name: 'a1',
        harness: 'langgraph',
        harnessConfig: { provider: 'openai', model: 'gpt-4o' },
        tools: ['bash', 'read_file'],
        systemPrompt: 'hi',
      };
      const m = definitionToManifest(def);
      expect(m.spec.tools).toEqual([{ ref: 'bash' }, { ref: 'read_file' }]);
    });

    it('uses harnessConfig provider and model', () => {
      const def: AgentDefinition = {
        name: 'a1',
        harness: 'langgraph',
        harnessConfig: { provider: 'openai', model: 'gpt-4o' },
        tools: [],
        systemPrompt: 'hi',
      };
      const m = definitionToManifest(def);
      expect(m.spec.harnessConfig?.provider).toBe('openai');
      expect(m.spec.harnessConfig?.model).toBe('gpt-4o');
    });

    it('preserves labels when passed', () => {
      const def: AgentDefinition = {
        name: 'a1',
        harness: 'langgraph',
        harnessConfig: { provider: 'openai', model: 'gpt-4o' },
        tools: [],
        systemPrompt: 'hi',
      };
      const m = definitionToManifest(def, { env: 'prod', team: 'core' });
      expect(m.metadata.labels).toEqual({ env: 'prod', team: 'core' });
    });

    it('omits labels when none passed', () => {
      const def: AgentDefinition = {
        name: 'a1',
        harness: 'langgraph',
        harnessConfig: { provider: 'openai', model: 'gpt-4o' },
        tools: [],
        systemPrompt: 'hi',
      };
      const m = definitionToManifest(def);
      expect(m.metadata.labels).toBeUndefined();
    });

    it('uses harnessConfig values for manifest harnessConfig', () => {
      const def: AgentDefinition = {
        name: 'a1',
        harness: 'claude-agents',
        harnessConfig: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        tools: [],
        systemPrompt: 'hi',
      };
      const m = definitionToManifest(def);
      expect(m.spec.harnessConfig?.model).toBe('claude-sonnet-4-6');
      expect(m.spec.harnessConfig?.provider).toBe('anthropic');
    });

    it('does not synthesize provider or model when harnessConfig omits them', () => {
      const def: AgentDefinition = {
        name: 'a1',
        harness: 'custom-harness',
        harnessConfig: { mode: 'local-only' },
        tools: [],
        systemPrompt: 'hi',
      };

      const m = definitionToManifest(def);
      expect(m.spec.harnessConfig).toEqual({ mode: 'local-only' });
    });

    it('preserves harness from definition', () => {
      const def: AgentDefinition = {
        name: 'a1',
        harness: 'langgraph',
        harnessConfig: { provider: 'openai', model: 'gpt-4o' },
        tools: [],
        systemPrompt: 'hi',
      };
      const m = definitionToManifest(def);
      expect(m.spec.harness).toBe('langgraph');
    });

    it('round-trips nativeTools through definition→manifest', () => {
      const def: AgentDefinition = {
        name: 'a1',
        harness: 'langgraph',
        harnessConfig: { provider: 'openai', model: 'gpt-4o' },
        tools: [],
        systemPrompt: 'hi',
        nativeTools: {
          allowlist: ['bash'],
          blocklist: ['rm'],
        },
      };

      const manifest = definitionToManifest(def);
      expect(manifest.spec.nativeTools).toEqual({
        allowlist: ['bash'],
        blocklist: ['rm'],
      });

      const roundTripped = manifestToDefinition(manifest);
      expect(roundTripped.nativeTools).toEqual({
        allowlist: ['bash'],
        blocklist: ['rm'],
      });
    });

    it('maps workspaceContent into workspace.content', () => {
      const def: AgentDefinition = {
        name: 'a1',
        harness: 'langgraph',
        harnessConfig: { provider: 'openai', model: 'gpt-4o' },
        tools: [],
        systemPrompt: 'hi',
        workspaceContent: {
          files: [{ src: 'README.md', dest: '/workspace/README.md' }],
        },
      };

      const manifest = definitionToManifest(def);
      expect(manifest.spec.workspace).toEqual({
        content: {
          files: [{ src: 'README.md', dest: '/workspace/README.md' }],
        },
      });
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
    expect(JSON.parse(mockDb.createAgent.mock.calls[0][0].harnessConfig)).toEqual({
      provider: 'openai',
      model: 'gpt-4o',
    });
  });

  it('importManifest updates existing agent when overwrite: true is supplied', async () => {
    mockDb.listAgents.mockResolvedValue([{ id: 'existing-id', name: 'test-agent' }]);

    const yamlStr = serializeManifestYAML(minimalManifest());
    const result = await service.importManifest(yamlStr, { overwrite: true });

    expect(result.created).toBe(false);
    expect(result.agentId).toBe('existing-id');
    expect(mockDb.updateAgent).toHaveBeenCalledOnce();
    expect(mockDb.saveAgentManifest).toHaveBeenCalledOnce();
    expect(mockDb.createAgent).not.toHaveBeenCalled();
  });

  it('importManifest fails closed when an agent with the same name already exists and overwrite is not set', async () => {
    mockDb.listAgents.mockResolvedValue([{ id: 'existing-id', name: 'test-agent' }]);

    const yamlStr = serializeManifestYAML(minimalManifest());

    await expect(service.importManifest(yamlStr)).rejects.toThrow(
      /Agent manifest with name "test-agent" already exists/,
    );
    expect(mockDb.updateAgent).not.toHaveBeenCalled();
    expect(mockDb.saveAgentManifest).not.toHaveBeenCalled();
    expect(mockDb.createAgent).not.toHaveBeenCalled();
  });

  it('exportManifest returns stored manifest as YAML', async () => {
    const stored = minimalManifest() as unknown as Record<string, unknown>;
    mockDb.getAgent.mockResolvedValue({
      id: 'a1',
      name: 'test-agent',
      harness: 'langgraph',
      harnessConfig: JSON.stringify({ provider: 'openai', model: 'gpt-4o' }),
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
      harness: 'langgraph',
      harnessConfig: JSON.stringify({ provider: 'openai', model: 'gpt-4o' }),
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

  it('exportManifest throws when stored harnessConfig is invalid JSON', async () => {
    mockDb.getAgent.mockResolvedValue({
      id: 'a1',
      name: 'bad-json-agent',
      harness: 'langgraph',
      harnessConfig: '{bad json',
      systemPrompt: 'Be helpful.',
      tools: [],
    });
    mockDb.getAgentManifest.mockResolvedValue(null);

    await expect(service.exportManifest('a1', 'yaml')).rejects.toThrow(
      /Invalid stored harnessConfig for agent a1/,
    );
  });

  it('exportManifest throws when stored harnessConfig is not an object', async () => {
    mockDb.getAgent.mockResolvedValue({
      id: 'a1',
      name: 'array-agent',
      harness: 'langgraph',
      harnessConfig: JSON.stringify([]),
      systemPrompt: 'Be helpful.',
      tools: [],
    });
    mockDb.getAgentManifest.mockResolvedValue(null);

    await expect(service.exportManifest('a1', 'yaml')).rejects.toThrow(
      'Invalid stored harnessConfig for agent a1: expected JSON object',
    );
  });

  it('exportManifest throws for unknown agent', async () => {
    mockDb.getAgent.mockResolvedValue(undefined);
    await expect(service.exportManifest('nonexistent')).rejects.toThrow('Agent not found');
  });

  it('syncFromDefinition creates manifest for agents without one', async () => {
    mockDb.getAgentManifest.mockResolvedValue(null);

    const def: AgentDefinition = {
      name: 'sync-agent',
      harness: 'langgraph',
      harnessConfig: { provider: 'openai', model: 'gpt-4o' },
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
      harness: 'langgraph',
      harnessConfig: { provider: 'openai', model: 'gpt-4o' },
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
      harness: 'langgraph',
      harnessConfig: JSON.stringify({ provider: 'openai', model: 'gpt-4o' }),
      systemPrompt: 'hi',
      tools: [],
    });
    mockDb.getAgentManifest.mockResolvedValue(minimalManifest());

    const json = await service.exportManifest('a1', 'json');
    const parsed = JSON.parse(json);
    expect(parsed.apiVersion).toBe('ctxmill.io/v1');
  });
});
