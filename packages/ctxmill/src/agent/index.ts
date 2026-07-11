import type { AgentDefinition } from '@ctxmill/sandbox-daemon';

export function defineAgent(def: AgentDefinition): AgentDefinition {
  return def;
}

export { discoverAgents } from './discovery.js';
