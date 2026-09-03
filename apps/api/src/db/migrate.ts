import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

export async function migrateDatabase(databaseUrl: string): Promise<void> {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 1,
    application_name: 'optiwork-api-migrations',
    statement_timeout: 30_000,
  });
  try {
    const migrationsFolder = fileURLToPath(new URL('../../migrations', import.meta.url));
    await migrate(drizzle(pool), { migrationsFolder });
  } finally {
    await pool.end();
  }
}
