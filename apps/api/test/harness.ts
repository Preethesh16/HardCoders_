import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig, type ApiConfig } from '../src/config.js';
import { createContext, type AppContext, type ContextOverrides } from '../src/context.js';
import { seedDemo, type SeedResult } from '../src/demo/seed.js';
import { FixedClock, SequentialIds } from '../src/runtime.js';

export interface Harness {
  readonly app: FastifyInstance;
  readonly context: AppContext;
  readonly clock: FixedClock;
  readonly seed: SeedResult;
  readonly config: ApiConfig;
  close(): Promise<void>;
}

/**
 * A complete API under deterministic time and identifiers, wired to in-memory
 * adapters. Every test exercises the same business code the hosted profiles run.
 */
export async function createHarness(
  environment: NodeJS.ProcessEnv = {},
  overrides: ContextOverrides = {},
): Promise<Harness> {
  const config = loadConfig({
    OPTIWORK_PROFILE: 'demo',
    REGULATION_REFRESH_MODE: 'fixture',
    COMPANY_VERIFICATION_MODE: 'fixture',
    ...environment,
  });
  const clock = new FixedClock(new Date('2026-09-03T09:00:00.000Z'));
  const context = createContext(config, { ...overrides, clock, ids: new SequentialIds() });
  const app = await buildApp({ config, context, logger: false });
  const seed = await seedDemo(context);
  return {
    app,
    context,
    clock,
    seed,
    config,
    async close() {
      await app.close();
      await context.close();
    },
  };
}

export interface CallOptions {
  readonly token: string;
  readonly idempotencyKey?: string;
  readonly body?: unknown;
}

export async function call(
  harness: Harness,
  method: 'GET' | 'POST',
  url: string,
  options: CallOptions,
): Promise<{ status: number; body: any; replay: string | undefined }> {
  const response = await harness.app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${options.token}`,
      ...(options.idempotencyKey === undefined ? {} : { 'idempotency-key': options.idempotencyKey }),
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(options.body === undefined ? {} : { payload: JSON.stringify(options.body) }),
  });
  return {
    status: response.statusCode,
    body: response.body.length > 0 ? response.json() : null,
    replay: response.headers['idempotent-replay'] as string | undefined,
  };
}

export const base64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');
