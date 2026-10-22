import { readFile } from 'node:fs/promises';
import { describe, it, expect } from 'vitest';
import { parseManifestString, validateManifest } from '@stablehand/manifest';

describe('Overnight Analyst agent', () => {
  it('has a valid manifest with a per-run spend cap', async () => {
    const manifestUrl = new URL('../agents/overnight-analyst/agent.yaml', import.meta.url);
    const manifest = validateManifest(parseManifestString(await readFile(manifestUrl, 'utf-8')));

    expect(manifest.metadata.name).toBe('overnight-analyst');
    expect(manifest.spec.harness).toBe('langgraph');
    expect(manifest.spec.harnessConfig).toMatchObject({ limits: { maxCostUsd: 0.5 } });
    expect(manifest.spec.tools).toEqual([
      { ref: 'browse' },
      { ref: 'screenshot' },
      { ref: 'artifact_upload' },
    ]);
  });
});
