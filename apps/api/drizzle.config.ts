import type { Config } from 'drizzle-kit';

/**
 * Migrations are generated, reviewed and committed. The API never migrates a
 * database it did not start, and never migrates automatically in a hosted
 * profile.
 */
export default {
  schema: './src/db/schema.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: { url: process.env['DATABASE_URL'] ?? 'postgresql://localhost:5432/optiwork' },
  strict: true,
  verbose: true,
} satisfies Config;
