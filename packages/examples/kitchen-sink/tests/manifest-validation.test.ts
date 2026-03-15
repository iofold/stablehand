import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseManifestString, validateManifest } from 'ctxmill';

const __dirname = dirname(fileURLToPath(import.meta.url));
const agentsDir = join(__dirname, '..', 'agents');

const agents = [
  { dir: 'langgraph-agent', expectedHarness: 'langgraph', expectedName: 'langgraph-helper' },
  { dir: 'openai-agent', expectedHarness: 'openai-agents', expectedName: 'openai-helper' },
  { dir: 'claude-agent', expectedHarness: 'claude-agents', expectedName: 'claude-helper' },
  { dir: 'vercel-agent', expectedHarness: 'vercel-ai', expectedName: 'vercel-helper' },
  { dir: 'pi-agent', expectedHarness: 'pi-agent', expectedName: 'pi-helper' },
];

describe('manifest validation', () => {
  for (const { dir, expectedHarness, expectedName } of agents) {
    describe(dir, () => {
      it('parses and validates correctly', async () => {
        const yamlContent = await readFile(join(agentsDir, dir, 'agent.yaml'), 'utf-8');
        const parsed = parseManifestString(yamlContent);
        const manifest = validateManifest(parsed);

        expect(manifest.apiVersion).toBe('ctxmill.io/v1');
        expect(manifest.kind).toBe('Agent');
        expect(manifest.metadata.name).toBe(expectedName);
        expect(manifest.spec.harness).toBe(expectedHarness);
      });

      it('has correct tool references', async () => {
        const yamlContent = await readFile(join(agentsDir, dir, 'agent.yaml'), 'utf-8');
        const parsed = parseManifestString(yamlContent);
        const manifest = validateManifest(parsed);

        expect(manifest.spec.tools).toHaveLength(2);
        expect(manifest.spec.tools).toEqual([
          { ref: 'calculator' },
          { ref: 'weather' },
        ]);
      });

      it('has valid resource limits', async () => {
        const yamlContent = await readFile(join(agentsDir, dir, 'agent.yaml'), 'utf-8');
        const parsed = parseManifestString(yamlContent);
        const manifest = validateManifest(parsed);

        expect(manifest.spec.resources?.maxRunDurationSeconds).toBe(60);
        expect(manifest.spec.resources?.maxTokensPerRun).toBe(4000);
      });

      it('has kitchen-sink label', async () => {
        const yamlContent = await readFile(join(agentsDir, dir, 'agent.yaml'), 'utf-8');
        const parsed = parseManifestString(yamlContent);
        const manifest = validateManifest(parsed);

        expect(manifest.metadata.labels?.example).toBe('kitchen-sink');
        expect(manifest.metadata.labels?.harness).toBe(expectedHarness);
      });
    });
  }
});
