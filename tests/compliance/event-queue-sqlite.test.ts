/**
 * EventQueue compliance test (PostgreSQL-backed)
 *
 * Runs the EventQueue compliance suite against the EventQueueImpl
 * implementation, using the Postgres test database.
 */

import { describe, beforeAll, afterAll } from 'vitest';
import { createTestDb, type TestDb } from '../utils/test-db.js';
import { TypedEventBus } from '../../packages/ctxmill/src/events/bus.js';
import { EventQueueImpl } from '../../packages/ctxmill/src/events/event-queue.js';
import { eventQueueComplianceSuite } from './event-queue.compliance.js';

let testDb: TestDb | null = null;

describe('EventQueueImpl compliance (Postgres)', () => {
  beforeAll(async () => {
    testDb = await createTestDb();
  });

  afterAll(async () => {
    if (testDb) {
      await testDb.close();
      testDb = null;
    }
  });

  eventQueueComplianceSuite({
    createQueue: () => {
      // Reuse the existing DB connection, just create a fresh bus + queue
      const bus = new TypedEventBus();
      return new EventQueueImpl(bus, testDb!.repo);
    },
    cleanup: async () => {
      // No per-test cleanup needed
    },
    // Fake timers are incompatible with async Postgres I/O
    skipTimerTests: true,
  });
});
