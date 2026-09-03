import { buildApp } from './app.js';

const host = process.env['API_HOST'] ?? '127.0.0.1';
const port = Number(process.env['API_PORT'] ?? '4000');

const app = await buildApp({ logger: true });

try {
  await app.listen({ host, port });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
