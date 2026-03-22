import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { KnowledgeItem, KnowledgeStore, KnowledgeSearchOptions, KnowledgeSearchResult, KnowledgeStats } from './types.js';

export class InMemoryKnowledgeStore implements KnowledgeStore {
  private items = new Map<string, KnowledgeItem>();
  private persistPath: string;

  constructor(dataDir: string) {
    this.persistPath = join(dataDir, 'knowledge');
    mkdirSync(this.persistPath, { recursive: true });
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    const filePath = join(this.persistPath, 'items.json');
    if (existsSync(filePath)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf-8'));
        if (!Array.isArray(parsed)) {
          console.warn('[KnowledgeStore] Expected array in items.json, got', typeof parsed, '— starting empty');
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
        console.error('[KnowledgeStore] Failed to load from disk (corrupt file?):', err);
        // Start with empty Map instead of crashing
      }
    }
  }

  private saveToDisk(): void {
    const filePath = join(this.persistPath, 'items.json');
    const tmpPath = filePath + '.tmp';
    try {
      const serialized: SerializedKnowledgeItem[] = [...this.items.values()].map((item) => ({
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

  async add(
    item: Omit<KnowledgeItem, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<KnowledgeItem> {
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
    return this.items.get(id) ?? null;
  }

  async list(agentId: string): Promise<KnowledgeItem[]> {
    const result: KnowledgeItem[] = [];
    for (const item of this.items.values()) {
      if (item.agentId === agentId) {
        result.push(item);
      }
    }
    return result;
  }

  async search(agentId: string, options: KnowledgeSearchOptions): Promise<KnowledgeSearchResult> {
    const filtered: KnowledgeItem[] = [];
    for (const item of this.items.values()) {
      if (item.agentId !== agentId) continue;
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

    // Sort by createdAt descending (newest first)
    filtered.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const total = filtered.length;
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 50;
    const items = filtered.slice(offset, offset + limit);

    return { items, total };
  }

  async stats(agentId: string): Promise<KnowledgeStats> {
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
      if (!oldestItem || item.createdAt < oldestItem) oldestItem = item.createdAt;
      if (!newestItem || item.createdAt > newestItem) newestItem = item.createdAt;
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

  async update(id: string, updates: Partial<KnowledgeItem>): Promise<KnowledgeItem> {
    const existing = this.items.get(id);
    if (!existing) {
      throw new Error(`Knowledge item not found: ${id}`);
    }
    const updated: KnowledgeItem = {
      ...existing,
      ...updates,
      id: existing.id, // prevent id overwrite
      updatedAt: new Date(),
    };
    this.items.set(id, updated);
    this.saveToDisk();
    return updated;
  }

  async remove(id: string): Promise<void> {
    if (!this.items.has(id)) {
      throw new Error(`Knowledge item not found: ${id}`);
    }
    this.items.delete(id);
    this.saveToDisk();
  }

  async render(agentId: string): Promise<string> {
    const items = await this.list(agentId);
    if (items.length === 0) {
      return '';
    }

    // Sort by effectiveness descending
    items.sort((a, b) => b.effectiveness - a.effectiveness);

    const lines: string[] = ['# Agent Knowledge\n'];
    const grouped = new Map<string, KnowledgeItem[]>();

    for (const item of items) {
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
        lines.push(`- ${effectiveness} ${item.content}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  // ── Shared knowledge ──

  async listShared(): Promise<KnowledgeItem[]> {
    const result: KnowledgeItem[] = [];
    for (const item of this.items.values()) {
      if (item.agentId === '__shared__') {
        result.push(item);
      }
    }
    return result;
  }

  async addShared(
    item: Omit<KnowledgeItem, 'id' | 'createdAt' | 'updatedAt' | 'agentId'>,
  ): Promise<KnowledgeItem> {
    return this.add({ ...item, agentId: '__shared__' });
  }

  async searchShared(options: KnowledgeSearchOptions): Promise<KnowledgeSearchResult> {
    return this.search('__shared__', options);
  }

  async sharedStats(): Promise<KnowledgeStats> {
    return this.stats('__shared__');
  }

  async searchAll(options: KnowledgeSearchOptions): Promise<KnowledgeSearchResult> {
    return this.search('', options);
  }
}

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
