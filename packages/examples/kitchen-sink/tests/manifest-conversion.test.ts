import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  manifestToAgentCreateInput,
  parseManifestString,
  validateManifest,
} from '@ctxmill/manifest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const agentsDir = join(__dirname, '..', 'agents');

const agents = [
  { dir: 'langgraph-agent', harness: 'langgraph', provider: 'openai', model: 'gpt-5.4-mini', harnessLabel: 'LangGraph', expectedTools: ['calculator', 'weather', 'emit-event', 'list-directory', 'search-files', 'execute-trade'] },
  { dir: 'claude-agent', harness: 'claude-agents', provider: 'anthropic', model: 'claude-sonnet-4-6', harnessLabel: 'Writer', expectedTools: ['emit-event'] },
  { dir: 'pi-agent', harness: 'pi-agent', provider: 'openai', model: 'gpt-5.4-mini', harnessLabel: 'PI Agent', expectedTools: ['emit-event'] },
];

async function loadManifest(dir: string) {
  const yamlContent = await readFile(join(agentsDir, dir, 'agent.yaml'), 'utf-8');
  const parsed = parseManifestString(yamlContent);
  return validateManifest(parsed);
}

describe('manifest to canonical agent create input conversion', () => {
  for (const { dir, harness, provider, model, harnessLabel, expectedTools } of agents) {
    describe(dir, () => {
      it('converts to the create contract with correct harness', async () => {
        const manifest = await loadManifest(dir);
        const definition = manifestToAgentCreateInput(manifest);

        expect(definition.harness).toBe(harness);
      });

      it('converts harness config correctly', async () => {
        const manifest = await loadManifest(dir);
        const definition = manifestToAgentCreateInput(manifest);
        const harnessConfig = (definition.harnessConfig ?? {}) as {
          provider?: string;
          model?: string;
        };

        expect(harnessConfig.provider).toBe(provider);
        expect(harnessConfig.model).toBe(model);
      });

      it('converts tools as string array', async () => {
        const manifest = await loadManifest(dir);
        const definition = manifestToAgentCreateInput(manifest);

        expect(definition.tools).toEqual(expectedTools);
      });

      it('converts instructions to systemPrompt', async () => {
        const manifest = await loadManifest(dir);
        const definition = manifestToAgentCreateInput(manifest);

        expect(definition.systemPrompt).toContain(harnessLabel);
      });

      it('preserves mode', async () => {
        const manifest = await loadManifest(dir);
        const definition = manifestToAgentCreateInput(manifest);

        expect(definition.mode).toBe('interactive');
      });
    });
  }
});
