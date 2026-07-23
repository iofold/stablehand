/**
 * Shared Postgres test database helper.
 *
 * Each call to createTestDb() creates a fresh schema (drops + recreates all tables)
 * to ensure test isolation. Because that is destructive, the target database must
 * be named explicitly via TEST_DATABASE_URL — there is no default — and the dev1
 * runtime database is refused unless CTXMILL_TEST_ALLOW_RUNTIME_DB=1 (ctx-j9yl).
 *
 * Recommended local target (separate database on the compose Postgres):
 *   TEST_DATABASE_URL=postgres://ctxmill:ctxmill@localhost:5433/ctxmill_test
 * Create it once with:
 *   docker compose exec postgres createdb -U ctxmill ctxmill_test
 */

import { createDatabase, type DatabaseConnection } from '../../packages/ctxmill/src/database/connection.js';
import { MIGRATION_ADVISORY_LOCK_ID, SCHEMA_VERSION_TABLE, runMigrations } from '../../packages/ctxmill/src/database/migrations.js';
import { DatabaseRepository } from '../../packages/ctxmill/src/database/repository.js';

/** The dev1 runtime database endpoints (docker-compose host mapping + in-network). */
function isRuntimeDb(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.pathname.replace(/^\//, '') !== 'ctxmill') return false;
    const port = url.port || '5432';
    return (
      ((url.hostname === 'localhost' || url.hostname === '127.0.0.1') && port === '5433') ||
      (url.hostname === 'postgres' && port === '5432')
    );
  } catch {
    return false;
  }
}

/**
 * Resolve the database URL backend DB tests may use. Fails closed:
 * - no TEST_DATABASE_URL → throw (tests drop every table; no implicit target)
 * - TEST_DATABASE_URL is the dev1 runtime DB → throw unless CTXMILL_TEST_ALLOW_RUNTIME_DB=1
 */
export function resolveTestDatabaseUrl(env: Record<string, string | undefined> = process.env): string {
  const url = env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Backend DB tests drop and recreate every table, '
      + 'so they refuse to run without an explicit target. Point TEST_DATABASE_URL at a '
      + 'dedicated test database, e.g. postgres://ctxmill:ctxmill@localhost:5433/ctxmill_test '
      + '(create it once: docker compose exec postgres createdb -U ctxmill ctxmill_test).',
    );
  }
  if (isRuntimeDb(url) && env.CTXMILL_TEST_ALLOW_RUNTIME_DB !== '1') {
    throw new Error(
      'TEST_DATABASE_URL points at the dev1 runtime database — tests would DROP every table in it. '
      + 'Use a separate database (e.g. .../ctxmill_test), or set CTXMILL_TEST_ALLOW_RUNTIME_DB=1 '
      + 'if you really mean to wipe the runtime stack.',
    );
  }
  return url;
}

/** Tables to drop for test isolation (order matters for FK constraints) */
const ALL_TABLES = [
  SCHEMA_VERSION_TABLE,
  'secrets',
  'tool_request_dedup',
  'budget_policies',
  'artifacts',
  'agent_checkpoints',
  'interrupt_resume_attempts',
  'pending_interrupts',
  'turn_start_requests',
  'turn_delivery_leases',
  'sandbox_session_lifecycle_operations',
  'turn_secret_envelopes',
  'model_call_attempt_usage',
  'model_call_usage',
  'model_gateway_spend_quarantine',
  'model_gateway_reconciliation_state',
  'turns',
  'sandbox_sessions',
  'agent_versions',
  'trigger_firings',
  'event_triggers',
  'suspended_sessions',
  'event_store',
  'agent_event_heads',
  'spine_cursors',
  // Legacy tables removed from the runtime schema; keep them in test cleanup so
  // old local databases do not block fresh migrations.
  'scheduled_events',
  'feedback_signals',
  'execution_traces',
  'messages',
  'conversations',
  'knowledge_items',
  'webhooks',
  'callback_outbox',
  'system_settings',
  'agent_workspace_state',
  'agents',
];

export interface TestDb {
  conn: DatabaseConnection;
  repo: DatabaseRepository;
  close: () => Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  let conn: DatabaseConnection | undefined;

  try {
    conn = await createDatabase(resolveTestDatabaseUrl());
    await conn.pgClient`SELECT pg_advisory_lock(${MIGRATION_ADVISORY_LOCK_ID})`;

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
          await activeConn.pgClient`SELECT pg_advisory_unlock(${MIGRATION_ADVISORY_LOCK_ID})`;
        } finally {
          await activeConn.close();
        }
      },
    };
  } catch (error) {
    if (conn) {
      try {
        await conn.pgClient`SELECT pg_advisory_unlock(${MIGRATION_ADVISORY_LOCK_ID})`;
      } catch {
        // Ignore unlock failures during setup cleanup.
      } finally {
        await conn.close();
      }
    }
    throw error;
  }
}
