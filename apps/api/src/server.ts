import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createContext } from './context.js';
import { seedDemo } from './demo/seed.js';
import { migrateDatabase } from './db/migrate.js';

const config = loadConfig();
if (config.databaseUrl !== undefined) await migrateDatabase(config.databaseUrl);
const context = createContext(config);
const app = await buildApp({ logger: true, config, context });

// The demo profile starts with a populated marketplace so the walkthrough is
// immediate. Hosted profiles start empty and are seeded deliberately.
if (config.profile === 'demo') {
  const seed = await seedDemo(context);
  app.log.info({ issuerDid: seed.issuerDid }, 'Seeded the demonstration marketplace');
}

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
