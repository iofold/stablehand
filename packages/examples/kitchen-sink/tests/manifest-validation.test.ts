import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseManifestString, validateManifest } from 'ctxmill';

const __dirname = dirname(fileURLToPath(import.meta.url));
const agentsDir = join(__dirname, '..', 'agents');

const agents = [
  { dir: 'langgraph-agent', expectedHarness: 'langgraph', expectedName: 'langgraph-analyst', provider: 'openai', model: 'gpt-5-mini', expectedTools: [{ ref: 'calculator' }, { ref: 'weather' }, { ref: 'emit-event' }, { ref: 'list-directory' }, { ref: 'search-files' }, { ref: 'execute-trade' }] },
  { dir: 'claude-agent', expectedHarness: 'claude-agents', expectedName: 'claude-writer', provider: 'anthropic', model: 'claude-sonnet-4-6', expectedTools: [{ ref: 'emit-event' }] },
  { dir: 'pi-agent', expectedHarness: 'pi-agent', expectedName: 'pi-auditor', provider: 'openai', model: 'gpt-5-mini', expectedTools: [{ ref: 'emit-event' }] },
];

describe('manifest validation', () => {
  for (const { dir, expectedHarness, expectedName, provider, model, expectedTools } of agents) {
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

        expect(manifest.spec.tools).toHaveLength(expectedTools.length);
        expect(manifest.spec.tools).toEqual(expectedTools);
      });

      it('has valid resource limits', async () => {
        const yamlContent = await readFile(join(agentsDir, dir, 'agent.yaml'), 'utf-8');
        const parsed = parseManifestString(yamlContent);
        const manifest = validateManifest(parsed);

        expect(manifest.spec.resources?.maxSessionDurationSeconds).toBe(60);
        expect(manifest.spec.resources?.maxTokensPerSession).toBe(4000);
      });

      it('uses harnessConfig instead of model', async () => {
        const yamlContent = await readFile(join(agentsDir, dir, 'agent.yaml'), 'utf-8');
        const parsed = parseManifestString(yamlContent);
        const manifest = validateManifest(parsed);
        const spec = manifest.spec as {
          model?: unknown;
          harnessConfig?: {
            provider?: string;
            model?: string;
          };
        };

        expect(spec.model).toBeUndefined();
        expect(spec.harnessConfig?.provider).toBe(provider);
        expect(spec.harnessConfig?.model).toBe(model);
      });

      it('has kitchen-sink label', async () => {
        const yamlContent = await readFile(join(agentsDir, dir, 'agent.yaml'), 'utf-8');
        const parsed = parseManifestString(yamlContent);
        const manifest = validateManifest(parsed);

        expect(manifest.metadata.labels?.example).toBe('kitchen-sink');
        expect(manifest.metadata.labels?.harness).toBe(expectedHarness);
      });

      it('has chain-role label', async () => {
        const yamlContent = await readFile(join(agentsDir, dir, 'agent.yaml'), 'utf-8');
        const parsed = parseManifestString(yamlContent);
        const manifest = validateManifest(parsed);

        expect(manifest.metadata.labels?.['chain-role']).toBeTruthy();
        expect(manifest.metadata.labels?.['chain-order']).toBeTruthy();
      });
    });
  }
});
