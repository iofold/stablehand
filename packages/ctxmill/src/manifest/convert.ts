import {
  normalizeLLMProvider,
  supportedLLMProviderDescription,
  type CanonicalLLMProvider,
} from '@ctxmill/shared';
import type { AgentDefinition, AgentResourceLimits } from '@ctxmill/sandbox-daemon';
import type { AgentManifest, ManifestToolRef } from './types.js';

function toolRefToName(toolRef: ManifestToolRef): string {
  if ('ref' in toolRef) return toolRef.ref;
  if ('mcp' in toolRef) return toolRef.mcp.name;
  return toolRef.inline.name;
}

function requireCanonicalProvider(provider: string): CanonicalLLMProvider {
  const normalized = normalizeLLMProvider(provider);
  if (!normalized) {
    throw new Error(`Unsupported LLM provider "${provider}". Supported providers: ${supportedLLMProviderDescription()}`);
  }
  return normalized;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeProviderField(config: Record<string, unknown>): Record<string, unknown> {
  const result = { ...config };
  if (typeof result.provider === 'string') {
    result.provider = requireCanonicalProvider(result.provider);
  }
  return result;
}

function normalizeSubagentProviders(subagents: unknown): unknown {
  if (Array.isArray(subagents)) {
    return subagents.map((subagent) => (
      isObjectRecord(subagent) ? normalizeProviderField(subagent) : subagent
    ));
  }

  if (isObjectRecord(subagents)) {
    return Object.fromEntries(Object.entries(subagents).map(([name, subagent]) => [
      name,
      isObjectRecord(subagent) ? normalizeProviderField(subagent) : subagent,
    ]));
  }

  return subagents;
}

function normalizeHarnessConfigProviders(config: Record<string, unknown>): Record<string, unknown> {
  const result = normalizeProviderField(config);
  if ('subagents' in result) {
    result.subagents = normalizeSubagentProviders(result.subagents);
  }
  return result;
}

function resolveHarnessConfig(spec: AgentManifest['spec']): Record<string, unknown> {
  if (spec.harnessConfig) {
    return normalizeHarnessConfigProviders(spec.harnessConfig);
  }

  if (!spec.model) {
    throw new Error('Manifest spec requires model or harnessConfig');
  }

  return {
    provider: requireCanonicalProvider(spec.model.provider),
    model: spec.model.id,
    ...(spec.model.baseUrl ? { baseUrl: spec.model.baseUrl } : {}),
    ...(spec.model.apiKeyRef ? { apiKeyRef: spec.model.apiKeyRef } : {}),
    ...(spec.model.temperature !== undefined ? { temperature: spec.model.temperature } : {}),
    ...(spec.model.maxTokens !== undefined ? { maxTokens: spec.model.maxTokens } : {}),
    ...(spec.model.topP !== undefined ? { topP: spec.model.topP } : {}),
    ...(spec.model.reasoning ? { reasoning: spec.model.reasoning } : {}),
  };
}

export function manifestToDefinition(
  manifest: AgentManifest,
  context?: { projectDir?: string },
): AgentDefinition {
  const { metadata, spec } = manifest;
  const harnessConfig = resolveHarnessConfig(spec);

  // Extract sandbox resource limits from manifest resources if present
  let resourceLimits: AgentResourceLimits | undefined;
  if (spec.resources?.sandbox) {
    const s = spec.resources.sandbox;
    resourceLimits = {
      ...(s.cpus !== undefined ? { cpus: s.cpus } : {}),
      ...(s.memoryMb !== undefined ? { memoryMb: s.memoryMb } : {}),
      ...(s.pidsLimit !== undefined ? { pidsLimit: s.pidsLimit } : {}),
      ...(s.timeoutSec !== undefined ? { timeoutSec: s.timeoutSec } : {}),
    };
    // Only set if at least one field is present
    if (Object.keys(resourceLimits).length === 0) {
      resourceLimits = undefined;
    }
  }

  return {
    name: metadata.name,
    harness: spec.harness,
    harnessConfig,
    tools: spec.tools?.map(toolRefToName) ?? [],
    systemPrompt: spec.instructions,
    description: metadata.description,
    mode: spec.mode,
    ...(context?.projectDir ? { projectDir: context.projectDir } : {}),
    ...(spec.nativeTools
      ? {
          nativeTools: {
            ...(spec.nativeTools.allowlist ? { allowlist: spec.nativeTools.allowlist } : {}),
            ...(spec.nativeTools.blocklist ? { blocklist: spec.nativeTools.blocklist } : {}),
          },
        }
      : {}),
    ...(spec.workspace?.content
      ? {
          workspaceContent: {
            ...(spec.workspace.content.files ? { files: spec.workspace.content.files } : {}),
          },
        }
      : {}),
    ...(resourceLimits ? { resourceLimits } : {}),
  };
}

export function definitionToManifest(
  def: AgentDefinition,
  existingLabels?: Record<string, string>,
): AgentManifest {
  // Build resources section, including sandbox limits if present
  const resources: Record<string, unknown> = {};
  if (def.resourceLimits) {
    const sandbox: Record<string, unknown> = {};
    if (def.resourceLimits.cpus !== undefined) sandbox.cpus = def.resourceLimits.cpus;
    if (def.resourceLimits.memoryMb !== undefined) sandbox.memoryMb = def.resourceLimits.memoryMb;
    if (def.resourceLimits.pidsLimit !== undefined) sandbox.pidsLimit = def.resourceLimits.pidsLimit;
    if (def.resourceLimits.timeoutSec !== undefined) sandbox.timeoutSec = def.resourceLimits.timeoutSec;
    if (Object.keys(sandbox).length > 0) {
      resources.sandbox = sandbox;
    }
  }

  return {
    apiVersion: 'ctxmill.io/v1',
    kind: 'Agent',
    metadata: {
      name: def.name,
      description: def.description,
      ...(existingLabels && Object.keys(existingLabels).length > 0
        ? { labels: existingLabels }
        : {}),
    },
    spec: {
      harness: def.harness,
      ...(def.nativeTools ? { nativeTools: def.nativeTools } : {}),
      harnessConfig: { ...def.harnessConfig },
      instructions: def.systemPrompt,
      tools: def.tools.map((t) => ({ ref: t })),
      ...(def.mode ? { mode: def.mode } : {}),
      ...(def.workspaceContent
        ? {
            workspace: {
              content: {
                ...(def.workspaceContent.files ? { files: def.workspaceContent.files } : {}),
              },
            },
          }
        : {}),
      ...(Object.keys(resources).length > 0 ? { resources: resources as any } : {}),
    },
  };
}
