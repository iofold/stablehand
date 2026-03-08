import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import { knowledgeStoreCompliance } from './knowledge-store.compliance.js';
import { InMemoryKnowledgeStore } from '../../packages/ctxmill/src/knowledge/store.js';

const tempDirs: string[] = [];

knowledgeStoreCompliance('InMemoryKnowledgeStore', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ks-compliance-'));
  tempDirs.push(dir);
  return new InMemoryKnowledgeStore(dir);
});

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});
