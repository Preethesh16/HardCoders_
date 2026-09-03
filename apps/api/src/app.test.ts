import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

describe('API health', () => {
  it('returns the service identity', async () => {
    const app = await buildApp();
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/health/live' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      name: 'optiwork-api',
      status: 'ok',
      version: '0.1.0',
      profile: 'demo',
    });
  });
});
