export type Preset = 'docker';

export interface CTXMillConfig {
  /** Project name */
  name?: string;
  /** Project version */
  version?: string;
  preset?: Preset;
  /** Agent directory globs */
  agents?: string[];
  /** Tool file globs or executor config */
  tools?: string[] | { executors: string[] };
  /** UI component whitelist */
  ui?: { components?: string[] };
  execution?: {
    type: 'docker';
    warmPool?: number;
    /** Maximum number of concurrent sandbox containers. Default: 20, env: CTXMILL_MAX_GLOBAL_CONTAINERS */
    maxGlobalContainers?: number;
  };
  database?: {
    type?: 'postgres';
    url?: string;
    extensions?: string[];
  };
  security?: { preset: string; authz?: Record<string, unknown> };
  orchestration?: { eventBus?: boolean; reconciliation?: boolean };
  observability?: { sink?: string; sinks?: string[]; path?: string };
}

// Resolved config (all fields required after preset expansion)
export interface ResolvedConfig {
  execution: { type: 'docker'; warmPool: number; maxGlobalContainers: number };
  database: { type: 'postgres'; url: string };
  tools: { executors: string[] };
  security: { preset: string };
  orchestration: { eventBus: boolean; reconciliation: boolean };
  observability: { sink: string; path: string };
}
