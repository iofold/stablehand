import { describe, expect, test } from 'vitest';

import type { DatabaseRepository } from '../../packages/stablehand/src/database/repository.js';
import {
  buildAgentDefinition,
  extractManifestRuntimeFields,
  parseStoredHarnessConfig,
  resolveAgentToolNames,
  resolveResourceLimits,
} from '../../packages/stablehand/src/orchestrator/agent-definition.js';
import { toAgentResponse } from '../../packages/stablehand/src/orchestrator/routes/agents/helpers.js';

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
    manifest: null,
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
          spec: {
            resources: {
              sandbox: { cpus: 2, memoryMb: 512 },
            },
            mode: 'background',
            workspace: {
              content: {
                files: [{ src: 'seed/prompt.md', dest: 'prompt.md' }],
              },
            },
          },
        },
        metadata: {
          builtinToolPolicy: { policy: 'deny', names: ['emit-event'] },
          nativeToolPolicy: { policy: 'allow', names: ['execute'] },
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
          builtinToolPolicy: { policy: 'deny', names: ['emit-event'] },
          nativeToolPolicy: { policy: 'allow', names: ['execute'] },
          owner: 'ops',
        },
        workspaceDir: '/tmp/project/agents/assistant',
        projectDir: '/tmp/project/agents',
        resourceLimits: { cpus: 2, memoryMb: 512 },
        builtinToolPolicy: { policy: 'deny', names: ['emit-event'] },
        nativeToolPolicy: { policy: 'allow', names: ['execute'] },
        mode: 'background',
        workspaceContent: {
          files: [{ src: 'seed/prompt.md', dest: 'prompt.md' }],
        },
      });
    });

    test('includes projectDir derived from workspaceDir', () => {
      const agent = createAgent({ workspaceDir: '/repo/workspaces/agent-a' });

      expect(buildAgentDefinition(agent).projectDir).toBe('/repo/workspaces');
    });

    test('includes nativeToolPolicy from metadata before manifest spec', () => {
      const agent = createAgent({
        manifest: {
          spec: {
            nativeToolPolicy: { policy: 'allow', names: ['manifest-tool'] },
          },
        },
        metadata: {
          nativeToolPolicy: { policy: 'deny', names: ['metadata-tool'] },
        },
      });

      expect(buildAgentDefinition(agent).nativeToolPolicy).toEqual({
        policy: 'deny',
        names: ['metadata-tool'],
      });
    });

    test('includes builtinToolPolicy from metadata before manifest spec', () => {
      const agent = createAgent({
        manifest: {
          spec: {
            builtinToolPolicy: { policy: 'allow', names: ['artifact_upload'] },
          },
        },
        metadata: {
          builtinToolPolicy: { policy: 'deny', names: ['emit-event'] },
        },
      });

      expect(buildAgentDefinition(agent).builtinToolPolicy).toEqual({
        policy: 'deny',
        names: ['emit-event'],
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

  describe('resolveAgentToolNames', () => {
    test('combines declared and HTTP tool names without duplicates', () => {
      const agentDef = buildAgentDefinition(createAgent({
        tools: ['search', 'weather'],
        metadata: {
          httpTools: [
            { name: 'weather', description: 'Weather', endpoint: 'https://example.test/weather' },
            { name: 'lookup', description: 'Lookup', endpoint: 'https://example.test/lookup' },
          ],
        },
      }));

      expect(resolveAgentToolNames(agentDef)).toEqual(['search', 'weather', 'lookup']);
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
    test('uses metadata.resourceLimits as an override when present', () => {
      const agent = createAgent({
        manifest: {
          resourceLimits: { cpus: 4 },
          spec: { resources: { cpus: 2 } },
        },
        metadata: { resourceLimits: { cpus: 1 } },
      });

      expect(resolveResourceLimits(agent)).toEqual({ cpus: 1 });
    });

    test('ignores retired top-level manifest resource fields', () => {
      const agent = createAgent({
        manifest: {
          resourceLimits: { cpus: 4 },
          spec: { resources: { sandbox: { cpus: 2 } } },
        },
      });

      expect(resolveResourceLimits(agent)).toEqual({ cpus: 2 });
    });

    test('falls back to manifest.spec.resources.sandbox', () => {
      const agent = createAgent({
        manifest: {
          spec: { resources: { sandbox: { memoryMb: 768 } } },
        },
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
    test('extracts builtinToolPolicy and nativeToolPolicy from metadata or manifest spec', () => {
      expect(
        extractManifestRuntimeFields(
          createAgent({
            manifest: {
              spec: {
                builtinToolPolicy: { policy: 'allow', names: ['manifest-builtin'] },
                nativeToolPolicy: { policy: 'allow', names: ['manifest-tool'] },
              },
            },
            metadata: {
              builtinToolPolicy: { policy: 'deny', names: ['metadata-builtin'] },
              nativeToolPolicy: { policy: 'deny', names: ['metadata-tool'] },
            },
          }),
        ),
      ).toEqual({
        builtinToolPolicy: { policy: 'deny', names: ['metadata-builtin'] },
        nativeToolPolicy: { policy: 'deny', names: ['metadata-tool'] },
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

    test('uses persisted API overrides for workspace content and mode', () => {
      expect(
        extractManifestRuntimeFields(
          createAgent({
            manifest: {
              spec: {
                mode: 'interactive',
                workspace: {
                  content: { files: [{ src: 'manifest.txt', dest: 'manifest.txt' }] },
                },
              },
            },
            metadata: {
              mode: 'background',
              workspaceContent: { files: [{ src: 'api.txt', dest: 'api.txt' }] },
            },
          }),
        ),
      ).toEqual({
        mode: 'background',
        workspaceContent: { files: [{ src: 'api.txt', dest: 'api.txt' }] },
      });
    });

    test('returns empty when manifest has no fields', () => {
      expect(extractManifestRuntimeFields(createAgent())).toEqual({});
    });
  });

  describe('API vs runtime parity', () => {
    test('toAgentResponse reports the resourceLimits the runtime enforces', () => {
      const manifestAgent = createAgent({
        manifest: { spec: { resources: { sandbox: { cpus: 2, memoryMb: 1024 } } } },
        metadata: null,
      });
      const editedManifestAgent = createAgent({
        manifest: { spec: { resources: { sandbox: { cpus: 2, memoryMb: 1024 } } } },
        metadata: { resourceLimits: { cpus: 3, memoryMb: 2048 } },
      });
      const metadataAgent = createAgent({
        metadata: { resourceLimits: { timeoutSec: 120 } },
      });
      const bareAgent = createAgent();

      for (const agent of [manifestAgent, editedManifestAgent, metadataAgent, bareAgent]) {
        const api = toAgentResponse(agent);
        const runtime = buildAgentDefinition(agent);
        expect(api.resourceLimits ?? null).toEqual(runtime.resourceLimits ?? null);
      }
    });

    test('metadata override makes PUT-ed limits effective for manifest agents', () => {
      const agent = createAgent({
        manifest: {
          spec: {
            resources: {
              sandbox: { cpus: 1, memoryMb: 1024, timeoutSec: 300 },
            },
          },
        },
        metadata: {
          resourceLimits: { cpus: 2, memoryMb: 2048, timeoutSec: 900 },
        },
      });

      expect(buildAgentDefinition(agent).resourceLimits).toEqual({
        cpus: 2,
        memoryMb: 2048,
        timeoutSec: 900,
      });
      expect(toAgentResponse(agent).resourceLimits).toEqual({
        cpus: 2,
        memoryMb: 2048,
        timeoutSec: 900,
      });
    });
  });
});
