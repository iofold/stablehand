import type { AgentDefinition } from '@stablehand/sandbox-daemon';

export function defineAgent(def: AgentDefinition): AgentDefinition {
  return def;
}

export { discoverAgents } from './discovery.js';
