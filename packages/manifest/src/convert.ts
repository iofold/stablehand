import {
  AgentCreateInputSchema,
  AgentPatchInputSchema,
  type AgentCreateInput,
  type AgentPatchInput,
} from '@ctxmill/contracts';

import type { AgentManifest } from './types.js';

export interface ManifestConversionOptions {
  resolvedInstructions?: string;
  workspaceContent?: {
    files?: Array<{ src: string; dest: string }>;
  };
}

function assertRepresentableManifest(manifest: AgentManifest): void {
  const unsupportedTool = manifest.spec.tools?.find((tool) => !('ref' in tool));
  if (unsupportedTool) {
    const kind = 'mcp' in unsupportedTool ? 'MCP' : 'inline';
    throw new Error(
      `${kind} tool definitions cannot be registered by the agent create contract; register the tool separately and use a ref`,
    );
  }
  if (manifest.spec.triggers?.length) {
    throw new Error('Manifest triggers cannot be registered by the agent create contract');
  }
  if (manifest.spec.emits?.length) {
    throw new Error('Manifest emit declarations cannot be registered by the agent create contract');
  }
  if (manifest.spec.hitl?.approvals?.length) {
    throw new Error('Manifest HITL policies cannot be registered by the agent create contract');
  }
}

function resolveSystemPrompt(
  manifest: AgentManifest,
  options: ManifestConversionOptions,
): string {
  if (options.resolvedInstructions !== undefined) {
    return options.resolvedInstructions;
  }
  if (manifest.spec.instructions.startsWith('file:')) {
    throw new Error(
      'File-backed instructions require loadManifestProject from @ctxmill/manifest/node',
    );
  }
  return manifest.spec.instructions;
}

function manifestMetadata(manifest: AgentManifest): Record<string, unknown> | undefined {
  const metadata: Record<string, unknown> = {};
  if (manifest.metadata.displayName !== undefined) {
    metadata.displayName = manifest.metadata.displayName;
  }
  if (manifest.metadata.labels !== undefined) {
    metadata.labels = manifest.metadata.labels;
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function toAgentInputCandidate(
  manifest: AgentManifest,
  options: ManifestConversionOptions,
): Record<string, unknown> {
  assertRepresentableManifest(manifest);

  const metadata = manifestMetadata(manifest);
  const resourceLimits = manifest.spec.resources?.sandbox;
  const workspaceContent = options.workspaceContent ?? manifest.spec.workspace?.content;

  return {
    name: manifest.metadata.name,
    harness: manifest.spec.harness,
    harnessConfig: manifest.spec.harnessConfig,
    systemPrompt: resolveSystemPrompt(manifest, options),
    tools: manifest.spec.tools?.map((tool) => {
      if (!('ref' in tool)) {
        throw new Error('Unreachable unsupported tool definition');
      }
      return tool.ref;
    }) ?? [],
    ...(manifest.spec.builtinToolPolicy
      ? { builtinToolPolicy: manifest.spec.builtinToolPolicy }
      : {}),
    ...(manifest.metadata.description !== undefined
      ? { description: manifest.metadata.description }
      : {}),
    ...(metadata ? { metadata } : {}),
    ...(manifest.spec.nativeToolPolicy
      ? { nativeToolPolicy: manifest.spec.nativeToolPolicy }
      : {}),
    ...(workspaceContent ? { workspaceContent } : {}),
    ...(resourceLimits ? { resourceLimits } : {}),
    ...(manifest.spec.mode ? { mode: manifest.spec.mode } : {}),
    manifest,
  };
}

export function manifestToAgentCreateInput(
  manifest: AgentManifest,
  options: ManifestConversionOptions = {},
): AgentCreateInput {
  return AgentCreateInputSchema.parse(toAgentInputCandidate(manifest, options));
}

export function manifestToAgentPatchInput(
  manifest: AgentManifest,
  options: ManifestConversionOptions = {},
): AgentPatchInput {
  return AgentPatchInputSchema.parse(toAgentInputCandidate(manifest, options));
}
