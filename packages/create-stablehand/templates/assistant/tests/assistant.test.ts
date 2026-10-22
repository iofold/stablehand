import { readFile } from 'node:fs/promises';
import { describe, it, expect } from 'vitest';
import { parseManifestString, validateManifest } from '@stablehand/manifest';

describe('Assistant Agent', () => {
  it('agent manifest is valid', async () => {
    const manifestUrl = new URL('../agents/assistant/agent.yaml', import.meta.url);
    const raw = await readFile(manifestUrl, 'utf-8');
    const manifest = validateManifest(parseManifestString(raw));

    expect(manifest.metadata.name).toBe('assistant');
    expect(manifest.spec.harness).toBe('langgraph');
    expect(manifest.spec.harnessConfig).toMatchObject({
      provider: 'openai',
      model: 'gpt-5.4-mini',
      apiKeyRef: '$secret:OPENAI_API_KEY',
    });
    expect(manifest.spec.tools).toEqual([
      { ref: 'read-file' },
      { ref: 'list-directory' },
      { ref: 'search-files' },
    ]);
  });
});
