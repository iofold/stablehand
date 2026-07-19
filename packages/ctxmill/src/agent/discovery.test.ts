import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as discovery from './discovery.js';

describe('manifest project discovery', () => {
  let scratchRoot: string;

  beforeEach(async () => {
    await mkdir(join(process.cwd(), '.tmp'), { recursive: true });
    scratchRoot = await mkdtemp(join(process.cwd(), '.tmp', 'manifest-discovery-'));
  });

  afterEach(async () => {
    await rm(scratchRoot, { recursive: true, force: true });
  });

  it('discovers fully resolved canonical manifest projects', async () => {
    const discoverManifestProjects = (
      discovery as Record<string, unknown>
    ).discoverManifestProjects;
    expect(discoverManifestProjects).toBeTypeOf('function');
    if (typeof discoverManifestProjects !== 'function') {
      return;
    }

    const agentDir = join(scratchRoot, 'agents', 'reviewer');
    await mkdir(join(agentDir, 'prompts'), { recursive: true });
    await writeFile(join(agentDir, 'prompts', 'system.md'), 'Resolved reviewer prompt.', 'utf8');
    await writeFile(join(agentDir, 'agent.yaml'), `
apiVersion: ctxmill.io/v1
kind: Agent
metadata:
  name: reviewer
spec:
  harness: langgraph
  harnessConfig:
    provider: openai
    model: gpt-5.4-mini
  instructions: file:prompts/system.md
`, 'utf8');

    const projects = await (
      discoverManifestProjects as (agentsDir: string) => Promise<Array<{
        agentCreateInput: { name: string; systemPrompt: string };
      }>>
    )(join(scratchRoot, 'agents'));

    expect(projects).toHaveLength(1);
    expect(projects[0]?.agentCreateInput).toMatchObject({
      name: 'reviewer',
      systemPrompt: 'Resolved reviewer prompt.',
    });
  });
});
