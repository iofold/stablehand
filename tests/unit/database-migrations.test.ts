import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type DatabaseConnection } from '../../packages/ctxmill/src/database/connection.js';
import { MIGRATION_ADVISORY_LOCK_ID, runMigrations } from '../../packages/ctxmill/src/database/migrations.js';
import { TEST_DATABASE_URL } from '../utils/test-db.js';

async function dropAllPublicTables(conn: DatabaseConnection): Promise<void> {
  const tables = await conn.pgClient`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
  `;

  for (const table of tables) {
    await conn.pgClient`DROP TABLE IF EXISTS ${conn.pgClient(table.tablename as string)} CASCADE`;
  }
}

describe('database migration baseline guard', () => {
  let conn: DatabaseConnection;

  beforeAll(async () => {
    conn = await createDatabase(TEST_DATABASE_URL);
    await conn.pgClient`SELECT pg_advisory_lock(${MIGRATION_ADVISORY_LOCK_ID})`;
  });

  afterAll(async () => {
    if (!conn) return;
    try {
      await dropAllPublicTables(conn);
      await runMigrations(conn.pgClient);
      await conn.pgClient`SELECT pg_advisory_unlock(${MIGRATION_ADVISORY_LOCK_ID})`;
    } finally {
      await conn.close();
    }
  });

  it('fails clearly for existing non-empty databases without a ctxmill baseline marker', async () => {
    await dropAllPublicTables(conn);
    await conn.pgClient`CREATE TABLE legacy_unversioned_table (id TEXT PRIMARY KEY)`;

    await expect(runMigrations(conn.pgClient)).rejects.toThrow(
      /existing unversioned public tables \(legacy_unversioned_table\)/,
    );
  });
});
