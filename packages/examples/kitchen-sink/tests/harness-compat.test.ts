import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseManifestString,
  validateManifest,
  manifestToAgentCreateInput,
} from '@ctxmill/manifest';
import type { AgentManifest } from '@ctxmill/manifest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const agentsDir = join(__dirname, '..', 'agents');

const agentDirs = [
  'langgraph-agent',
  'claude-agent',
  'pi-agent',
];

async function loadManifest(dir: string): Promise<AgentManifest> {
  const yamlContent = await readFile(join(agentsDir, dir, 'agent.yaml'), 'utf-8');
  const parsed = parseManifestString(yamlContent);
  return validateManifest(parsed);
}

describe('cross-harness compatibility', () => {
  it('all 3 agents produce valid canonical create inputs', async () => {
    const definitions = await Promise.all(
      agentDirs.map(async (dir) => {
        const manifest = await loadManifest(dir);
        return manifestToAgentCreateInput(manifest);
      }),
    );

    expect(definitions).toHaveLength(3);
    for (const def of definitions) {
      const harnessConfig = (def.harnessConfig ?? {}) as {
        provider?: string;
        model?: string;
      };

      // Every canonical create input must have these required fields.
      expect(def.name).toEqual(expect.any(String));
      expect(harnessConfig).toEqual(expect.any(Object));
      expect(def.systemPrompt).toEqual(expect.any(String));
      expect(def.harness).toEqual(expect.any(String));
      expect(Array.isArray(def.tools)).toBe(true);
    }
  });

  it('all agents include emit-event tool for chaining', async () => {
    for (const dir of agentDirs) {
      const manifest = await loadManifest(dir);
      const def = manifestToAgentCreateInput(manifest);
      expect(def.tools).toContain('emit-event');
    }
  });

  it('all harness names are distinct', async () => {
    const harnesses = await Promise.all(
      agentDirs.map(async (dir) => {
        const manifest = await loadManifest(dir);
        return manifest.spec.harness;
      }),
    );

    const unique = new Set(harnesses);
    expect(unique.size).toBe(3);
  });

  it('harness configs are valid for their respective harnesses', async () => {
    for (const dir of agentDirs) {
      const manifest = await loadManifest(dir);
      const def = manifestToAgentCreateInput(manifest);
      const harnessConfig = (def.harnessConfig ?? {}) as {
        provider?: string;
        model?: string;
        temperature?: number;
      };

      // All configs should have a provider and model
      expect(harnessConfig.provider).toEqual(expect.any(String));
      expect(harnessConfig.model).toEqual(expect.any(String));

        // Claude agent should use anthropic provider
        if (def.harness === 'claude-agents') {
         expect(harnessConfig.provider).toBe('anthropic');
         expect(harnessConfig.model).toBe('claude-sonnet-4-6');
         }

        // Other non-Claude agents should use openai provider
        if (def.harness !== 'claude-agents') {
          expect(harnessConfig.provider).toBe('openai');
         }

        // Temperature should be within valid range
        if (typeof harnessConfig.temperature === 'number') {
         expect(harnessConfig.temperature).toBeGreaterThanOrEqual(0);
         expect(harnessConfig.temperature).toBeLessThanOrEqual(2);
        }
    }
  });

  it('all agents have unique names', async () => {
    const names = await Promise.all(
      agentDirs.map(async (dir) => {
        const manifest = await loadManifest(dir);
        return manifest.metadata.name;
      }),
    );

    const unique = new Set(names);
    expect(unique.size).toBe(3);
  });

  it('all agents have chain-role labels', async () => {
    const roles = await Promise.all(
      agentDirs.map(async (dir) => {
        const manifest = await loadManifest(dir);
        return manifest.metadata.labels?.['chain-role'];
      }),
    );

    // All roles should be defined and unique
    for (const role of roles) {
      expect(role).toEqual(expect.any(String));
    }
    const unique = new Set(roles);
    expect(unique.size).toBe(3);
  });
});
