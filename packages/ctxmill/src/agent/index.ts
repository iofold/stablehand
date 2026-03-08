import type { AgentDefinition } from '../types.js';

export function defineAgent(def: AgentDefinition): AgentDefinition {
  return def;
}

export { AgentExecutor } from './executor.js';
export { discoverAgents } from './discovery.js';
