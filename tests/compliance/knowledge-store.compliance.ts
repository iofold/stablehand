import { describe, it, expect, beforeEach } from 'vitest';
import type { KnowledgeStore } from '../../packages/ctxmill/src/knowledge/types.js';

/**
 * Reusable compliance suite for KnowledgeStore implementations.
 * Call with a factory that creates a fresh instance for each test.
 */
export function knowledgeStoreCompliance(
  name: string,
  factory: () => KnowledgeStore | Promise<KnowledgeStore>,
) {
  describe(`KnowledgeStore compliance: ${name}`, () => {
    let store: KnowledgeStore;

    beforeEach(async () => {
      store = await factory();
    });

    it('add() returns item with generated id and timestamps', async () => {
      const item = await store.add({
        agentId: 'agent-1',
        content: 'test insight',
        category: 'strategy',
        source: 'reflector',
        effectiveness: 0.5,
      });
      expect(item.id).toBeTruthy();
      expect(item.agentId).toBe('agent-1');
      expect(item.content).toBe('test insight');
      expect(item.category).toBe('strategy');
      expect(item.createdAt).toBeInstanceOf(Date);
      expect(item.updatedAt).toBeInstanceOf(Date);
    });

    it('get() retrieves by id', async () => {
      const added = await store.add({
        agentId: 'agent-1',
        content: 'find me',
        category: 'fact',
        source: 'human',
        effectiveness: 0,
      });
      const found = await store.get(added.id);
      expect(found).not.toBeNull();
      expect(found!.content).toBe('find me');
    });

    it('get() returns null for missing id', async () => {
      const found = await store.get('nonexistent');
      expect(found).toBeNull();
    });

    it('list() filters by agentId', async () => {
      await store.add({ agentId: 'a', content: '1', category: 'fact', source: 'human', effectiveness: 0 });
      await store.add({ agentId: 'b', content: '2', category: 'fact', source: 'human', effectiveness: 0 });
      await store.add({ agentId: 'a', content: '3', category: 'fact', source: 'human', effectiveness: 0 });

      const items = await store.list('a');
      expect(items).toHaveLength(2);
      expect(items.every(i => i.agentId === 'a')).toBe(true);
    });

    it('search() supports text query', async () => {
      await store.add({ agentId: 'a', content: 'optimize SQL queries', category: 'strategy', source: 'reflector', effectiveness: 0.8 });
      await store.add({ agentId: 'a', content: 'use markdown for output', category: 'preference', source: 'human', effectiveness: 0.5 });

      const result = await store.search('a', { q: 'SQL' });
      expect(result.items.length).toBeGreaterThanOrEqual(1);
      expect(result.items[0].content).toContain('SQL');
    });

    it('search() supports category filter', async () => {
      await store.add({ agentId: 'a', content: 'insight A', category: 'strategy', source: 'reflector', effectiveness: 0 });
      await store.add({ agentId: 'a', content: 'insight B', category: 'fact', source: 'reflector', effectiveness: 0 });

      const result = await store.search('a', { category: 'strategy' });
      expect(result.items.every(i => i.category === 'strategy')).toBe(true);
    });

    it('search() supports pagination', async () => {
      for (let i = 0; i < 5; i++) {
        await store.add({ agentId: 'a', content: `item ${i}`, category: 'fact', source: 'human', effectiveness: 0 });
      }
      const page1 = await store.search('a', { limit: 2, offset: 0 });
      const page2 = await store.search('a', { limit: 2, offset: 2 });
      expect(page1.items).toHaveLength(2);
      expect(page2.items).toHaveLength(2);
      expect(page1.total).toBe(5);
    });

    it('stats() returns correct counts', async () => {
      await store.add({ agentId: 'a', content: '1', category: 'strategy', source: 'reflector', effectiveness: 0 });
      await store.add({ agentId: 'a', content: '2', category: 'fact', source: 'human', effectiveness: 0 });
      await store.add({ agentId: 'a', content: '3', category: 'strategy', source: 'reflector', effectiveness: 0 });

      const stats = await store.stats('a');
      expect(stats.totalItems).toBe(3);
      expect(stats.categories['strategy']).toBe(2);
      expect(stats.categories['fact']).toBe(1);
    });

    it('update() modifies item and updates timestamp', async () => {
      const item = await store.add({
        agentId: 'a',
        content: 'original',
        category: 'fact',
        source: 'human',
        effectiveness: 0,
      });
      const updated = await store.update(item.id, { content: 'modified', effectiveness: 0.9 });
      expect(updated.content).toBe('modified');
      expect(updated.effectiveness).toBe(0.9);
      expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(item.updatedAt.getTime());
    });

    it('remove() deletes item', async () => {
      const item = await store.add({
        agentId: 'a',
        content: 'delete me',
        category: 'fact',
        source: 'human',
        effectiveness: 0,
      });
      await store.remove(item.id);
      const found = await store.get(item.id);
      expect(found).toBeNull();
    });

    it('render() returns formatted markdown for agent knowledge', async () => {
      await store.add({ agentId: 'a', content: 'use caching', category: 'strategy', source: 'reflector', effectiveness: 0.8 });
      await store.add({ agentId: 'a', content: 'prefer JSON', category: 'preference', source: 'human', effectiveness: 0.5 });

      const rendered = await store.render('a');
      expect(rendered).toContain('# Agent Knowledge');
      expect(rendered).toContain('use caching');
      expect(rendered).toContain('prefer JSON');
    });

    it('render() returns empty string for agent with no knowledge', async () => {
      const rendered = await store.render('nonexistent-agent');
      expect(rendered).toBe('');
    });
  });
}
