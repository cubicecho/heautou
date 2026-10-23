import { defineConfig } from 'drizzle-kit';

/** Migrations are generated from the tables in server/db/schema.ts and committed in drizzle/. */
export default defineConfig({
  out: './drizzle',
  schema: './server/db/schema.ts',
  dialect: 'postgresql',
});
