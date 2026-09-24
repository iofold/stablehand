import { AgentSchema, type Agent } from '@stablehand/contracts';

type AgentFixtureOverrides = Partial<Omit<Agent, 'id'>> & { id?: string };

export function makeAgentFixture(overrides: AgentFixtureOverrides = {}): Agent {
  return AgentSchema.parse({
    id: 'agent-1',
    name: 'Agent 1',
    harness: 'langgraph',
    harnessConfig: { provider: 'openai', model: 'gpt-5.4-mini' },
    systemPrompt: 'Be useful.',
    tools: [],
    description: null,
    workspaceDir: '/workspace',
    status: 'idle',
    manifest: null,
    metadata: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    builtinToolPolicy: null,
    nativeToolPolicy: null,
    httpTools: [],
    workspaceContent: null,
    mode: null,
    resourceLimits: null,
    ...overrides,
  });
}
