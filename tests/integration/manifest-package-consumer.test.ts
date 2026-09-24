import { describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  parseManifestString,
  validateManifest,
  type AgentManifest,
} from '@stablehand/manifest';

async function findAgentManifests(root: string): Promise<string[]> {
  const manifests: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      manifests.push(...await findAgentManifests(path));
    } else if (entry.name === 'agent.yaml' || entry.name === 'agent.yml') {
      manifests.push(path);
    }
  }
  return manifests;
}

describe('@stablehand/manifest consumer contract', () => {
  it('parses and strictly validates an agent manifest without importing stablehand core', () => {
    const parsed = parseManifestString(`
apiVersion: stablehand.io/v1
kind: Agent
metadata:
  name: close-reviewer
spec:
  harness: langgraph
  harnessConfig:
    provider: openai
    model: gpt-5.4-mini
  instructions: Review the close package.
`);

    const manifest: AgentManifest = validateManifest(parsed);
    expect(manifest.metadata.name).toBe('close-reviewer');
    expect(manifest.spec.harness).toBe('langgraph');
  });

  it('accepts every checked-in example and test agent manifest', async () => {
    const roots = [
      join(process.cwd(), 'packages', 'examples'),
      join(process.cwd(), 'tests', 'e2e', 'visual-qa', 'agents'),
      join(process.cwd(), 'tests', 'stress', 'agents'),
    ];
    const manifestPaths = (await Promise.all(roots.map(findAgentManifests))).flat().sort();

    expect(manifestPaths.length).toBeGreaterThan(0);
    for (const manifestPath of manifestPaths) {
      const source = await readFile(manifestPath, 'utf8');
      expect(() => validateManifest(
        parseManifestString(source),
      ), manifestPath).not.toThrow();
    }
  });
});
