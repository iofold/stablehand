export interface SecretProvider {
  get(agentId: string, key: string, toolId?: string): string | null;
  set(agentId: string, key: string, value: string, toolId?: string): void;
  delete(agentId: string, key: string, toolId?: string): void;
  list(agentId: string, toolId?: string): string[];
}
