import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryContextProvider } from '../../packages/ctxmill/src/knowledge/context.js';

describe('InMemoryContextProvider', () => {
  let provider: InMemoryContextProvider;

  beforeEach(() => {
    provider = new InMemoryContextProvider();
  });

  it('should have name "memory"', () => {
    expect(provider.name).toBe('memory');
  });

  it('should report healthy', async () => {
    expect(await provider.healthy()).toBe(true);
  });

  it('should put and get an item', async () => {
    const item = await provider.put({
      content: 'Test content',
      metadata: { source: 'test' },
      score: 0.8,
    });

    expect(item.id).toBeDefined();
    expect(item.content).toBe('Test content');

    const retrieved = await provider.get(item.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.content).toBe('Test content');
    expect(retrieved!.metadata.source).toBe('test');
  });

  it('should return null for non-existent item', async () => {
    const result = await provider.get('non-existent-id');
    expect(result).toBeNull();
  });

  it('should delete an item', async () => {
    const item = await provider.put({
      content: 'To be deleted',
      metadata: {},
      score: 0.5,
    });

    await provider.delete(item.id);
    const retrieved = await provider.get(item.id);
    expect(retrieved).toBeNull();
  });

  it('should query with keyword matching', async () => {
    await provider.put({ content: 'Marketing campaign performance', metadata: {}, score: 0.8 });
    await provider.put({ content: 'Supply chain logistics optimization', metadata: {}, score: 0.7 });
    await provider.put({ content: 'Marketing funnel conversion rate', metadata: {}, score: 0.9 });

    const result = await provider.query({ text: 'marketing conversion' });
    expect(result.items.length).toBeGreaterThan(0);
    // Items with "marketing" should score higher
    expect(result.items[0].content.toLowerCase()).toContain('marketing');
  });

  it('should return all items when no query text', async () => {
    await provider.put({ content: 'Item A', metadata: {}, score: 0.5 });
    await provider.put({ content: 'Item B', metadata: {}, score: 0.9 });
    await provider.put({ content: 'Item C', metadata: {}, score: 0.3 });

    const result = await provider.query({});
    expect(result.items.length).toBe(3);
    // Should be sorted by score descending
    expect(result.items[0].score).toBeGreaterThanOrEqual(result.items[1].score);
    expect(result.items[1].score).toBeGreaterThanOrEqual(result.items[2].score);
  });

  it('should respect limit parameter', async () => {
    for (let i = 0; i < 5; i++) {
      await provider.put({ content: `Item ${i}`, metadata: {}, score: 0.5 + i * 0.1 });
    }

    const result = await provider.query({ limit: 2 });
    expect(result.items.length).toBe(2);
  });

  it('should respect minScore parameter', async () => {
    await provider.put({ content: 'Low score', metadata: {}, score: 0.1 });
    await provider.put({ content: 'High score', metadata: {}, score: 0.9 });

    const result = await provider.query({ minScore: 0.5 });
    expect(result.items.length).toBe(1);
    expect(result.items[0].content).toBe('High score');
  });

  it('should return empty for no matches', async () => {
    await provider.put({ content: 'Finance portfolio analysis', metadata: {}, score: 0.8 });

    // Use a long nonsense word so it won't accidentally substring-match short content words
    const result = await provider.query({ text: 'xyzzyplughnotarealword', minScore: 0.5 });
    expect(result.items.length).toBe(0);
    expect(result.totalCount).toBe(0);
  });

  it('should handle empty query text gracefully', async () => {
    await provider.put({ content: 'Some content', metadata: {}, score: 0.5 });

    const result = await provider.query({ text: '   ' });
    expect(result.items.length).toBe(0);
  });
});
