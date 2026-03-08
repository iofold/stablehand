/**
 * ContextProvider compliance test suite.
 *
 * Any implementation of the ContextProvider interface can be validated by
 * calling `contextProviderCompliance(name, factory)`.  The factory receives
 * a fresh instance for every test so implementations don't need to handle
 * cleanup between runs.
 *
 * The suite covers:
 *  - name property
 *  - healthy() liveness check
 *  - put() + get() round-trip
 *  - get() returns null for unknown ids
 *  - delete() removes items
 *  - query() with keyword text matching
 *  - query() returns all items when no text is given
 *  - query() respects limit
 *  - query() respects minScore
 *  - query() returns empty when nothing matches
 *  - query() handles blank text gracefully
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { ContextProvider } from '../../packages/ctxmill/src/knowledge/types.js';

export function contextProviderCompliance(
  label: string,
  factory: () => ContextProvider,
): void {
  describe(`ContextProvider compliance: ${label}`, () => {
    let provider: ContextProvider;

    beforeEach(() => {
      provider = factory();
    });

    // ── name ───────────────────────────────────────────────────────────

    it('has a non-empty name property', () => {
      expect(typeof provider.name).toBe('string');
      expect(provider.name.length).toBeGreaterThan(0);
    });

    // ── healthy() ─────────────────────────────────────────────────────

    it('healthy() returns true for a fresh instance', async () => {
      expect(await provider.healthy()).toBe(true);
    });

    // ── put() + get() ─────────────────────────────────────────────────

    it('put() stores an item that can be retrieved with get()', async () => {
      if (!provider.put) return; // optional method

      const stored = await provider.put({
        content: 'compliance test content',
        metadata: { origin: 'compliance' },
        score: 0.75,
      });

      expect(stored.id).toBeDefined();
      expect(typeof stored.id).toBe('string');
      expect(stored.content).toBe('compliance test content');
      expect(stored.metadata.origin).toBe('compliance');
      expect(stored.score).toBe(0.75);

      const retrieved = await provider.get(stored.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(stored.id);
      expect(retrieved!.content).toBe('compliance test content');
    });

    it('put() assigns unique ids to distinct items', async () => {
      if (!provider.put) return;

      const a = await provider.put({ content: 'item a', metadata: {}, score: 0.5 });
      const b = await provider.put({ content: 'item b', metadata: {}, score: 0.5 });

      expect(a.id).not.toBe(b.id);
    });

    // ── get() miss ────────────────────────────────────────────────────

    it('get() returns null for a non-existent id', async () => {
      const result = await provider.get('non-existent-id-000');
      expect(result).toBeNull();
    });

    // ── delete() ──────────────────────────────────────────────────────

    it('delete() removes a previously stored item', async () => {
      if (!provider.put || !provider.delete) return;

      const item = await provider.put({
        content: 'to be deleted',
        metadata: {},
        score: 0.5,
      });

      await provider.delete(item.id);

      const retrieved = await provider.get(item.id);
      expect(retrieved).toBeNull();
    });

    it('delete() on a non-existent id does not throw', async () => {
      if (!provider.delete) return;

      await expect(provider.delete('does-not-exist')).resolves.toBeUndefined();
    });

    // ── query() keyword matching ──────────────────────────────────────

    it('query() returns items matching the text query', async () => {
      if (!provider.put) return;

      await provider.put({ content: 'Marketing campaign performance', metadata: {}, score: 0.8 });
      await provider.put({ content: 'Supply chain logistics', metadata: {}, score: 0.7 });
      await provider.put({ content: 'Marketing funnel conversion', metadata: {}, score: 0.9 });

      const result = await provider.query({ text: 'marketing conversion' });
      expect(result.items.length).toBeGreaterThan(0);
      expect(result.items[0].content.toLowerCase()).toContain('marketing');
    });

    // ── query() no text ───────────────────────────────────────────────

    it('query() returns all items sorted by score when no text given', async () => {
      if (!provider.put) return;

      await provider.put({ content: 'A', metadata: {}, score: 0.3 });
      await provider.put({ content: 'B', metadata: {}, score: 0.9 });
      await provider.put({ content: 'C', metadata: {}, score: 0.6 });

      const result = await provider.query({});
      expect(result.items.length).toBe(3);
      // descending score order
      for (let i = 1; i < result.items.length; i++) {
        expect(result.items[i - 1].score).toBeGreaterThanOrEqual(result.items[i].score);
      }
    });

    // ── query() limit ─────────────────────────────────────────────────

    it('query() respects the limit parameter', async () => {
      if (!provider.put) return;

      for (let i = 0; i < 5; i++) {
        await provider.put({ content: `Item ${i}`, metadata: {}, score: 0.5 + i * 0.05 });
      }

      const result = await provider.query({ limit: 2 });
      expect(result.items.length).toBe(2);
    });

    // ── query() minScore ──────────────────────────────────────────────

    it('query() respects the minScore parameter', async () => {
      if (!provider.put) return;

      await provider.put({ content: 'Low score', metadata: {}, score: 0.1 });
      await provider.put({ content: 'High score', metadata: {}, score: 0.9 });

      const result = await provider.query({ minScore: 0.5 });
      expect(result.items.length).toBe(1);
      expect(result.items[0].content).toBe('High score');
    });

    // ── query() no matches ────────────────────────────────────────────

    it('query() returns empty result when nothing matches', async () => {
      if (!provider.put) return;

      await provider.put({ content: 'Finance portfolio analysis', metadata: {}, score: 0.8 });

      const result = await provider.query({ text: 'xyzzyplughnotarealword', minScore: 0.5 });
      expect(result.items.length).toBe(0);
      expect(result.totalCount).toBe(0);
    });

    // ── query() blank text ────────────────────────────────────────────

    it('query() handles blank text gracefully', async () => {
      if (!provider.put) return;

      await provider.put({ content: 'Some content', metadata: {}, score: 0.5 });

      const result = await provider.query({ text: '   ' });
      expect(result.items.length).toBe(0);
    });
  });
}
