import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/database/schema-pg.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://ctxmill:ctxmill@localhost:5433/ctxmill',
  },
});
