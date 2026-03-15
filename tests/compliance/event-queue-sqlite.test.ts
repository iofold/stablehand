/**
 * SQLiteEventQueue compliance test
 *
 * Runs the EventQueue compliance suite against the SQLiteEventQueue
 * implementation, using an in-memory SQLite database.
 */

import { describe, beforeEach, afterEach } from 'vitest';
import { createSqliteDatabase } from '../../packages/ctxmill/src/database/connection.js';
import { runMigrations } from '../../packages/ctxmill/src/database/migrations.js';
import { DatabaseRepository } from '../../packages/ctxmill/src/database/repository.js';
import { TypedEventBus } from '../../packages/ctxmill/src/events/bus.js';
import { SQLiteEventQueue } from '../../packages/ctxmill/src/events/event-queue.js';
import { eventQueueComplianceSuite } from './event-queue.compliance.js';

let sqliteClose: () => void;

describe('SQLiteEventQueue compliance', () => {
  beforeEach(() => {
    // Each test gets a fresh queue via createQueue; this is just setup/teardown for the DB
  });

  afterEach(() => {
    if (sqliteClose) {
      sqliteClose();
    }
  });

  eventQueueComplianceSuite({
    createQueue: () => {
      const { db, sqlite } = createSqliteDatabase(':memory:');
      runMigrations(sqlite);
      sqliteClose = () => sqlite.close();

      const repo = new DatabaseRepository(db);
      const bus = new TypedEventBus();
      return new SQLiteEventQueue(bus, repo);
    },
    cleanup: async () => {
      // DB cleanup handled by afterEach closing sqlite
    },
  });
});
