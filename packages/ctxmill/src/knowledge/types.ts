export interface KnowledgeItem {
  id: string;
  agentId: string;
  content: string;
  category: string; // 'strategy' | 'fact' | 'preference' | 'correction'
  source: string; // 'reflector' | 'human' | 'seed'
  effectiveness: number; // -1 to 1
  createdAt: Date;
  updatedAt: Date;
}

export interface ContextItem {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  score: number; // relevance score 0-1
}

export interface ContextQuery {
  text?: string;
  embedding?: number[];
  filters?: Record<string, unknown>;
  namespace?: string;
  limit?: number;
  minScore?: number;
  mode?: 'semantic' | 'keyword' | 'hybrid';
}

export interface ContextResult {
  items: ContextItem[];
  totalCount: number;
}

export interface KnowledgeSearchOptions {
  q?: string;
  category?: string;
  limit?: number;
  offset?: number;
}

export interface KnowledgeSearchResult {
  items: KnowledgeItem[];
  total: number;
}

export interface KnowledgeStats {
  totalItems: number;
  categories: Record<string, number>;
  recentItems: number;
  oldestItem?: Date;
  newestItem?: Date;
}

// Knowledge store interface
export interface KnowledgeStore {
  add(
    item: Omit<KnowledgeItem, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<KnowledgeItem>;
  get(id: string): Promise<KnowledgeItem | null>;
  list(agentId: string): Promise<KnowledgeItem[]>;
  search(agentId: string, options: KnowledgeSearchOptions): Promise<KnowledgeSearchResult>;
  stats(agentId: string): Promise<KnowledgeStats>;
  update(id: string, updates: Partial<KnowledgeItem>): Promise<KnowledgeItem>;
  remove(id: string): Promise<void>;
  render(agentId: string): Promise<string>;
}

// Context provider interface
export interface ContextProvider {
  readonly name: string;
  query(request: ContextQuery): Promise<ContextResult>;
  get(id: string): Promise<ContextItem | null>;
  put?(item: Omit<ContextItem, 'id'>): Promise<ContextItem>;
  delete?(id: string): Promise<void>;
  healthy(): Promise<boolean>;
}
