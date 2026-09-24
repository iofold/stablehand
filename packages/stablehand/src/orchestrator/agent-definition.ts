import { dirname } from 'node:path';
import {
  BuiltinToolPolicySchema,
  NativeToolPolicySchema,
  type BuiltinToolPolicy,
  type NativeToolPolicy,
} from '@stablehand/contracts';

import type { DatabaseRepository } from '../database/repository.js';
import type { AgentDefinition, AgentResourceLimits } from '@stablehand/sandbox-daemon';

/**
 * Canonical stored-agent → AgentDefinition shaping (ctx-8l4).
 *
 * This module is the single source of truth for how a stored agent row
 * becomes the AgentDefinition the runtime enforces. It is deliberately pure
 * and secret-free. Stable agent secrets are resolved by sandbox lifecycle
 * services; ephemeral turn secrets travel only on DeliverTurn.
 */

export type StoredAgent = NonNullable<Awaited<ReturnType<DatabaseRepository['getAgent']>>>;

export type WorkspaceContent = { files?: Array<{ src: string; dest: string }> };
export type AgentMode = 'interactive' | 'background' | 'both';

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

/** Precedence: an explicit API override, then the canonical manifest sandbox resource block. */
export function resolveResourceLimits(agent: StoredAgent): AgentResourceLimits | undefined {
  const manifest = isObjectRecord(agent.manifest) ? agent.manifest : undefined;
  const manifestSpec = isObjectRecord(manifest?.spec) ? manifest.spec : undefined;
  const manifestResources = isObjectRecord(manifestSpec?.resources) ? manifestSpec.resources : undefined;
  const metadata = isObjectRecord(agent.metadata) ? agent.metadata : undefined;

  return (metadata?.resourceLimits ??
    manifestResources?.sandbox) as AgentResourceLimits | undefined;
}

/** Top-level API values persisted in metadata override their canonical manifest counterparts. */
export function extractManifestRuntimeFields(agent: StoredAgent): {
  builtinToolPolicy?: BuiltinToolPolicy;
  nativeToolPolicy?: NativeToolPolicy;
  workspaceContent?: WorkspaceContent;
  mode?: AgentMode;
} {
  const manifest = isObjectRecord(agent.manifest) ? agent.manifest : undefined;
  const manifestSpec = isObjectRecord(manifest?.spec) ? manifest.spec : undefined;
  const metadata = isObjectRecord(agent.metadata) ? agent.metadata : {};
  const workspace = isObjectRecord(manifestSpec?.workspace) ? manifestSpec.workspace : undefined;

  const builtinToolPolicyCandidate = 'builtinToolPolicy' in metadata
    ? metadata.builtinToolPolicy
    : manifestSpec?.builtinToolPolicy;
  const builtinToolPolicy = builtinToolPolicyCandidate === undefined
    ? undefined
    : BuiltinToolPolicySchema.parse(builtinToolPolicyCandidate);
  const nativeToolPolicyCandidate = 'nativeToolPolicy' in metadata
    ? metadata.nativeToolPolicy
    : manifestSpec?.nativeToolPolicy;
  const nativeToolPolicy = nativeToolPolicyCandidate === undefined
    ? undefined
    : NativeToolPolicySchema.parse(nativeToolPolicyCandidate);
  const workspaceContent = ('workspaceContent' in metadata
    ? metadata.workspaceContent
    : workspace?.content) as WorkspaceContent | undefined;
  const mode = ('mode' in metadata
    ? metadata.mode
    : manifestSpec?.mode) as AgentMode | undefined;

  return {
    ...(builtinToolPolicy ? { builtinToolPolicy } : {}),
    ...(nativeToolPolicy ? { nativeToolPolicy } : {}),
    ...(workspaceContent ? { workspaceContent } : {}),
    ...(mode ? { mode } : {}),
  };
}

export function buildAgentDefinition(agent: StoredAgent): AgentDefinition {
  const harnessConfig = parseStoredHarnessConfig(agent.harnessConfig);
  const resourceLimits = resolveResourceLimits(agent);
  const {
    builtinToolPolicy,
    nativeToolPolicy,
    workspaceContent,
    mode,
  } = extractManifestRuntimeFields(agent);
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
    ...(builtinToolPolicy ? { builtinToolPolicy } : {}),
    ...(nativeToolPolicy ? { nativeToolPolicy } : {}),
    ...(workspaceContent ? { workspaceContent } : {}),
    ...(mode ? { mode } : {}),
  };
}

export function resolveAgentToolNames(
  agentDef: Pick<AgentDefinition, 'tools' | 'metadata'>,
): string[] {
  const names = new Set(agentDef.tools ?? []);
  const httpTools = agentDef.metadata?.httpTools;
  if (!Array.isArray(httpTools)) {
    return [...names];
  }

  for (const tool of httpTools) {
    if (isObjectRecord(tool) && typeof tool.name === 'string') {
      names.add(tool.name);
    }
  }
  return [...names];
}
