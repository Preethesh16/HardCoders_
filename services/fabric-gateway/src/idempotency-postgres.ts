import { createHash, randomUUID } from 'node:crypto';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import type {
  IdempotencyClaim,
  IdempotencyStorageKey,
  IdempotencyStore,
} from './idempotency.js';

const SCHEMA_COMPONENT = 'gateway-idempotency';
const SCHEMA_VERSION = 1;
const SCHEMA_CHECKSUM = '1cc83dd5dcb5578daf9ae1eb8a106e8246688aef9da3a19d67ec99c462a9a9c2';

const CREATE_SCHEMA_SQL = `
BEGIN;
CREATE TABLE IF NOT EXISTS public.gateway_schema_migrations (
  component text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  checksum char(64) NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (component, version)
);
CREATE TABLE IF NOT EXISTS public.gateway_idempotency_records (
  actor_scope_hash char(64) NOT NULL,
  idempotency_key_hash char(64) NOT NULL,
  fingerprint char(64) NOT NULL,
  state text NOT NULL CHECK (state IN ('IN_PROGRESS', 'COMPLETED')),
  owner_token uuid,
  lease_expires_at timestamptz,
  expires_at timestamptz NOT NULL,
  response_json jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (actor_scope_hash, idempotency_key_hash),
  CHECK (actor_scope_hash ~ '^[0-9a-f]{64}$'),
  CHECK (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  CHECK (
    (state = 'IN_PROGRESS' AND response_json IS NULL)
    OR (state = 'COMPLETED' AND owner_token IS NULL AND lease_expires_at IS NULL AND response_json IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS gateway_idempotency_records_expiry_idx
  ON public.gateway_idempotency_records (expires_at);
INSERT INTO public.gateway_schema_migrations (component, version, checksum)
VALUES ('${SCHEMA_COMPONENT}', ${SCHEMA_VERSION}, '${SCHEMA_CHECKSUM}')
ON CONFLICT (component, version) DO NOTHING;
COMMIT;
`;

interface IdempotencyRow extends QueryResultRow {
  readonly fingerprint: string;
  readonly state: 'IN_PROGRESS' | 'COMPLETED';
  readonly response_json: unknown;
  readonly lease_remaining_ms: string | number | null;
}

export interface PostgresIdempotencyStoreOptions {
  readonly connectionString: string;
  readonly autoMigrate: boolean;
  readonly maxConnections: number;
  readonly connectionTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly onPoolError?: () => void;
}

/** PostgreSQL logged-table adapter shared by every Gateway replica. */
export class PostgresIdempotencyStore implements IdempotencyStore {
  readonly #pool: Pool;
  readonly #autoMigrate: boolean;

  public constructor(pool: Pool, autoMigrate: boolean) {
    this.#pool = pool;
    this.#autoMigrate = autoMigrate;
  }

  public static connect(options: PostgresIdempotencyStoreOptions): PostgresIdempotencyStore {
    const pool = new Pool({
      connectionString: options.connectionString,
      max: options.maxConnections,
      connectionTimeoutMillis: options.connectionTimeoutMs,
      idleTimeoutMillis: options.idleTimeoutMs,
      application_name: 'optiwork-fabric-gateway-idempotency',
    });
    pool.on('error', () => options.onPoolError?.());
    return new PostgresIdempotencyStore(pool, options.autoMigrate);
  }

  public async initialize(): Promise<void> {
    if (this.#autoMigrate) await this.#pool.query(CREATE_SCHEMA_SQL);
    await this.#verifySchema();
    await this.#verifyRuntimeCapabilities();
  }

  public async readiness(): Promise<boolean> {
    try {
      await this.#verifySchema();
      await this.#verifyRuntimeCapabilities();
      return true;
    } catch {
      return false;
    }
  }

  public async claim(
    key: IdempotencyStorageKey,
    fingerprint: string,
    ownerToken: string,
    leaseMs: number,
    ttlMs: number,
  ): Promise<IdempotencyClaim> {
    return this.#transaction(async (client) => {
      await client.query(
        `DELETE FROM public.gateway_idempotency_records
          WHERE ctid IN (
            SELECT ctid FROM public.gateway_idempotency_records
             WHERE expires_at <= clock_timestamp()
               AND (state = 'COMPLETED' OR lease_expires_at <= clock_timestamp())
             ORDER BY expires_at
             LIMIT 100
             FOR UPDATE SKIP LOCKED
          )`,
      );
      // The transaction-scoped lock serializes the no-row/first-insert case as
      // well as recovery across multiple Gateway replicas.
      await client.query(
        `SELECT pg_catalog.pg_advisory_xact_lock(
                  pg_catalog.hashtextextended($1 || ':' || $2, 0))`,
        [key.actorScopeHash, key.idempotencyKeyHash],
      );
      await client.query(
        `DELETE FROM public.gateway_idempotency_records
         WHERE actor_scope_hash = $1 AND idempotency_key_hash = $2
           AND expires_at <= clock_timestamp()
           AND (state = 'COMPLETED' OR lease_expires_at <= clock_timestamp())`,
        [key.actorScopeHash, key.idempotencyKeyHash],
      );
      const selected = await client.query<IdempotencyRow>(
        `SELECT fingerprint, state, response_json,
                GREATEST(0, CEIL(EXTRACT(EPOCH FROM
                  (lease_expires_at - clock_timestamp())) * 1000))::bigint AS lease_remaining_ms
           FROM public.gateway_idempotency_records
          WHERE actor_scope_hash = $1 AND idempotency_key_hash = $2
          FOR UPDATE`,
        [key.actorScopeHash, key.idempotencyKeyHash],
      );
      const record = selected.rows[0];
      if (record === undefined) {
        await client.query(
          `INSERT INTO public.gateway_idempotency_records
             (actor_scope_hash, idempotency_key_hash, fingerprint, state,
              owner_token, lease_expires_at, expires_at)
           VALUES ($1, $2, $3, 'IN_PROGRESS', $4::uuid,
                   clock_timestamp() + ($5 * interval '1 millisecond'),
                   clock_timestamp() + ($6 * interval '1 millisecond'))`,
          [key.actorScopeHash, key.idempotencyKeyHash, fingerprint, ownerToken, leaseMs, ttlMs],
        );
        return { kind: 'acquired' };
      }
      if (record.fingerprint !== fingerprint) return { kind: 'conflict' };
      if (record.state === 'COMPLETED') return { kind: 'completed', result: record.response_json };
      const leaseRemainingMs = Number(record.lease_remaining_ms ?? 0);
      if (Number.isFinite(leaseRemainingMs) && leaseRemainingMs > 0) {
        return { kind: 'pending', retryAfterMs: Math.max(1, leaseRemainingMs) };
      }
      await client.query(
        `UPDATE public.gateway_idempotency_records
            SET owner_token = $4::uuid,
                lease_expires_at = clock_timestamp() + ($5 * interval '1 millisecond'),
                expires_at = clock_timestamp() + ($6 * interval '1 millisecond'),
                updated_at = clock_timestamp()
          WHERE actor_scope_hash = $1 AND idempotency_key_hash = $2
            AND fingerprint = $3 AND state = 'IN_PROGRESS'`,
        [key.actorScopeHash, key.idempotencyKeyHash, fingerprint, ownerToken, leaseMs, ttlMs],
      );
      return { kind: 'acquired' };
    });
  }

  public async renew(
    key: IdempotencyStorageKey,
    fingerprint: string,
    ownerToken: string,
    leaseMs: number,
  ): Promise<boolean> {
    const result = await this.#pool.query(
      `UPDATE public.gateway_idempotency_records
          SET lease_expires_at = clock_timestamp() + ($5 * interval '1 millisecond'),
              updated_at = clock_timestamp()
        WHERE actor_scope_hash = $1 AND idempotency_key_hash = $2
          AND fingerprint = $3 AND owner_token = $4::uuid AND state = 'IN_PROGRESS'`,
      [key.actorScopeHash, key.idempotencyKeyHash, fingerprint, ownerToken, leaseMs],
    );
    return result.rowCount === 1;
  }

  public async complete(
    key: IdempotencyStorageKey,
    fingerprint: string,
    ownerToken: string,
    result: unknown,
    ttlMs: number,
  ): Promise<boolean> {
    const serialized = JSON.stringify(result);
    if (serialized === undefined) throw new Error('Idempotent command results must be JSON serializable');
    const updated = await this.#pool.query(
      `UPDATE public.gateway_idempotency_records
          SET state = 'COMPLETED', owner_token = NULL, lease_expires_at = NULL,
              response_json = $5::jsonb,
              expires_at = clock_timestamp() + ($6 * interval '1 millisecond'),
              updated_at = clock_timestamp()
        WHERE actor_scope_hash = $1 AND idempotency_key_hash = $2
          AND fingerprint = $3 AND owner_token = $4::uuid AND state = 'IN_PROGRESS'`,
      [key.actorScopeHash, key.idempotencyKeyHash, fingerprint, ownerToken, serialized, ttlMs],
    );
    return updated.rowCount === 1;
  }

  public async abandon(
    key: IdempotencyStorageKey,
    fingerprint: string,
    ownerToken: string,
    preserveFingerprint: boolean,
  ): Promise<void> {
    if (preserveFingerprint) {
      await this.#pool.query(
        `UPDATE public.gateway_idempotency_records
            SET owner_token = NULL, lease_expires_at = clock_timestamp(), updated_at = clock_timestamp()
          WHERE actor_scope_hash = $1 AND idempotency_key_hash = $2
            AND fingerprint = $3 AND owner_token = $4::uuid AND state = 'IN_PROGRESS'`,
        [key.actorScopeHash, key.idempotencyKeyHash, fingerprint, ownerToken],
      );
      return;
    }
    await this.#pool.query(
      `DELETE FROM public.gateway_idempotency_records
        WHERE actor_scope_hash = $1 AND idempotency_key_hash = $2
          AND fingerprint = $3 AND owner_token = $4::uuid AND state = 'IN_PROGRESS'`,
      [key.actorScopeHash, key.idempotencyKeyHash, fingerprint, ownerToken],
    );
  }

  public async close(): Promise<void> {
    await this.#pool.end();
  }

  async #verifySchema(): Promise<void> {
    const result = await this.#pool.query<{ version: number; checksum: string }>(
      `SELECT version, checksum
         FROM public.gateway_schema_migrations
        WHERE component = $1
        ORDER BY version DESC
        LIMIT 1`,
      [SCHEMA_COMPONENT],
    );
    const migration = result.rows[0];
    if (migration === undefined
      || migration.version !== SCHEMA_VERSION
      || migration.checksum !== SCHEMA_CHECKSUM) {
      throw new Error(
        `Gateway idempotency schema must be migrated to version ${SCHEMA_VERSION} with the tracked checksum`,
      );
    }
  }

  /**
   * Prove that the configured runtime role can execute the operations used by
   * every replica. The probe is deliberately rollback-only: it exercises RLS,
   * column privileges, row locking, and advisory locks without leaving a row.
   */
  async #verifyRuntimeCapabilities(): Promise<void> {
    const probeId = randomUUID();
    const actorScopeHash = readinessHash(`${probeId}:actor`);
    const idempotencyKeyHash = readinessHash(`${probeId}:key`);
    const fingerprint = readinessHash(`${probeId}:fingerprint`);
    const ownerToken = randomUUID();
    const client = await this.#pool.connect();
    let failure: unknown;
    let discardClient = false;

    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT pg_catalog.pg_advisory_xact_lock(
                  pg_catalog.hashtextextended($1, 0))`,
        [`gateway-readiness:${probeId}`],
      );
      await client.query(
        `INSERT INTO public.gateway_idempotency_records
           (actor_scope_hash, idempotency_key_hash, fingerprint, state,
            owner_token, lease_expires_at, expires_at)
         VALUES ($1, $2, $3, 'IN_PROGRESS', $4::uuid,
                 clock_timestamp() + interval '1 minute',
                 clock_timestamp() + interval '2 minutes')`,
        [actorScopeHash, idempotencyKeyHash, fingerprint, ownerToken],
      );
      const selected = await client.query(
        `SELECT actor_scope_hash, idempotency_key_hash, fingerprint, state,
                owner_token, lease_expires_at, expires_at, response_json
           FROM public.gateway_idempotency_records
          WHERE actor_scope_hash = $1 AND idempotency_key_hash = $2
          FOR UPDATE SKIP LOCKED`,
        [actorScopeHash, idempotencyKeyHash],
      );
      if (selected.rowCount !== 1) {
        throw new Error('Gateway idempotency readiness row was hidden by the runtime role');
      }
      const updated = await client.query(
        `UPDATE public.gateway_idempotency_records
            SET state = 'COMPLETED', owner_token = NULL, lease_expires_at = NULL,
                response_json = $3::jsonb,
                expires_at = clock_timestamp() + interval '2 minutes',
                updated_at = clock_timestamp()
          WHERE actor_scope_hash = $1 AND idempotency_key_hash = $2`,
        [actorScopeHash, idempotencyKeyHash, JSON.stringify({ readinessProbe: true })],
      );
      if (updated.rowCount !== 1) {
        throw new Error('Gateway idempotency readiness row could not be updated by the runtime role');
      }
      const deleted = await client.query(
        `DELETE FROM public.gateway_idempotency_records
          WHERE ctid IN (
            SELECT ctid FROM public.gateway_idempotency_records
             WHERE actor_scope_hash = $1 AND idempotency_key_hash = $2
             FOR UPDATE SKIP LOCKED
          )`,
        [actorScopeHash, idempotencyKeyHash],
      );
      if (deleted.rowCount !== 1) {
        throw new Error('Gateway idempotency readiness row could not be deleted by the runtime role');
      }
    } catch (error) {
      failure = error;
    }

    try {
      await client.query('ROLLBACK');
    } catch (error) {
      failure ??= error;
      discardClient = true;
    } finally {
      client.release(discardClient);
    }

    if (failure !== undefined) {
      throw new Error(
        'Gateway idempotency runtime role lacks required SELECT/INSERT/UPDATE/DELETE/advisory-lock capability',
        { cause: failure },
      );
    }
  }

  async #transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the original database failure.
      }
      throw error;
    } finally {
      client.release();
    }
  }
}

function readinessHash(value: string): string {
  return createHash('sha256').update(`gateway-readiness\0${value}`).digest('hex');
}
