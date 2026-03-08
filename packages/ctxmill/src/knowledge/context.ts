import { randomUUID } from 'node:crypto';
import type { ContextItem, ContextQuery, ContextResult, ContextProvider } from './types.js';

export class InMemoryContextProvider implements ContextProvider {
  readonly name = 'memory';
  private items = new Map<string, ContextItem>();

  async query(request: ContextQuery): Promise<ContextResult> {
    const limit = request.limit ?? 10;
    const minScore = request.minScore ?? 0;

    if (!request.text) {
      // No query text: return all items above minScore, up to limit
      const all = [...this.items.values()]
        .filter((item) => item.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
      return { items: all, totalCount: all.length };
    }

    // Simple keyword-based search
    const queryWords = normalizeWords(request.text);
    if (queryWords.length === 0) {
      return { items: [], totalCount: 0 };
    }

    const scored: ContextItem[] = [];

    for (const item of this.items.values()) {
      const contentWords = normalizeWords(item.content);
      if (contentWords.length === 0) continue;

      // Score = fraction of query words found in content
      let matchCount = 0;
      for (const qw of queryWords) {
        if (contentWords.some((cw) => cw.includes(qw) || qw.includes(cw))) {
          matchCount++;
        }
      }
      const matchScore = matchCount / queryWords.length;

      if (matchScore >= minScore) {
        scored.push({ ...item, score: matchScore });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    const limited = scored.slice(0, limit);

    return { items: limited, totalCount: scored.length };
  }

  async get(id: string): Promise<ContextItem | null> {
    return this.items.get(id) ?? null;
  }

  async put(item: Omit<ContextItem, 'id'>): Promise<ContextItem> {
    const contextItem: ContextItem = {
      ...item,
      id: randomUUID(),
    };
    this.items.set(contextItem.id, contextItem);
    return contextItem;
  }

  async delete(id: string): Promise<void> {
    this.items.delete(id);
  }

  async healthy(): Promise<boolean> {
    return true;
  }
}

function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0);
}
