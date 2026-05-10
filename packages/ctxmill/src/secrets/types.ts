export interface SecretProvider {
  get(agentId: string, key: string, toolId?: string): Promise<string | null>;
  set(agentId: string, key: string, value: string, toolId?: string): Promise<void>;
  delete(agentId: string, key: string, toolId?: string): Promise<void>;
  deleteForAgent?(agentId: string): Promise<void>;
  list(agentId: string, toolId?: string): Promise<string[]>;
}
