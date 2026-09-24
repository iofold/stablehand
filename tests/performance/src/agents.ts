import type {
  Agent,
  AgentCreateInput,
} from '../../../packages/contracts/src/index.js';
import type {
  StablehandControlClient,
} from '../../../packages/client/src/index.js';

import type { PerformanceStage } from './profile.js';

const PERFORMANCE_OWNER_KEY = 'stablehand.performance.managed';

export function benchmarkAgentName(
  stage: PerformanceStage,
  zeroBasedIndex: number,
): string {
  return `${stage.agentPrefix}-${String(zeroBasedIndex + 1).padStart(2, '0')}`;
}

export function benchmarkAgentInput(
  stage: PerformanceStage,
  zeroBasedIndex: number,
): AgentCreateInput {
  return {
    name: benchmarkAgentName(stage, zeroBasedIndex),
    harness: stage.harness,
    harnessConfig: stage.harnessConfig,
    systemPrompt: stage.systemPrompt,
    tools: [],
    mode: 'interactive',
    description: `Managed STABLEHAND performance agent for stage ${stage.name}`,
    metadata: {
      [PERFORMANCE_OWNER_KEY]: true,
      'stablehand.performance.stage': stage.name,
    },
  };
}

export function isManagedBenchmarkAgent(
  metadata: Record<string, unknown> | null,
): boolean {
  return metadata?.[PERFORMANCE_OWNER_KEY] === true;
}

type AgentInventoryClient = Pick<StablehandControlClient, 'agents'>;

function sameConfig(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function reconcileBenchmarkAgents(
  client: AgentInventoryClient,
  stage: PerformanceStage,
): Promise<Agent[]> {
  const desiredCount = stage.topology === 'hot-agent' ? 1 : stage.concurrency;
  const existing = await client.agents.list();
  const byName = new Map(existing.map((agent) => [agent.name, agent]));
  const agents: Agent[] = [];

  for (let index = 0; index < desiredCount; index++) {
    const input = benchmarkAgentInput(stage, index);
    const current = byName.get(input.name);
    if (!current) {
      agents.push(await client.agents.create(input));
      continue;
    }
    if (!isManagedBenchmarkAgent(current.metadata)) {
      throw new Error(
        `Refusing to replace non-benchmark agent named ${input.name}`,
      );
    }
    const shouldUpdate =
      current.harness !== input.harness
      || current.systemPrompt !== input.systemPrompt
      || !sameConfig(current.harnessConfig, input.harnessConfig)
      || !sameConfig(current.metadata ?? {}, input.metadata ?? {});
    if (shouldUpdate) {
      agents.push(await client.agents.update(current.id, input));
    } else {
      agents.push(current);
    }
  }

  return agents;
}
