import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseManifestString,
  validateManifest,
  manifestToDefinition,
} from 'ctxmill';
import type { AgentManifest } from 'ctxmill';

const __dirname = dirname(fileURLToPath(import.meta.url));
const agentsDir = join(__dirname, '..', 'agents');

const agentDirs = [
  'langgraph-agent',
  'openai-agent',
  'claude-agent',
  'vercel-agent',
  'pi-agent',
];

async function loadManifest(dir: string): Promise<AgentManifest> {
  const yamlContent = await readFile(join(agentsDir, dir, 'agent.yaml'), 'utf-8');
  const parsed = parseManifestString(yamlContent);
  return validateManifest(parsed);
}

describe('cross-harness compatibility', () => {
  it('all 5 agents produce valid AgentDefinition shapes', async () => {
    const definitions = await Promise.all(
      agentDirs.map(async (dir) => {
        const manifest = await loadManifest(dir);
        return manifestToDefinition(manifest);
      }),
    );

    expect(definitions).toHaveLength(5);
    for (const def of definitions) {
      // Every AgentDefinition must have these required fields
      expect(def.name).toBeTruthy();
      expect(def.model).toBeTruthy();
      expect(def.systemPrompt).toBeTruthy();
      expect(def.harness).toBeTruthy();
      expect(Array.isArray(def.tools)).toBe(true);
    }
  });

  it('all tool references resolve to the same shared tools', async () => {
    const toolSets = await Promise.all(
      agentDirs.map(async (dir) => {
        const manifest = await loadManifest(dir);
        const def = manifestToDefinition(manifest);
        return def.tools;
      }),
    );

    const expected = ['calculator', 'weather'];
    for (const tools of toolSets) {
      expect(tools).toEqual(expected);
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
    expect(unique.size).toBe(5);
  });

  it('model configs are valid for their respective harnesses', async () => {
    for (const dir of agentDirs) {
      const manifest = await loadManifest(dir);
      const def = manifestToDefinition(manifest);

      // All configs should have a provider and model
      expect(def.modelConfig?.provider).toBeTruthy();
      expect(def.modelConfig?.model).toBeTruthy();

      // Claude agent should use anthropic provider
      if (def.harness === 'claude-agents') {
        expect(def.modelConfig?.provider).toBe('anthropic');
        expect(def.modelConfig?.model).toBe('claude-sonnet-4-6');
      }

      // Non-Claude agents should use openai provider
      if (def.harness !== 'claude-agents') {
        expect(def.modelConfig?.provider).toBe('openai');
      }

      // Temperature should be within valid range
      if (def.modelConfig?.temperature !== undefined) {
        expect(def.modelConfig.temperature).toBeGreaterThanOrEqual(0);
        expect(def.modelConfig.temperature).toBeLessThanOrEqual(2);
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
    expect(unique.size).toBe(5);
  });
});
