import {
  ClaudeAgentsConfigSchema,
  LangGraphConfigSchema,
  PIAgentConfigSchema,
} from '@ctxmill/contracts/harness';
import { isCertifiedNativeModelGatewayProvider } from '@ctxmill/shared';
import { toOpaqueTurnCorrelation } from '@ctxmill/sandbox-daemon/harness/model-gateway';

export type ModelGatewayTurnAttribution =
  | { mode: 'direct' }
  | {
      mode: 'gateway_only' | 'mixed';
      profile: 'default';
      revision: string;
      correlationId: string;
    };

interface ResolveModelGatewayTurnAttributionInput {
  harness: string;
  harnessConfig: Record<string, unknown>;
  gateway:
    | { enabled: false }
    | { enabled: true; profile: 'default'; revision: string };
  turnId: string;
}

type Branch = {
  provider: 'openai' | 'anthropic' | 'google';
  apiKeyRef?: string;
  baseUrl?: string;
};

function connectionMode(branch: Branch): 'direct' | 'gateway' {
  if (branch.apiKeyRef !== undefined || branch.baseUrl !== undefined) {
    return 'direct';
  }
  return isCertifiedNativeModelGatewayProvider(branch.provider)
    ? 'gateway'
    : 'direct';
}

function langGraphBranches(
  harnessConfig: Record<string, unknown>,
): Branch[] {
  const config = LangGraphConfigSchema.parse(harnessConfig);
  const branches: Branch[] = [{
    provider: config.provider,
    ...(config.apiKeyRef !== undefined ? { apiKeyRef: config.apiKeyRef } : {}),
    ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
  }];
  for (const subagent of config.subagents ?? []) {
    if (subagent.model === undefined && subagent.provider === undefined) {
      continue;
    }
    branches.push({
      provider: subagent.provider ?? config.provider,
      ...(subagent.apiKeyRef ?? config.apiKeyRef
        ? { apiKeyRef: subagent.apiKeyRef ?? config.apiKeyRef }
        : {}),
      ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
    });
  }
  return branches;
}

function branchesForHarness(
  harness: string,
  harnessConfig: Record<string, unknown>,
): Branch[] | undefined {
  if (harness === 'langgraph') {
    return langGraphBranches(harnessConfig);
  }
  if (harness === 'claude-agents') {
    const config = ClaudeAgentsConfigSchema.parse(harnessConfig);
    return [{
      provider: 'anthropic',
      ...(config.apiKeyRef !== undefined ? { apiKeyRef: config.apiKeyRef } : {}),
      ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
    }];
  }
  if (harness === 'pi-agent') {
    const config = PIAgentConfigSchema.parse(harnessConfig);
    return [{
      provider: config.provider,
      ...(config.apiKeyRef !== undefined ? { apiKeyRef: config.apiKeyRef } : {}),
      ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
    }];
  }
  return undefined;
}

export function resolveModelGatewayTurnAttribution(
  input: ResolveModelGatewayTurnAttributionInput,
): ModelGatewayTurnAttribution {
  if (!input.gateway.enabled) {
    return { mode: 'direct' };
  }

  const branches = branchesForHarness(input.harness, input.harnessConfig);
  if (!branches) {
    return { mode: 'direct' };
  }
  const modes = new Set(branches.map(connectionMode));
  if (!modes.has('gateway')) {
    return { mode: 'direct' };
  }

  return {
    mode: modes.has('direct') ? 'mixed' : 'gateway_only',
    profile: input.gateway.profile,
    revision: input.gateway.revision,
    correlationId: toOpaqueTurnCorrelation(input.turnId),
  };
}
