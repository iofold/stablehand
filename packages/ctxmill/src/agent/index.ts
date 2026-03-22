import type { AgentDefinition } from '../types.js';

export function defineAgent(def: AgentDefinition): AgentDefinition {
  return def;
}

export { discoverAgents } from './discovery.js';
