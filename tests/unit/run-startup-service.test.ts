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
});
