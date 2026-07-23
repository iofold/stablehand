import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { loadManifestProject } from '@ctxmill/manifest/node';

const agentsDir = fileURLToPath(new URL('../agents/', import.meta.url));

describe('kitchen-sink seed workspaces', () => {
  it('materializes every declared setup symlink source', async () => {
    const agentDirs = (await readdir(agentsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    for (const agentDir of agentDirs) {
      const project = await loadManifestProject(join(agentsDir, agentDir, 'agent.yaml'));
      const harnessConfig = project.manifest.spec.harnessConfig as {
        setup?: {
          symlinks?: Array<{ src: string; dest: string }>;
        };
      };
      const workspacePaths = [
        ...project.workspace.directories.map((directory) => directory.destinationPath),
        ...project.workspace.files.map((file) => file.destinationPath),
      ];

      for (const symlink of harnessConfig.setup?.symlinks ?? []) {
        const sourceIsMaterialized = workspacePaths.some(
          (path) => path === symlink.src || path.startsWith(`${symlink.src}/`),
        );
        expect(
          sourceIsMaterialized,
          `${agentDir} must materialize setup symlink source "${symlink.src}"`,
        ).toBe(true);
      }
    }
  });

  it('declares explicit provider secret references for every seeded model', async () => {
    const agentDirs = (await readdir(agentsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    for (const agentDir of agentDirs) {
      const project = await loadManifestProject(join(agentsDir, agentDir, 'agent.yaml'));
      const harnessConfig = project.manifest.spec.harnessConfig as {
        provider?: string;
        apiKeyRef?: string;
        subagents?: Array<{
          name: string;
          provider?: string;
          apiKeyRef?: string;
        }>;
      };

      if (harnessConfig.provider) {
        expect(
          harnessConfig.apiKeyRef,
          `${agentDir} must declare an apiKeyRef for ${harnessConfig.provider}`,
        ).toMatch(/^\$secret:[A-Z0-9_]+$/);
      }

      for (const subagent of Array.isArray(harnessConfig.subagents)
        ? harnessConfig.subagents
        : []) {
        if (subagent.provider) {
          expect(
            subagent.apiKeyRef,
            `${agentDir}/${subagent.name} must declare an apiKeyRef for ${subagent.provider}`,
          ).toMatch(/^\$secret:[A-Z0-9_]+$/);
        }
      }
    }
  });
});
