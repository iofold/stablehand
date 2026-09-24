import { glob } from 'glob';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AgentDefinition } from '@stablehand/sandbox-daemon';
import type { ToolDefinition } from '@stablehand/sandbox-daemon';
import {
  loadManifestProject,
  type LoadedManifestProject,
} from '@stablehand/manifest/node';

/**
 * Auto-discover agent definitions from a directory.
 * Expects each agent in a subdirectory with an `agent.ts` file
 * that has a default export of an AgentDefinition.
 */
export async function discoverAgents(agentsDir: string): Promise<AgentDefinition[]> {
  const files = await glob('*/agent.ts', { cwd: agentsDir });
  const agents: AgentDefinition[] = [];

  for (const file of files) {
    const fullPath = join(agentsDir, file);
    const mod = await import(pathToFileURL(fullPath).href);
    if (mod.default) {
      agents.push(mod.default as AgentDefinition);
    }
  }

  return agents;
}

/**
 * Auto-discover tool definitions from a directory.
 * Expects each file to have a default export of a ToolDefinition.
 * Skips test and spec files.
 */
export async function discoverTools(toolsDir: string): Promise<ToolDefinition[]> {
  const files = await glob('*.ts', { cwd: toolsDir });
  const tools: ToolDefinition[] = [];

  for (const file of files) {
    if (file === 'index.ts' || file.endsWith('.test.ts') || file.endsWith('.spec.ts')) continue;
    const fullPath = join(toolsDir, file);
    const mod = await import(pathToFileURL(fullPath).href);
    if (mod.default) {
      tools.push(mod.default as ToolDefinition);
    }
  }

  return tools;
}

export async function discoverManifestProjects(
  agentsDir: string,
): Promise<LoadedManifestProject[]> {
  const files = await glob('*/agent.{yaml,yml}', { cwd: agentsDir });
  files.sort((left, right) => left.localeCompare(right));
  const projects: LoadedManifestProject[] = [];

  for (const file of files) {
    const fullPath = join(agentsDir, file);
    projects.push(await loadManifestProject(fullPath));
  }

  return projects;
}
