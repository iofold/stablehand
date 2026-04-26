import type { AgentDefinition } from '../../types.js';

export type RuntimeSandboxSecrets = Readonly<Record<string, string>>;

type RuntimeAgentDefinition = AgentDefinition & {
  runtimeSandboxSecrets?: RuntimeSandboxSecrets;
};

export function getRuntimeSandboxSecrets(agentDef: AgentDefinition): RuntimeSandboxSecrets {
  return (agentDef as RuntimeAgentDefinition).runtimeSandboxSecrets ?? {};
}

export function withRuntimeSandboxSecrets(
  agentDef: AgentDefinition,
  secrets?: RuntimeSandboxSecrets,
): AgentDefinition {
  if (!secrets || Object.keys(secrets).length === 0) {
    return agentDef;
  }

  return {
    ...agentDef,
    runtimeSandboxSecrets: { ...secrets },
  } as RuntimeAgentDefinition;
}
