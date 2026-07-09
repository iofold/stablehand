import { dirname } from 'node:path';

import type { DatabaseRepository } from '../database/repository.js';
import type { AgentDefinition, AgentResourceLimits } from '../types.js';

/**
 * Canonical stored-agent → AgentDefinition shaping (ctx-8l4).
 *
 * This module is the single source of truth for how a stored agent row
 * becomes the AgentDefinition the runtime enforces. It is deliberately pure
 * and secret-free: runtime sandbox secrets are asymmetric between the startup
 * and resume paths, so each call site applies its own injection
 * (RunStartupService wraps with withRuntimeSandboxSecrets; the resume path
 * re-derives via getRuntimeSandboxSecrets in the runtime factory).
 */

export type StoredAgent = NonNullable<Awaited<ReturnType<DatabaseRepository['getAgent']>>>;

export type NativeTools = { allowlist?: string[]; blocklist?: string[] };
export type WorkspaceContent = { files?: Array<{ src: string; dest: string }> };

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Stored harnessConfig is NOT NULL in schema; null/undefined maps to {} for legacy rows. */
export function parseStoredHarnessConfig(configJson: string | null | undefined): Record<string, unknown> {
  if (!configJson) {
    return {};
  }

  const parsed = JSON.parse(configJson) as unknown;
  if (!isObjectRecord(parsed)) {
    throw new Error('Stored harnessConfig must be a JSON object');
  }
  return parsed;
}

/** Precedence: metadata.resourceLimits ?? manifest.resourceLimits ?? manifest.spec.resources. */
export function resolveResourceLimits(agent: StoredAgent): AgentResourceLimits | undefined {
  const manifest = isObjectRecord(agent.manifest) ? agent.manifest : undefined;
  const manifestSpec = isObjectRecord(manifest?.spec) ? manifest.spec : undefined;
  const metadata = isObjectRecord(agent.metadata) ? agent.metadata : undefined;

  return (metadata?.resourceLimits ??
    manifest?.resourceLimits ??
    manifestSpec?.resources) as AgentResourceLimits | undefined;
}

/** Manifest/metadata-derived runtime fields; a metadata.nativeTools key overrides the manifest. */
export function extractManifestRuntimeFields(agent: StoredAgent): {
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

export function buildAgentDefinition(agent: StoredAgent): AgentDefinition {
  const harnessConfig = parseStoredHarnessConfig(agent.harnessConfig);
  const resourceLimits = resolveResourceLimits(agent);
  const { nativeTools, workspaceContent } = extractManifestRuntimeFields(agent);
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
