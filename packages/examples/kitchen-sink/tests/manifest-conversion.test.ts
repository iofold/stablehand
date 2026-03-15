import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseManifestString, validateManifest, manifestToDefinition } from 'ctxmill';

const __dirname = dirname(fileURLToPath(import.meta.url));
const agentsDir = join(__dirname, '..', 'agents');

const agents = [
  { dir: 'langgraph-agent', harness: 'langgraph', provider: 'openai', model: 'gpt-5-mini', harnessLabel: 'LangGraph' },
  { dir: 'openai-agent', harness: 'openai-agents', provider: 'openai', model: 'gpt-5-mini', harnessLabel: 'OpenAI Agents SDK' },
  { dir: 'claude-agent', harness: 'claude-agents', provider: 'anthropic', model: 'claude-sonnet-4-6', harnessLabel: 'Claude Agents SDK' },
  { dir: 'vercel-agent', harness: 'vercel-ai', provider: 'openai', model: 'gpt-5-mini', harnessLabel: 'Vercel AI SDK' },
  { dir: 'pi-agent', harness: 'pi-agent', provider: 'openai', model: 'gpt-5-mini', harnessLabel: 'PI Agent' },
];

async function loadManifest(dir: string) {
  const yamlContent = await readFile(join(agentsDir, dir, 'agent.yaml'), 'utf-8');
  const parsed = parseManifestString(yamlContent);
  return validateManifest(parsed);
}

describe('manifest to AgentDefinition conversion', () => {
  for (const { dir, harness, provider, model, harnessLabel } of agents) {
    describe(dir, () => {
      it('converts to AgentDefinition with correct harness', async () => {
        const manifest = await loadManifest(dir);
        const definition = manifestToDefinition(manifest);

        expect(definition.harness).toBe(harness);
      });

      it('converts model config correctly', async () => {
        const manifest = await loadManifest(dir);
        const definition = manifestToDefinition(manifest);

        expect(definition.model).toBe(model);
        expect(definition.modelConfig?.provider).toBe(provider);
        expect(definition.modelConfig?.model).toBe(model);
      });

      it('converts tools as string array', async () => {
        const manifest = await loadManifest(dir);
        const definition = manifestToDefinition(manifest);

        expect(definition.tools).toEqual(['calculator', 'weather']);
      });

      it('converts instructions to systemPrompt', async () => {
        const manifest = await loadManifest(dir);
        const definition = manifestToDefinition(manifest);

        expect(definition.systemPrompt).toContain('helpful assistant');
        expect(definition.systemPrompt).toContain(harnessLabel);
      });

      it('preserves mode', async () => {
        const manifest = await loadManifest(dir);
        const definition = manifestToDefinition(manifest);

        expect(definition.mode).toBe('interactive');
      });
    });
  }
});
