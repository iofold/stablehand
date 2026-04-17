export interface SecretProvider {
  get(agentId: string, key: string, toolId?: string): string | null;
  set(agentId: string, key: string, value: string, toolId?: string): void | Promise<void>;
  delete(agentId: string, key: string, toolId?: string): void | Promise<void>;
  deleteForAgent?(agentId: string): void | Promise<void>;
  list(agentId: string, toolId?: string): string[];
}
