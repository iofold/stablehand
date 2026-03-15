import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type {
  KnowledgeItem,
  KnowledgeStore,
  KnowledgeSearchOptions,
  KnowledgeSearchResult,
  KnowledgeStats,
} from './types.js';

/** Sentinel value used for shared (cross-agent) knowledge items. */
export const SHARED_AGENT_ID = '__shared__';

/** JSON-serialized form with ISO 8601 date strings. */
interface SerializedKnowledgeItem {
  id: string;
  agentId: string;
  content: string;
  category: string;
  source: string;
  effectiveness: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Mem0-compatible configuration.
 *
 * When `apiKey` is provided and `mode` is `'cloud'`, the store delegates to
 * the real mem0 MemoryClient. Otherwise it falls back to a local file-backed
 * store that mirrors the mem0 API shape — including shared/cross-agent memory.
 */
export interface Mem0Config {
  /** Mem0 cloud API key. If omitted the local adapter is used. */
  apiKey?: string;
  /** Self-hosted mem0 base URL (overrides default cloud endpoint). */
  host?: string;
  /** Explicit mode override. Defaults to 'cloud' when apiKey is present, else 'local'. */
  mode?: 'cloud' | 'local';
}

/**
 * A KnowledgeStore implementation that:
 *  1. Wraps mem0's MemoryClient when a cloud API key is available.
 *  2. Falls back to a local JSON-file store (like InMemoryKnowledgeStore)
 *     but with full support for shared / cross-agent knowledge.
 *
 * The interface matches CTXMill's KnowledgeStore plus the new shared methods.
 */
export class Mem0KnowledgeStore implements KnowledgeStore {
  private items = new Map<string, KnowledgeItem>();
  private persistPath: string;
  private mem0Client: Mem0CloudClient | null = null;

  constructor(dataDir: string, config?: Mem0Config) {
    this.persistPath = join(dataDir, 'knowledge');
    mkdirSync(this.persistPath, { recursive: true });

    const useCloud =
      config?.mode === 'cloud' || (!config?.mode && !!config?.apiKey);

    if (useCloud && config?.apiKey) {
      this.mem0Client = new Mem0CloudClient(config.apiKey, config.host);
      console.log('[KnowledgeStore] Using mem0 cloud provider');
    } else {
      console.log('[KnowledgeStore] Using local mem0-compatible adapter (shared knowledge enabled)');
      this.loadFromDisk();
    }
  }

  // ── Core KnowledgeStore interface ──────────────────────────────────

  async add(
    item: Omit<KnowledgeItem, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<KnowledgeItem> {
    if (this.mem0Client) {
      return this.mem0Client.addItem(item);
    }
    const now = new Date();
    const knowledgeItem: KnowledgeItem = {
      ...item,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
    this.items.set(knowledgeItem.id, knowledgeItem);
    this.saveToDisk();
    return knowledgeItem;
  }

  async get(id: string): Promise<KnowledgeItem | null> {
    if (this.mem0Client) {
      return this.mem0Client.getItem(id);
    }
    return this.items.get(id) ?? null;
  }

  async list(agentId: string): Promise<KnowledgeItem[]> {
    if (this.mem0Client) {
      return this.mem0Client.listItems(agentId);
    }
    const result: KnowledgeItem[] = [];
    for (const item of this.items.values()) {
      if (item.agentId === agentId) {
        result.push(item);
      }
    }
    return result;
  }

  async search(
    agentId: string,
    options: KnowledgeSearchOptions,
  ): Promise<KnowledgeSearchResult> {
    if (this.mem0Client) {
      return this.mem0Client.searchItems(agentId, options);
    }
    // Search both agent-specific AND shared knowledge
    const filtered: KnowledgeItem[] = [];
    for (const item of this.items.values()) {
      if (item.agentId !== agentId && item.agentId !== SHARED_AGENT_ID) continue;
      if (options.category && item.category !== options.category) continue;
      if (options.q) {
        const query = options.q.toLowerCase();
        if (
          !item.content.toLowerCase().includes(query) &&
          !item.category.toLowerCase().includes(query) &&
          !item.source.toLowerCase().includes(query)
        ) {
          continue;
        }
      }
      filtered.push(item);
    }

    filtered.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const total = filtered.length;
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 50;
    const items = filtered.slice(offset, offset + limit);
    return { items, total };
  }

  async stats(agentId: string): Promise<KnowledgeStats> {
    if (this.mem0Client) {
      return this.mem0Client.computeStats(agentId);
    }
    return this.computeLocalStats(agentId);
  }

  async update(
    id: string,
    updates: Partial<KnowledgeItem>,
  ): Promise<KnowledgeItem> {
    if (this.mem0Client) {
      return this.mem0Client.updateItem(id, updates);
    }
    const existing = this.items.get(id);
    if (!existing) {
      throw new Error(`Knowledge item not found: ${id}`);
    }
    const updated: KnowledgeItem = {
      ...existing,
      ...updates,
      id: existing.id,
      updatedAt: new Date(),
    };
    this.items.set(id, updated);
    this.saveToDisk();
    return updated;
  }

  async remove(id: string): Promise<void> {
    if (this.mem0Client) {
      return this.mem0Client.removeItem(id);
    }
    if (!this.items.has(id)) {
      throw new Error(`Knowledge item not found: ${id}`);
    }
    this.items.delete(id);
    this.saveToDisk();
  }

  async render(agentId: string): Promise<string> {
    // Render BOTH agent-specific AND shared knowledge
    const agentItems = await this.list(agentId);
    const sharedItems =
      agentId !== SHARED_AGENT_ID ? await this.listShared() : [];

    const allItems = [...agentItems, ...sharedItems];
    if (allItems.length === 0) {
      return '';
    }

    allItems.sort((a, b) => b.effectiveness - a.effectiveness);

    const lines: string[] = ['# Agent Knowledge\n'];
    const grouped = new Map<string, KnowledgeItem[]>();

    for (const item of allItems) {
      const category = item.category || 'general';
      if (!grouped.has(category)) {
        grouped.set(category, []);
      }
      grouped.get(category)!.push(item);
    }

    for (const [category, categoryItems] of grouped) {
      lines.push(`## ${category}\n`);
      for (const item of categoryItems) {
        const effectiveness =
          item.effectiveness > 0
            ? `[+${item.effectiveness.toFixed(1)}]`
            : item.effectiveness < 0
              ? `[${item.effectiveness.toFixed(1)}]`
              : '[0.0]';
        const shared = item.agentId === SHARED_AGENT_ID ? ' (shared)' : '';
        lines.push(`- ${effectiveness} ${item.content}${shared}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  // ── Shared / cross-agent methods ──────────────────────────────────

  async listShared(): Promise<KnowledgeItem[]> {
    return this.list(SHARED_AGENT_ID);
  }

  async addShared(
    item: Omit<KnowledgeItem, 'id' | 'createdAt' | 'updatedAt' | 'agentId'>,
  ): Promise<KnowledgeItem> {
    return this.add({ ...item, agentId: SHARED_AGENT_ID });
  }

  async searchShared(
    options: KnowledgeSearchOptions,
  ): Promise<KnowledgeSearchResult> {
    return this.search(SHARED_AGENT_ID, options);
  }

  async sharedStats(): Promise<KnowledgeStats> {
    return this.stats(SHARED_AGENT_ID);
  }

  async searchAll(
    options: KnowledgeSearchOptions,
  ): Promise<KnowledgeSearchResult> {
    if (this.mem0Client) {
      return this.mem0Client.searchAll(options);
    }
    // Search across ALL agents
    const filtered: KnowledgeItem[] = [];
    for (const item of this.items.values()) {
      if (options.category && item.category !== options.category) continue;
      if (options.q) {
        const query = options.q.toLowerCase();
        if (
          !item.content.toLowerCase().includes(query) &&
          !item.category.toLowerCase().includes(query) &&
          !item.source.toLowerCase().includes(query)
        ) {
          continue;
        }
      }
      filtered.push(item);
    }

    filtered.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const total = filtered.length;
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 50;
    const items = filtered.slice(offset, offset + limit);
    return { items, total };
  }

  // ── Persistence (local adapter only) ──────────────────────────────

  private loadFromDisk(): void {
    const filePath = join(this.persistPath, 'items.json');
    if (existsSync(filePath)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf-8'));
        if (!Array.isArray(parsed)) {
          console.warn(
            '[KnowledgeStore] Expected array in items.json, got',
            typeof parsed,
            '— starting empty',
          );
          return;
        }
        const data = parsed as SerializedKnowledgeItem[];
        for (const raw of data) {
          const item: KnowledgeItem = {
            ...raw,
            createdAt: new Date(raw.createdAt),
            updatedAt: new Date(raw.updatedAt),
          };
          this.items.set(item.id, item);
        }
      } catch (err) {
        console.error(
          '[KnowledgeStore] Failed to load from disk (corrupt file?):',
          err,
        );
      }
    }
  }

  private saveToDisk(): void {
    const filePath = join(this.persistPath, 'items.json');
    const tmpPath = filePath + '.tmp';
    try {
      const serialized: SerializedKnowledgeItem[] = [
        ...this.items.values(),
      ].map((item) => ({
        ...item,
        createdAt: item.createdAt.toISOString(),
        updatedAt: item.updatedAt.toISOString(),
      }));
      writeFileSync(tmpPath, JSON.stringify(serialized, null, 2));
      renameSync(tmpPath, filePath);
    } catch (err) {
      console.error('[KnowledgeStore] Failed to save:', err);
    }
  }

  private computeLocalStats(agentId: string): KnowledgeStats {
    const agentItems: KnowledgeItem[] = [];
    for (const item of this.items.values()) {
      if (item.agentId === agentId) {
        agentItems.push(item);
      }
    }

    const categories: Record<string, number> = {};
    let oldestItem: Date | undefined;
    let newestItem: Date | undefined;
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    let recentItems = 0;

    for (const item of agentItems) {
      categories[item.category] = (categories[item.category] ?? 0) + 1;
      if (!oldestItem || item.createdAt < oldestItem)
        oldestItem = item.createdAt;
      if (!newestItem || item.createdAt > newestItem)
        newestItem = item.createdAt;
      if (item.createdAt.getTime() >= oneDayAgo) recentItems++;
    }

    return {
      totalItems: agentItems.length,
      categories,
      recentItems,
      oldestItem,
      newestItem,
    };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Mem0 Cloud Client — thin wrapper around the official MemoryClient
// ────────────────────────────────────────────────────────────────────────────

/**
 * Wraps the mem0ai MemoryClient and translates between CTXMill's
 * KnowledgeItem model and mem0's Memory model.
 */
class Mem0CloudClient {
  private client: import('mem0ai').MemoryClient;

  constructor(apiKey: string, host?: string) {
    // Dynamic import avoidance — we import at module level but guard with the
    // constructor-only path so tree-shaking still works for the local adapter.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { MemoryClient } = require('mem0ai') as typeof import('mem0ai');
    this.client = new MemoryClient({ apiKey, host: host ?? undefined });
  }

  async addItem(
    item: Omit<KnowledgeItem, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<KnowledgeItem> {
    const isShared = item.agentId === SHARED_AGENT_ID;
    const messages = [{ role: 'user' as const, content: item.content }];
    const options: Record<string, unknown> = {
      metadata: {
        category: item.category,
        source: item.source,
        effectiveness: item.effectiveness,
        ctxmill_agent_id: item.agentId,
      },
    };
    if (!isShared) {
      options.agent_id = item.agentId;
    }

    const result = await this.client.add(messages, options);
    const mem = result[0];
    if (!mem) {
      throw new Error('[Mem0CloudClient] add() returned empty result');
    }

    return this.toKnowledgeItem(mem, item.agentId);
  }

  async getItem(id: string): Promise<KnowledgeItem | null> {
    try {
      const mem = await this.client.get(id);
      if (!mem) return null;
      return this.toKnowledgeItem(mem);
    } catch {
      return null;
    }
  }

  async listItems(agentId: string): Promise<KnowledgeItem[]> {
    const isShared = agentId === SHARED_AGENT_ID;
    const options: Record<string, unknown> = {};
    if (!isShared) {
      options.agent_id = agentId;
    } else {
      // For shared, filter by metadata since shared items have no agent_id
      options.filters = { ctxmill_agent_id: SHARED_AGENT_ID };
    }

    const memories = await this.client.getAll(options);
    return memories.map((m) => this.toKnowledgeItem(m, agentId));
  }

  async searchItems(
    agentId: string,
    options: KnowledgeSearchOptions,
  ): Promise<KnowledgeSearchResult> {
    const query = options.q || '';
    if (!query) {
      const all = await this.listItems(agentId);
      let filtered = all;
      if (options.category) {
        filtered = all.filter((i) => i.category === options.category);
      }
      const total = filtered.length;
      const offset = options.offset ?? 0;
      const limit = options.limit ?? 50;
      return { items: filtered.slice(offset, offset + limit), total };
    }

    const isShared = agentId === SHARED_AGENT_ID;
    const searchOpts: Record<string, unknown> = {
      limit: options.limit ?? 50,
    };
    if (!isShared) {
      searchOpts.agent_id = agentId;
    }
    if (options.category) {
      searchOpts.categories = [options.category];
    }

    const memories = await this.client.search(query, searchOpts);
    const items = memories.map((m) => this.toKnowledgeItem(m, agentId));
    return { items, total: items.length };
  }

  async searchAll(
    options: KnowledgeSearchOptions,
  ): Promise<KnowledgeSearchResult> {
    const query = options.q || '';
    if (!query) {
      const all = await this.client.getAll({});
      let items = all.map((m) => this.toKnowledgeItem(m));
      if (options.category) {
        items = items.filter((i) => i.category === options.category);
      }
      const total = items.length;
      const offset = options.offset ?? 0;
      const limit = options.limit ?? 50;
      return { items: items.slice(offset, offset + limit), total };
    }

    const searchOpts: Record<string, unknown> = {
      limit: options.limit ?? 50,
    };
    if (options.category) {
      searchOpts.categories = [options.category];
    }

    const memories = await this.client.search(query, searchOpts);
    const items = memories.map((m) => this.toKnowledgeItem(m));
    return { items, total: items.length };
  }

  async updateItem(
    id: string,
    updates: Partial<KnowledgeItem>,
  ): Promise<KnowledgeItem> {
    const existing = await this.getItem(id);
    if (!existing) {
      throw new Error(`Knowledge item not found: ${id}`);
    }

    const newContent = updates.content ?? existing.content;
    const newMetadata: Record<string, unknown> = {
      category: updates.category ?? existing.category,
      source: updates.source ?? existing.source,
      effectiveness: updates.effectiveness ?? existing.effectiveness,
      ctxmill_agent_id: updates.agentId ?? existing.agentId,
    };

    await this.client.update(id, { text: newContent, metadata: newMetadata });
    return {
      ...existing,
      ...updates,
      id: existing.id,
      updatedAt: new Date(),
    };
  }

  async removeItem(id: string): Promise<void> {
    await this.client.delete(id);
  }

  async computeStats(agentId: string): Promise<KnowledgeStats> {
    const items = await this.listItems(agentId);
    const categories: Record<string, number> = {};
    let oldestItem: Date | undefined;
    let newestItem: Date | undefined;
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    let recentItems = 0;

    for (const item of items) {
      categories[item.category] = (categories[item.category] ?? 0) + 1;
      if (!oldestItem || item.createdAt < oldestItem)
        oldestItem = item.createdAt;
      if (!newestItem || item.createdAt > newestItem)
        newestItem = item.createdAt;
      if (item.createdAt.getTime() >= oneDayAgo) recentItems++;
    }

    return {
      totalItems: items.length,
      categories,
      recentItems,
      oldestItem,
      newestItem,
    };
  }

  // ── Mapping helpers ─────────────────────────────────────────────

  private toKnowledgeItem(
    mem: import('mem0ai').Memory,
    fallbackAgentId?: string,
  ): KnowledgeItem {
    const meta = (mem.metadata ?? {}) as Record<string, unknown>;
    return {
      id: mem.id,
      agentId:
        (meta.ctxmill_agent_id as string) ??
        mem.agent_id ??
        fallbackAgentId ??
        SHARED_AGENT_ID,
      content: mem.memory ?? mem.data?.memory ?? '',
      category: (meta.category as string) ?? 'general',
      source: (meta.source as string) ?? 'mem0',
      effectiveness: (meta.effectiveness as number) ?? 0,
      createdAt: mem.created_at ? new Date(mem.created_at) : new Date(),
      updatedAt: mem.updated_at ? new Date(mem.updated_at) : new Date(),
    };
  }
}
