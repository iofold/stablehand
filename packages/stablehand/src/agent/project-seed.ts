import type { LoadedManifestProject } from '@stablehand/manifest/node';
import type { AgentDefinition } from '@stablehand/sandbox-daemon';

import type { DatabaseRepository } from '../database/repository.js';
import type { AgentInsert } from '../database/types.js';
import { discoverAgents, discoverManifestProjects } from './discovery.js';

export interface ProjectAgentSeedResult {
  /** Agent names declared in agents/, in discovery order. */
  declared: string[];
  /** Created by this start. */
  created: string[];
  /** Already present under the same name; now recorded and left unchanged. */
  adopted: string[];
  /** Recorded by an earlier start; left alone even if deleted since. */
  alreadySeeded: string[];
}

function definitionRecord(def: AgentDefinition): AgentInsert {
  return {
    name: def.name,
    harness: def.harness,
    harnessConfig: JSON.stringify(def.harnessConfig),
    systemPrompt: def.systemPrompt,
    tools: def.tools,
    description: def.description ?? null,
    metadata: def.metadata ?? null,
  };
}

function manifestRecord({ agentCreateInput: input }: LoadedManifestProject): AgentInsert {
  const metadata = input.metadata !== undefined || input.mcpServers !== undefined
    ? {
      ...(input.metadata ?? {}),
      // Stored where the agent API keeps them, so boot registers them.
      ...(input.mcpServers !== undefined ? { mcpServers: input.mcpServers } : {}),
    }
    : null;
  return {
    name: input.name,
    harness: input.harness,
    harnessConfig: JSON.stringify(input.harnessConfig),
    systemPrompt: input.systemPrompt,
    tools: input.tools,
    description: input.description ?? null,
    metadata,
    manifest: input.manifest,
  };
}

/**
 * Register the agents declared in a project's agents/ directory (agent.ts
 * modules and agent.yaml manifests) when the orchestrator starts.
 *
 * Seed-once (ctx-dxxa): each agent name is created at most once per database.
 * The first start that sees a name creates the agent (or adopts an existing
 * agent with that name) and records the name in project_agent_seeds. Later
 * starts skip recorded names, so an agent deleted in the UI or through the API
 * stays deleted across restarts instead of coming back from its file. Only
 * this function reads the ledger: creating an agent with the same name through
 * the API still works, and later starts leave that agent alone as well.
 * To seed a deleted agent from its file again, delete its project_agent_seeds
 * row and restart. Files never overwrite an existing agent; edit agents
 * through the API or a seed script.
 */
export async function seedProjectAgents(
  db: Pick<DatabaseRepository, 'seedProjectAgentOnce'>,
  agentsDir: string,
): Promise<ProjectAgentSeedResult> {
  const records = [
    ...(await discoverAgents(agentsDir)).map(definitionRecord),
    ...(await discoverManifestProjects(agentsDir)).map(manifestRecord),
  ];
  const result: ProjectAgentSeedResult = {
    declared: [],
    created: [],
    adopted: [],
    alreadySeeded: [],
  };
  for (const record of records) {
    result.declared.push(record.name);
    const outcome = await db.seedProjectAgentOnce(record);
    if (outcome === 'created') result.created.push(record.name);
    else if (outcome === 'adopted') result.adopted.push(record.name);
    else result.alreadySeeded.push(record.name);
  }
  return result;
}
