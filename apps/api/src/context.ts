/**
 * Application wiring.
 *
 * One place builds every adapter from configuration, so a route never chooses
 * between a real and a simulated dependency and a test can substitute any part
 * without touching business code.
 */

import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import type { ApiConfig } from './config.js';
import { MemoryDataStore, PostgresDataStore, type DataStore } from './db/store.js';
import { DemoTokenVerifier, OidcTokenVerifier, type TokenVerifier } from './auth/authorization.js';
import { createObjectStore, type ObjectStore } from './storage/object-store.js';
import { createAiAdapter, type AiAdapter } from './ai/adapter.js';
import { MockFabricEvidenceReader, type FabricEvidenceReader } from './fabric/evidence-reader.js';
import {
  HttpEscrowExecutor,
  HttpFabricPermitProvider,
  SimulatedEscrowExecutor,
  type EscrowExecutor,
} from './algorand/executor-client.js';
import { FixtureRateSource, FrankfurterRateSource, type FxRateSource } from './fx/rates.js';
import { IdempotencyStore } from './idempotency/store.js';
import { Ledger } from './ledger/books.js';
import { Timeline } from './timeline/events.js';
import { SequentialIds, systemClock, type Clock, type IdGenerator } from './runtime.js';

export interface AppContext {
  readonly config: ApiConfig;
  readonly store: DataStore;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly auth: TokenVerifier;
  readonly objects: ObjectStore;
  readonly ai: AiAdapter;
  readonly fabric: FabricEvidenceReader;
  readonly escrow: EscrowExecutor;
  readonly rates: FxRateSource;
  readonly idempotency: IdempotencyStore;
  readonly ledger: Ledger;
  readonly timeline: Timeline;
  close(): Promise<void>;
}

export interface ContextOverrides {
  readonly store?: DataStore;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  readonly auth?: TokenVerifier;
  readonly objects?: ObjectStore;
  readonly ai?: AiAdapter;
  readonly fabric?: FabricEvidenceReader;
  readonly escrow?: EscrowExecutor;
  readonly rates?: FxRateSource;
}

function createDataStore(config: ApiConfig): DataStore {
  if (config.databaseUrl === undefined) return new MemoryDataStore();
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: 10,
    application_name: 'optiwork-api',
    statement_timeout: 15_000,
  });
  return new PostgresDataStore(drizzle(pool), async () => { await pool.end(); });
}

export function createContext(config: ApiConfig, overrides: ContextOverrides = {}): AppContext {
  const store = overrides.store ?? createDataStore(config);
  const clock = overrides.clock ?? systemClock;
  const ids = overrides.ids ?? new SequentialIds();

  const auth = overrides.auth
    ?? (config.auth.mode === 'oidc' ? new OidcTokenVerifier(config.auth) : new DemoTokenVerifier());
  const permitProvider = config.algorand.mode === 'executor'
    ? new HttpFabricPermitProvider({
      baseUrl: config.fabric.gatewayUrl!,
      ...(config.fabric.gatewayToken === undefined ? {} : { bearerToken: config.fabric.gatewayToken }),
      timeoutMs: config.fabric.gatewayTimeoutMs,
    })
    : undefined;
  const escrow = overrides.escrow
    ?? (config.algorand.mode === 'executor'
      ? new HttpEscrowExecutor(
        config.algorand.executorUrl!,
        config.algorand.executorToken!,
        permitProvider!.issue.bind(permitProvider),
      )
      : new SimulatedEscrowExecutor(() => clock.now()));
  const rates = overrides.rates
    ?? (config.fx.mode === 'frankfurter' ? new FrankfurterRateSource(config.fx.baseUrl) : new FixtureRateSource());
  const fabric = overrides.fabric
    ?? new MockFabricEvidenceReader(config.fabric.evidenceFixturePath);

  return {
    config,
    store,
    clock,
    ids,
    auth,
    objects: overrides.objects ?? createObjectStore(config.storage),
    ai: overrides.ai ?? createAiAdapter(config.ai),
    fabric,
    escrow,
    rates,
    idempotency: new IdempotencyStore(store, clock, ids),
    ledger: new Ledger(store, clock, ids),
    timeline: new Timeline(store, clock, ids),
    async close() {
      await store.close();
    },
  };
}
