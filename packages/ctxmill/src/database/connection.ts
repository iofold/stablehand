import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';

type DatabaseConnection = {
  db: BetterSQLite3Database<typeof schema>;
  sqlite: BetterSqlite3.Database;
};

export function createDatabase(dbPath: string): DatabaseConnection {
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}
