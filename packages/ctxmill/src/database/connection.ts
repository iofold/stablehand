import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import { drizzle as drizzleSqlite, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as sqliteSchema from './schema-sqlite.js';
import * as pgSchema from './schema-pg.js';

export type SqliteDb = BetterSQLite3Database<typeof sqliteSchema>;
export type PgDb = PostgresJsDatabase<typeof pgSchema>;
export type DrizzleDb = SqliteDb | PgDb;
export type DbDialect = 'sqlite' | 'postgres';

export interface DatabaseConnection {
  db: DrizzleDb;
  dialect: DbDialect;
  /** Raw SQLite handle for migrations (only set for SQLite) */
  sqlite?: BetterSqlite3.Database;
  /** Raw postgres.js client for migrations (only set for Postgres) */
  pgClient?: import('postgres').Sql;
  /** Close the connection pool */
  close: () => Promise<void>;
}

export function createSqliteDatabase(dbPath: string): DatabaseConnection {
  mkdirSync(dirname(dbPath), { recursive: true });
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzleSqlite(sqlite, { schema: sqliteSchema });
  return {
    db,
    dialect: 'sqlite',
    sqlite,
    close: async () => { sqlite.close(); },
  };
}

export async function createPostgresDatabase(url: string): Promise<DatabaseConnection> {
  const postgres = (await import('postgres')).default;
  const { drizzle } = await import('drizzle-orm/postgres-js');

  const client = postgres(url, { max: 10 });
  const db = drizzle(client, { schema: pgSchema });
  return {
    db,
    dialect: 'postgres',
    pgClient: client,
    close: async () => { await client.end(); },
  };
}

export interface DatabaseConfig {
  type: DbDialect;
  /** SQLite file path (required when type === 'sqlite') */
  path?: string;
  /** PostgreSQL connection URL (required when type === 'postgres') */
  url?: string;
}

export async function createDatabase(config: DatabaseConfig, dataDir?: string): Promise<DatabaseConnection> {
  if (config.type === 'postgres') {
    if (!config.url) {
      throw new Error('PostgreSQL connection URL is required when type is "postgres"');
    }
    return createPostgresDatabase(config.url);
  }

  // Default to SQLite
  const dbPath = config.path
    ? (dataDir ? join(dataDir, config.path) : config.path)
    : (dataDir ? join(dataDir, 'ctxmill.db') : 'ctxmill.db');
  return createSqliteDatabase(dbPath);
}
