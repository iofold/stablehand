import type { DatabaseRepository } from '../database/repository.js';
import type { AgentDefinition } from '../types.js';
import { ensureAgentWorkspace, seedAgentWorkspace } from '../workspace/ensure.js';
import type { AgentManifest } from './types.js';
import { validateManifest } from './validate.js';
import { parseManifestString, serializeManifestYAML, serializeManifestJSON } from './parser.js';
import { manifestToDefinition, definitionToManifest } from './convert.js';

export class ManifestService {
  private readonly db: DatabaseRepository;
  private readonly dataDir: string | undefined;

  constructor(db: DatabaseRepository, dataDir?: string) {
    this.db = db;
    this.dataDir = dataDir;
  }

  private parseHarnessConfig(harnessConfigJson: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(harnessConfigJson);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }

    return {};
  }

  async importManifest(
    content: string,
    opts?: { changedBy?: string; changeNote?: string; projectDir?: string },
  ): Promise<{ agentId: string; created: boolean; manifest: AgentManifest }> {
    const raw = parseManifestString(content);
    const manifest = validateManifest(raw);
    const def = manifestToDefinition(manifest, { projectDir: opts?.projectDir });

    const agents = await this.db.listAgents();
    const existing = agents.find((a) => a.name === manifest.metadata.name);

    if (existing) {
      await this.db.updateAgent(existing.id, {
        name: def.name,
        harness: def.harness,
        harnessConfig: JSON.stringify(def.harnessConfig),
        systemPrompt: def.systemPrompt,
        tools: def.tools,
        description: def.description,
      });
      await this.db.saveAgentManifest(
        existing.id,
        manifest as unknown as Record<string, unknown>,
        opts?.changedBy,
        opts?.changeNote,
      );
      return { agentId: existing.id, created: false, manifest };
    }

    const agent = await this.db.createAgent({
      name: def.name,
      harness: def.harness,
      harnessConfig: JSON.stringify(def.harnessConfig),
      systemPrompt: def.systemPrompt,
      tools: def.tools,
      description: def.description,
      manifest: manifest as unknown as Record<string, unknown>,
    });

    if (this.dataDir) {
      const workspaceDir = ensureAgentWorkspace(this.dataDir, agent.id);
      seedAgentWorkspace(workspaceDir);
      await this.db.updateAgent(agent.id, { workspaceDir });
    }

    return { agentId: agent.id, created: true, manifest };
  }

  async exportManifest(agentId: string, format: 'yaml' | 'json' = 'yaml'): Promise<string> {
    const agent = await this.db.getAgent(agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    let manifest: AgentManifest;

    const stored = await this.db.getAgentManifest(agentId);
    if (stored) {
      manifest = stored as unknown as AgentManifest;
    } else {
      const def: AgentDefinition = {
        name: agent.name,
        harness: agent.harness,
        harnessConfig: this.parseHarnessConfig(agent.harnessConfig),
        systemPrompt: agent.systemPrompt,
        tools: agent.tools,
        description: agent.description ?? undefined,
      };
      manifest = definitionToManifest(def);
    }

    return format === 'json'
      ? serializeManifestJSON(manifest)
      : serializeManifestYAML(manifest);
  }

  async updateManifest(
    agentId: string,
    manifest: AgentManifest,
    opts?: { changedBy?: string; changeNote?: string; projectDir?: string },
  ): Promise<void> {
    validateManifest(manifest);
    const def = manifestToDefinition(manifest, { projectDir: opts?.projectDir });

    const agent = await this.db.getAgent(agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    await this.db.updateAgent(agentId, {
      name: def.name,
      harness: def.harness,
      harnessConfig: JSON.stringify(def.harnessConfig),
      systemPrompt: def.systemPrompt,
      tools: def.tools,
      description: def.description,
    });
    await this.db.saveAgentManifest(
      agentId,
      manifest as unknown as Record<string, unknown>,
      opts?.changedBy,
      opts?.changeNote,
    );
  }

  async syncFromDefinition(agentId: string, def: AgentDefinition): Promise<void> {
    const stored = await this.db.getAgentManifest(agentId);
    if (stored) {
      return;
    }

    const manifest = definitionToManifest(def);
    await this.db.saveAgentManifest(
      agentId,
      manifest as unknown as Record<string, unknown>,
    );
  }
}
