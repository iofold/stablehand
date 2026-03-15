import type { AgentDefinition } from '../types.js';
import type { AgentModelConfig } from '../harness/types.js';
import type { AgentManifest, ManifestToolRef } from './types.js';

function toolRefToName(toolRef: ManifestToolRef): string {
  if ('ref' in toolRef) return toolRef.ref;
  if ('mcp' in toolRef) return toolRef.mcp.name;
  return toolRef.inline.name;
}

export function manifestToDefinition(manifest: AgentManifest): AgentDefinition {
  const { metadata, spec } = manifest;

  const modelConfig: AgentModelConfig = {
    provider: spec.model.provider,
    model: spec.model.id,
    baseUrl: spec.model.baseUrl,
    apiKeyRef: spec.model.apiKeyRef,
    temperature: spec.model.temperature,
    maxTokens: spec.model.maxTokens,
    topP: spec.model.topP,
    reasoning: spec.model.reasoning,
  };

  return {
    name: metadata.name,
    model: spec.model.id,
    harness: spec.harness,
    modelConfig,
    tools: spec.tools?.map(toolRefToName) ?? [],
    systemPrompt: spec.instructions,
    description: metadata.description,
    mode: spec.mode,
  };
}

export function definitionToManifest(
  def: AgentDefinition,
  existingLabels?: Record<string, string>,
): AgentManifest {
  const provider = def.modelConfig?.provider ?? 'openai';
  const modelId = def.modelConfig?.model ?? def.model;

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
      harness: def.harness ?? 'langgraph',
      model: {
        provider,
        id: modelId,
        ...(def.modelConfig?.baseUrl ? { baseUrl: def.modelConfig.baseUrl } : {}),
        ...(def.modelConfig?.apiKeyRef ? { apiKeyRef: def.modelConfig.apiKeyRef } : {}),
        ...(def.modelConfig?.temperature !== undefined ? { temperature: def.modelConfig.temperature } : {}),
        ...(def.modelConfig?.maxTokens !== undefined ? { maxTokens: def.modelConfig.maxTokens } : {}),
        ...(def.modelConfig?.topP !== undefined ? { topP: def.modelConfig.topP } : {}),
        ...(def.modelConfig?.reasoning ? { reasoning: def.modelConfig.reasoning } : {}),
      },
      instructions: def.systemPrompt,
      tools: def.tools.map((t) => ({ ref: t })),
      ...(def.mode ? { mode: def.mode } : {}),
    },
  };
}
