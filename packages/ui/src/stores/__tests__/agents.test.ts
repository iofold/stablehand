import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '@ctxmill/contracts';
import { makeAgentFixture } from '@/test/agent-fixture';

const mocks = vi.hoisted(() => ({
  fetchAgent: vi.fn(),
  updateAgent: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  fetchAgents: vi.fn(),
  fetchAgent: mocks.fetchAgent,
  startBackgroundRun: vi.fn(),
  cancelTurn: vi.fn(),
  fetchAgentTurns: vi.fn(),
  createAgent: vi.fn(),
  updateAgent: mocks.updateAgent,
  deleteAgent: vi.fn(),
}));

import { useAgentsStore } from '../agents';

const originalAgent = makeAgentFixture({
  name: 'Original Agent',
  systemPrompt: 'Original prompt',
});

describe('agents store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAgentsStore.setState({
      agents: [originalAgent],
      loading: false,
      error: null,
    });
  });

  it('replaces the cached agent with the canonical update response immediately', async () => {
    const updatedAgent: Agent = {
      ...originalAgent,
      name: 'Updated Agent',
      updatedAt: originalAgent.updatedAt + 1,
    };
    const refresh = vi.fn().mockResolvedValue(undefined);
    useAgentsStore.setState({ fetchAgents: refresh });
    mocks.updateAgent.mockResolvedValue(updatedAgent);

    await useAgentsStore.getState().updateAgent(originalAgent.id, { name: updatedAgent.name });

    expect(useAgentsStore.getState().agents).toEqual([updatedAgent]);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('upserts a directly fetched canonical agent', async () => {
    const fetchedAgent = makeAgentFixture({
      id: 'agent-2',
      name: 'Direct Agent',
    });
    mocks.fetchAgent.mockResolvedValue(fetchedAgent);

    await expect(useAgentsStore.getState().fetchAgent('agent-2')).resolves.toEqual(fetchedAgent);

    expect(useAgentsStore.getState().agents).toEqual([originalAgent, fetchedAgent]);
  });
});
