export interface CTXMillConfig {
  /** Project name */
  name?: string;
  /** Project version */
  version?: string;
  database?: {
    url?: string;
  };
}

export interface ResolvedConfig {
  database: { type: 'postgres'; url: string };
}
