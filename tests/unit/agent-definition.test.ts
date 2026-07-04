import { describe, expect, test } from 'vitest';

import type { DatabaseRepository } from '../../packages/ctxmill/src/database/repository.js';
import {
  buildAgentDefinition,
  extractManifestRuntimeFields,
  parseStoredHarnessConfig,
  resolveResourceLimits,
} from '../../packages/ctxmill/src/orchestrator/agent-definition.js';
import { toAgentResponse } from '../../packages/ctxmill/src/orchestrator/routes/agents/helpers.js';

type StoredAgent = NonNullable<Awaited<ReturnType<DatabaseRepository['getAgent']>>>;

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

describe('canonical agent-definition module (ctx-8l4)', () => {
  describe('buildAgentDefinition', () => {
    test('includes all required AgentDefinition fields', () => {
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

      expect(buildAgentDefinition(agent)).toEqual({
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
      const agent = createAgent({ workspaceDir: '/repo/workspaces/agent-a' });

      expect(buildAgentDefinition(agent).projectDir).toBe('/repo/workspaces');
    });

    test('includes nativeTools from metadata before manifest spec', () => {
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

      expect(buildAgentDefinition(agent).nativeTools).toEqual({
        blocklist: ['metadata-tool'],
      });
    });

    test('includes workspaceContent from manifest spec', () => {
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

      expect(buildAgentDefinition(agent).workspaceContent).toEqual({
        files: [{ src: 'templates/base.txt', dest: 'base.txt' }],
      });
    });
  });

  describe('parseStoredHarnessConfig', () => {
    test('returns parsed object for valid JSON object', () => {
      expect(parseStoredHarnessConfig('{"model":"gpt-5.4","temperature":0.1}')).toEqual({
        model: 'gpt-5.4',
        temperature: 0.1,
      });
    });

    test('returns {} for null and undefined input', () => {
      expect(parseStoredHarnessConfig(null)).toEqual({});
      expect(parseStoredHarnessConfig(undefined)).toEqual({});
    });

    test('throws for invalid JSON string', () => {
      expect(() => parseStoredHarnessConfig('{invalid')).toThrow();
    });

    test('throws for non-object JSON array', () => {
      expect(() => parseStoredHarnessConfig('["x"]')).toThrow('Stored harnessConfig must be a JSON object');
    });

    test('throws for non-object JSON string', () => {
      expect(() => parseStoredHarnessConfig('"hello"')).toThrow('Stored harnessConfig must be a JSON object');
    });
  });

  describe('resolveResourceLimits', () => {
    test('uses manifest.resourceLimits when present', () => {
      const agent = createAgent({
        manifest: {
          resourceLimits: { cpus: 4 },
          spec: { resources: { cpus: 2 } },
        },
        metadata: { resourceLimits: { cpus: 1 } },
      });

      expect(resolveResourceLimits(agent)).toEqual({ cpus: 4 });
    });

    test('falls back to manifest.spec.resources', () => {
      const agent = createAgent({
        manifest: {
          spec: { resources: { memoryMb: 768 } },
        },
        metadata: { resourceLimits: { memoryMb: 256 } },
      });

      expect(resolveResourceLimits(agent)).toEqual({ memoryMb: 768 });
    });

    test('falls back to metadata.resourceLimits', () => {
      const agent = createAgent({
        metadata: { resourceLimits: { timeoutSec: 30 } },
      });

      expect(resolveResourceLimits(agent)).toEqual({ timeoutSec: 30 });
    });

    test('returns undefined when no source has limits', () => {
      expect(resolveResourceLimits(createAgent())).toBeUndefined();
    });
  });

  describe('extractManifestRuntimeFields', () => {
    test('extracts nativeTools from metadata or manifest spec', () => {
      expect(
        extractManifestRuntimeFields(
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
      expect(
        extractManifestRuntimeFields(
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
      expect(extractManifestRuntimeFields(createAgent())).toEqual({});
    });
  });

  describe('API vs runtime parity', () => {
    test('toAgentResponse reports the resourceLimits the runtime enforces', () => {
      const manifestAgent = createAgent({
        manifest: { resourceLimits: { cpus: 2, memoryMb: 1024 } },
        metadata: null,
      });
      const metadataAgent = createAgent({
        metadata: { resourceLimits: { timeoutSec: 120 } },
      });
      const bareAgent = createAgent();

      for (const agent of [manifestAgent, metadataAgent, bareAgent]) {
        const api = toAgentResponse(agent);
        const runtime = buildAgentDefinition(agent);
        expect(api.resourceLimits ?? null).toEqual(runtime.resourceLimits ?? null);
      }
    });
  });
});
