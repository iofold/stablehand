import { dirname } from 'node:path';

import type { DatabaseRepository } from '../database/repository.js';
import type { AgentDefinition, AgentResourceLimits } from '../types.js';

interface Logger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
}

export interface RunStartupServiceDeps {
  logger: Logger;
}

type StoredAgent = NonNullable<Awaited<ReturnType<DatabaseRepository['getAgent']>>>;

type NativeTools = { allowlist?: string[]; blocklist?: string[] };
type WorkspaceContent = { files?: Array<{ src: string; dest: string }> };

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class RunStartupService {
  constructor(private readonly deps: RunStartupServiceDeps) {}

  buildAgentDefinition(agent: StoredAgent): AgentDefinition {
    this.deps.logger.debug('Building startup agent definition for %s', agent.name);

    const harnessConfig = this.parseHarnessConfig(agent.harnessConfig);
    const resourceLimits = this.resolveResourceLimits(agent);
    const { nativeTools, workspaceContent } = this.extractManifestFields(agent);
    const workspaceDir = agent.workspaceDir ?? undefined;

    return {
      name: agent.name,
      harness: agent.harness,
      harnessConfig,
      tools: agent.tools,
      systemPrompt: agent.systemPrompt,
      description: agent.description ?? undefined,
      metadata: agent.metadata ?? undefined,
      workspaceDir,
      projectDir: workspaceDir ? dirname(workspaceDir) : undefined,
      resourceLimits,
      ...(nativeTools ? { nativeTools } : {}),
      ...(workspaceContent ? { workspaceContent } : {}),
    };
  }

  parseHarnessConfig(configJson: string | null | undefined): Record<string, unknown> {
    if (!configJson) {
      return {};
    }

    const parsed = JSON.parse(configJson) as unknown;
    if (!isObjectRecord(parsed)) {
      throw new Error('Stored harnessConfig must be a JSON object');
    }
    return parsed;
  }

  resolveResourceLimits(agent: StoredAgent): AgentResourceLimits | undefined {
    const manifest = isObjectRecord(agent.manifest) ? agent.manifest : undefined;
    const manifestSpec = isObjectRecord(manifest?.spec) ? manifest.spec : undefined;
    const metadata = isObjectRecord(agent.metadata) ? agent.metadata : undefined;

    return (manifest?.resourceLimits ??
      manifestSpec?.resources ??
      metadata?.resourceLimits) as AgentResourceLimits | undefined;
  }

  extractManifestFields(agent: StoredAgent): {
    nativeTools?: NativeTools;
    workspaceContent?: WorkspaceContent;
  } {
    const manifest = isObjectRecord(agent.manifest) ? agent.manifest : undefined;
    const manifestSpec = isObjectRecord(manifest?.spec) ? manifest.spec : undefined;
    const metadata = isObjectRecord(agent.metadata) ? agent.metadata : {};
    const workspace = isObjectRecord(manifestSpec?.workspace) ? manifestSpec.workspace : undefined;

    const nativeTools = ('nativeTools' in metadata
      ? metadata.nativeTools
      : manifestSpec?.nativeTools) as NativeTools | undefined;
    const workspaceContent = workspace?.content as WorkspaceContent | undefined;

    return {
      ...(nativeTools ? { nativeTools } : {}),
      ...(workspaceContent ? { workspaceContent } : {}),
    };
  }
}

export type { StoredAgent };
