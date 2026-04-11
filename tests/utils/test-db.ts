/**
 * Shared Postgres test database helper.
 *
 * Uses the docker-compose Postgres at localhost:5433.
 * Each call to createTestDb() creates a fresh schema (drops + recreates all tables)
 * to ensure test isolation.
 */

import { createDatabase, type DatabaseConnection } from '../../packages/ctxmill/src/database/connection.js';
import { runMigrations } from '../../packages/ctxmill/src/database/migrations.js';
import { DatabaseRepository } from '../../packages/ctxmill/src/database/repository.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://ctxmill:ctxmill@localhost:5433/ctxmill';
const TEST_DB_ADVISORY_LOCK_ID = 424242;

/** Tables to drop for test isolation (order matters for FK constraints) */
const ALL_TABLES = [
  'secrets',
  'agent_checkpoints',
  'sandbox_sessions',
  'turns',
  'agent_versions',
  'event_triggers',
  'scheduled_events',
  'suspended_sessions',
  'event_store',
  'feedback_signals',
  'execution_traces',
  'messages',
  'conversations',
  'knowledge_items',
  'webhooks',
  'callback_outbox',
  'agents',
];

export interface TestDb {
  conn: DatabaseConnection;
  repo: DatabaseRepository;
  close: () => Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const lockConn = await createDatabase(TEST_DATABASE_URL);
  await lockConn.pgClient`SELECT pg_advisory_lock(${TEST_DB_ADVISORY_LOCK_ID})`;

  let conn: DatabaseConnection | undefined;

  const releaseLock = async () => {
    await lockConn.pgClient`SELECT pg_advisory_unlock(${TEST_DB_ADVISORY_LOCK_ID})`;
    await lockConn.close();
  };

  try {
    conn = await createDatabase(TEST_DATABASE_URL);

    // Drop all tables for isolation, then re-run migrations
    for (const table of ALL_TABLES) {
      await conn.pgClient`DROP TABLE IF EXISTS ${conn.pgClient(table)} CASCADE`;
    }
    await runMigrations(conn.pgClient);

    const activeConn = conn;
    const repo = new DatabaseRepository(conn.db);
    return {
      conn: activeConn,
      repo,
      close: async () => {
        try {
          await activeConn.close();
        } finally {
          await releaseLock();
        }
      },
    };
  } catch (error) {
    try {
      if (conn) {
        await conn.close();
      }
    } finally {
      await releaseLock();
    }
    throw error;
  }
}

export { TEST_DATABASE_URL };
