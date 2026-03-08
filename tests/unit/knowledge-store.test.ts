import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InMemoryKnowledgeStore } from '../../packages/ctxmill/src/knowledge/store.js';

describe('InMemoryKnowledgeStore', () => {
  let store: InMemoryKnowledgeStore;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ctxmill-test-'));
    store = new InMemoryKnowledgeStore(tempDir);
  });

  it('should add and retrieve a knowledge item', async () => {
    const item = await store.add({
      agentId: 'test-agent',
      content: 'Test knowledge fact',
      category: 'fact',
      source: 'human',
      effectiveness: 0.5,
    });

    expect(item.id).toBeDefined();
    expect(item.content).toBe('Test knowledge fact');
    expect(item.agentId).toBe('test-agent');
    expect(item.createdAt).toBeInstanceOf(Date);
    expect(item.updatedAt).toBeInstanceOf(Date);

    const retrieved = await store.get(item.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(item.id);
    expect(retrieved!.content).toBe('Test knowledge fact');
  });

  it('should return null for non-existent item', async () => {
    const result = await store.get('non-existent-id');
    expect(result).toBeNull();
  });

  it('should list items for a specific agent', async () => {
    await store.add({ agentId: 'agent-a', content: 'Fact 1', category: 'fact', source: 'human', effectiveness: 0.5 });
    await store.add({ agentId: 'agent-a', content: 'Fact 2', category: 'strategy', source: 'reflector', effectiveness: 0.8 });
    await store.add({ agentId: 'agent-b', content: 'Other fact', category: 'fact', source: 'human', effectiveness: 0.3 });

    const agentAItems = await store.list('agent-a');
    expect(agentAItems).toHaveLength(2);

    const agentBItems = await store.list('agent-b');
    expect(agentBItems).toHaveLength(1);

    const agentCItems = await store.list('agent-c');
    expect(agentCItems).toHaveLength(0);
  });

  it('should render knowledge as grouped markdown', async () => {
    await store.add({ agentId: 'agent-a', content: 'High priority item', category: 'strategy', source: 'reflector', effectiveness: 0.9 });
    await store.add({ agentId: 'agent-a', content: 'Medium item', category: 'strategy', source: 'human', effectiveness: 0.4 });
    await store.add({ agentId: 'agent-a', content: 'A fact', category: 'fact', source: 'seed', effectiveness: 0.2 });

    const rendered = await store.render('agent-a');
    expect(rendered).toContain('# Agent Knowledge');
    expect(rendered).toContain('## strategy');
    expect(rendered).toContain('## fact');
    expect(rendered).toContain('High priority item');
    expect(rendered).toContain('[+0.9]');
    // Higher effectiveness items should appear first within category
    const strategyIdx = rendered.indexOf('High priority item');
    const mediumIdx = rendered.indexOf('Medium item');
    expect(strategyIdx).toBeLessThan(mediumIdx);
  });

  it('should render empty string for agent with no knowledge', async () => {
    const rendered = await store.render('empty-agent');
    expect(rendered).toBe('');
  });

  it('should update a knowledge item', async () => {
    const item = await store.add({ agentId: 'agent-a', content: 'Original content', category: 'fact', source: 'human', effectiveness: 0.5 });

    const updated = await store.update(item.id, { content: 'Updated content', effectiveness: 0.8 });
    expect(updated.content).toBe('Updated content');
    expect(updated.effectiveness).toBe(0.8);
    expect(updated.id).toBe(item.id); // id should not change
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(item.updatedAt.getTime());
  });

  it('should throw when updating non-existent item', async () => {
    await expect(store.update('non-existent', { content: 'x' })).rejects.toThrow('Knowledge item not found');
  });

  it('should remove a knowledge item', async () => {
    const item = await store.add({ agentId: 'agent-a', content: 'To be removed', category: 'fact', source: 'human', effectiveness: 0 });

    await store.remove(item.id);
    const retrieved = await store.get(item.id);
    expect(retrieved).toBeNull();

    const list = await store.list('agent-a');
    expect(list).toHaveLength(0);
  });

  it('should throw when removing non-existent item', async () => {
    await expect(store.remove('non-existent')).rejects.toThrow('Knowledge item not found');
  });

  it('should persist items across store instances', async () => {
    await store.add({ agentId: 'agent-a', content: 'Persisted fact', category: 'fact', source: 'human', effectiveness: 0.6 });

    // Create a new store pointing to same directory
    const store2 = new InMemoryKnowledgeStore(tempDir);
    const items = await store2.list('agent-a');
    expect(items).toHaveLength(1);
    expect(items[0].content).toBe('Persisted fact');

    // Cleanup
    rmSync(tempDir, { recursive: true, force: true });
  });
});
