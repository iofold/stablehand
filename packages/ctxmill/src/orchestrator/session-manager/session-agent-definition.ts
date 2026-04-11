import { dirname } from 'node:path';

import type { DatabaseRepository } from '../../database/repository.js';
import type { AgentDefinition } from '../../types.js';

export function parseStoredHarnessConfig(harnessConfigJson: string): Record<string, unknown> {
  const parsed = JSON.parse(harnessConfigJson) as unknown;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Stored harnessConfig must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

type StoredAgent = NonNullable<Awaited<ReturnType<DatabaseRepository['getAgent']>>>;

export function toAgentDefinition(agent: StoredAgent): AgentDefinition {
  const manifest = agent.manifest ?? null;
  const manifestSpec = (manifest as Record<string, unknown> | null)?.spec as Record<string, unknown> | undefined;
  const meta = (agent.metadata ?? {}) as Record<string, unknown>;
  const resourceLimits = (manifest?.resourceLimits ?? manifestSpec?.resources ?? meta.resourceLimits) as AgentDefinition['resourceLimits'];

  const rawNativeTools = ('nativeTools' in meta ? meta.nativeTools : manifestSpec?.nativeTools) as
    { allowlist?: string[]; blocklist?: string[] } | undefined;
  const rawWorkspaceContent = (manifestSpec?.workspace as Record<string, unknown> | undefined)?.content as
    { files?: Array<{ src: string; dest: string }> } | undefined;

  return {
    name: agent.name,
    harness: agent.harness,
    harnessConfig: parseStoredHarnessConfig(agent.harnessConfig),
    systemPrompt: agent.systemPrompt,
    tools: agent.tools,
    description: agent.description ?? undefined,
    metadata: agent.metadata ?? undefined,
    workspaceDir: agent.workspaceDir ?? undefined,
    projectDir: agent.workspaceDir ? dirname(agent.workspaceDir) : undefined,
    resourceLimits,
    ...(rawNativeTools ? { nativeTools: rawNativeTools } : {}),
    ...(rawWorkspaceContent ? { workspaceContent: rawWorkspaceContent } : {}),
  };
}
