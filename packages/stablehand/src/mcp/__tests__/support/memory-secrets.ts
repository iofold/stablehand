import type { SecretProvider } from '../../../secrets/types.js';

/** SecretProvider over a Map, keyed like the Postgres table (agent, tool id, key). */
export class MemorySecretProvider implements SecretProvider {
  readonly values = new Map<string, string>();

  private key(agentId: string, key: string, toolId?: string): string {
    return `${agentId}\u0000${toolId ?? ''}\u0000${key}`;
  }

  async get(agentId: string, key: string, toolId?: string): Promise<string | null> {
    return this.values.get(this.key(agentId, key, toolId)) ?? null;
  }

  async set(agentId: string, key: string, value: string, toolId?: string): Promise<void> {
    this.values.set(this.key(agentId, key, toolId), value);
  }

  async delete(agentId: string, key: string, toolId?: string): Promise<void> {
    this.values.delete(this.key(agentId, key, toolId));
  }

  async list(agentId: string, toolId?: string): Promise<string[]> {
    const prefix = `${agentId}\u0000${toolId ?? ''}\u0000`;
    return [...this.values.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length));
  }
}
