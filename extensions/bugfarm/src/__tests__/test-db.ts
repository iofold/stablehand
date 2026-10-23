import { randomBytes } from 'node:crypto';
import { BoardStore } from '../store/store.js';

/**
 * Board-store tests run against TEST_DATABASE_URL, like every DB suite in
 * this repository, and refuse to run without it. Each suite works in a fresh
 * schema of its own and drops only that schema, so nothing else in the
 * database is touched.
 */
export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error('TEST_DATABASE_URL is not set. The Bugfarm store tests need a Postgres test database, e.g. postgres://stablehand:stablehand@localhost:5433/stablehand_test');
  }
  const database = new URL(url).pathname.replace(/^\//, '');
  if ((database === 'stablehand' || database === 'ctxmill') && process.env.STABLEHAND_TEST_ALLOW_RUNTIME_DB !== '1') {
    throw new Error('TEST_DATABASE_URL points at a runtime database; use a separate test database.');
  }
  return url;
}

export async function freshStore(): Promise<BoardStore> {
  const store = new BoardStore({
    url: testDatabaseUrl(),
    schema: `bugfarm_test_${randomBytes(4).toString('hex')}`,
    maxConnections: 4,
  });
  await store.migrate();
  return store;
}

export async function disposeStore(store: BoardStore): Promise<void> {
  await store.dropSchema();
  await store.close();
}
