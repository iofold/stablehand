import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as pgSchema from './schema-pg.js';

export type PgDb = PostgresJsDatabase<typeof pgSchema>;
export type DrizzleDb = PgDb;

export interface DatabaseConnection {
  db: DrizzleDb;
  /** Raw postgres.js client for migrations */
  pgClient: import('postgres').Sql;
  /** Close the connection pool */
  close: () => Promise<void>;
}

export async function createDatabase(url: string): Promise<DatabaseConnection> {
  const postgres = (await import('postgres')).default;
  const { drizzle } = await import('drizzle-orm/postgres-js');

  const client = postgres(url, { max: 10 });
  const db = drizzle(client, { schema: pgSchema });
  return {
    db,
    pgClient: client,
    close: async () => { await client.end(); },
  };
}

export interface DatabaseConfig {
  /** PostgreSQL connection URL */
  url: string;
}
