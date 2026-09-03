import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { z } from "zod";

import { sha256 } from "./canonical.js";
import type { ExecutorConfig } from "./config.js";
import { conflict, unavailable } from "./errors.js";
import {
  actionSchema,
  escrowBindingSchema,
  escrowSchema,
  hashSchema,
  permitClaimsSchema,
  transactionIdSchema,
  uint64StringSchema,
  type Escrow,
  type EscrowBinding,
  type ExecutorAction,
  type PermitClaims,
} from "./types.js";

export type PreparedTransaction = {
  schemaVersion: "2.0";
  commandHash: string;
  commandBindingHash: string;
  transactionId: string;
  transactionIds: string[];
  signedTransactionsBase64: string[];
  lastValidRound: string;
};

const preparedSchema: z.ZodType<PreparedTransaction> = z.object({
  schemaVersion: z.literal("2.0"),
  commandHash: hashSchema,
  commandBindingHash: hashSchema,
  transactionId: transactionIdSchema,
  transactionIds: z.array(transactionIdSchema).min(1).max(16),
  signedTransactionsBase64: z.array(z.string().min(4).max(1_048_576).regex(/^[A-Za-z0-9+/]+={0,2}$/u)).min(1).max(16),
  lastValidRound: z.string().regex(/^[1-9][0-9]{0,19}$/u),
}).strict().superRefine((value, context) => {
  if (value.transactionIds.length !== value.signedTransactionsBase64.length
    || value.transactionIds.at(-1) !== value.transactionId
    || new Set(value.transactionIds).size !== value.transactionIds.length) {
    context.addIssue({ code: "custom", message: "Prepared transaction IDs must uniquely match every signed transaction." });
  }
});

export type CommandRecord = {
  idempotencyKey: string;
  dealId: string;
  action: ExecutorAction;
  commandHash: string;
  permitJti: string;
  permitClaims: PermitClaims;
  status: "PENDING" | "PREPARED" | "CANCELLED" | "ABANDONED" | "SUCCEEDED";
  prepared?: PreparedTransaction;
  response?: unknown;
  transactionId?: string;
  confirmedRound?: string;
  abandonmentRound?: string;
  cancellationTime?: string;
};

export interface ExecutorStore {
  initialize(): Promise<void>;
  withDealLock<T>(dealId: string, work: () => Promise<T>): Promise<T>;
  getCommand(idempotencyKey: string): Promise<CommandRecord | null>;
  getCommandByTransaction(transactionId: string): Promise<CommandRecord | null>;
  beginCommand(dealId: string, action: ExecutorAction, idempotencyKey: string, commandHash: string, permit: PermitClaims): Promise<CommandRecord>;
  reauthorizeCommand(idempotencyKey: string, permit: PermitClaims): Promise<CommandRecord>;
  markPrepared(idempotencyKey: string, prepared: PreparedTransaction): Promise<CommandRecord>;
  cancelPending(idempotencyKey: string): Promise<CommandRecord | null>;
  abandon(idempotencyKey: string, observedRound: string): Promise<CommandRecord>;
  complete(idempotencyKey: string, confirmedRound: string, response: unknown, escrow: Escrow): Promise<CommandRecord>;
  getEscrow(dealId: string): Promise<Escrow | null>;
  close(): Promise<void>;
}

function immutableBinding(escrow: Escrow): EscrowBinding {
  return escrowBindingSchema.parse({
    dealId: escrow.dealId,
    agreementHash: escrow.agreementHash,
    network: escrow.network,
    genesisHash: escrow.genesisHash,
    originProviderAddress: escrow.originProviderAddress,
    destinationProviderAddress: escrow.destinationProviderAddress,
    assetId: escrow.assetId,
    amount: escrow.amount,
    applicationId: escrow.applicationId,
  });
}

function assertSameCommand(record: CommandRecord, action: ExecutorAction, commandHash: string): CommandRecord {
  if (record.action !== action || record.commandHash !== commandHash) {
    throw conflict("The idempotency key is already bound to another command.");
  }
  return record;
}

export class MemoryExecutorStore implements ExecutorStore {
  readonly #commands = new Map<string, CommandRecord>();
  readonly #permits = new Map<string, { key: string; hash: string }>();
  readonly #escrows = new Map<string, Escrow>();
  readonly #dealQueues = new Map<string, Promise<void>>();

  async initialize(): Promise<void> {}

  async withDealLock<T>(dealId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#dealQueues.get(dealId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.#dealQueues.set(dealId, current);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.#dealQueues.get(dealId) === current) this.#dealQueues.delete(dealId);
    }
  }

  async getCommand(key: string): Promise<CommandRecord | null> {
    const value = this.#commands.get(key);
    return value ? structuredClone(value) : null;
  }

  async getCommandByTransaction(transactionId: string): Promise<CommandRecord | null> {
    const value = [...this.#commands.values()].find((record) => record.transactionId === transactionId);
    return value ? structuredClone(value) : null;
  }

  async beginCommand(dealId: string, action: ExecutorAction, key: string, commandHash: string, permit: PermitClaims): Promise<CommandRecord> {
    const existing = this.#commands.get(key);
    if (existing) {
      if (existing.dealId !== dealId) throw conflict("The idempotency key is already bound to another deal.");
      return structuredClone(assertSameCommand(existing, action, commandHash));
    }
    const unresolved = [...this.#commands.values()].find((record) =>
      record.dealId === dealId && (record.status === "PENDING" || record.status === "PREPARED"));
    if (unresolved) throw conflict("Another command for this deal must be reconciled first.");
    const usedPermit = this.#permits.get(permit.jti);
    if (usedPermit && (usedPermit.key !== key || usedPermit.hash !== commandHash)) {
      throw conflict("The Fabric authorization permit has already authorized another command.");
    }
    const record: CommandRecord = {
      idempotencyKey: key,
      dealId,
      action,
      commandHash,
      permitJti: permit.jti,
      permitClaims: structuredClone(permit),
      status: "PENDING",
    };
    this.#permits.set(permit.jti, { key, hash: commandHash });
    this.#commands.set(key, record);
    return structuredClone(record);
  }

  async reauthorizeCommand(key: string, permit: PermitClaims): Promise<CommandRecord> {
    const record = this.#commands.get(key);
    if (!record || (record.status !== "PENDING" && record.status !== "PREPARED")) {
      throw conflict("The command cannot be reauthorized.");
    }
    if (permit.commandHash !== record.commandHash || permit.action !== record.action || permit.idempotencyKey !== key) {
      throw conflict("The replacement Fabric permit is bound to another command.");
    }
    const usedPermit = this.#permits.get(permit.jti);
    if (usedPermit && (usedPermit.key !== key || usedPermit.hash !== record.commandHash)) {
      throw conflict("The Fabric authorization permit has already authorized another command.");
    }
    this.#permits.set(permit.jti, { key, hash: record.commandHash });
    record.permitJti = permit.jti;
    record.permitClaims = structuredClone(permit);
    return structuredClone(record);
  }

  async markPrepared(key: string, prepared: PreparedTransaction): Promise<CommandRecord> {
    preparedSchema.parse(prepared);
    const record = this.#commands.get(key);
    if (!record) throw conflict("The command reservation is missing.");
    if (record.status !== "PENDING") {
      if (record.status === "CANCELLED") throw conflict("The expired unsigned command cannot be prepared.");
      if (record.status === "ABANDONED") throw conflict("The expired command cannot be prepared again.");
      if (JSON.stringify(record.prepared) !== JSON.stringify(prepared)) throw conflict("The command already has different signed transactions.");
      return structuredClone(record);
    }
    record.status = "PREPARED";
    record.prepared = structuredClone(prepared);
    record.transactionId = prepared.transactionId;
    return structuredClone(record);
  }

  async cancelPending(key: string): Promise<CommandRecord | null> {
    const record = this.#commands.get(key);
    if (!record) throw conflict("The command reservation is missing.");
    if (record.status === "CANCELLED") return structuredClone(record);
    if (record.status !== "PENDING" || record.action !== "release" || record.permitClaims.action !== "release") {
      throw conflict("Only an unsigned release command can be cancelled after lease expiry.");
    }
    const leaseExpiresAt = Date.parse(record.permitClaims.releaseAuthorization.leaseExpiresAt);
    if (!Number.isFinite(leaseExpiresAt)) throw conflict("The persisted Fabric release lease is invalid.");
    if (Date.now() < leaseExpiresAt) return null;
    record.status = "CANCELLED";
    record.cancellationTime = new Date(Date.now()).toISOString();
    return structuredClone(record);
  }

  async abandon(key: string, observedRound: string): Promise<CommandRecord> {
    const parsedObservedRound = uint64StringSchema.parse(observedRound);
    const record = this.#commands.get(key);
    if (!record?.prepared || !record.transactionId) throw conflict("The command is not prepared.");
    if (record.status === "ABANDONED") return structuredClone(record);
    if (record.status !== "PREPARED") throw conflict("Only an unconfirmed prepared command can be abandoned.");
    if (BigInt(parsedObservedRound) < BigInt(record.prepared.lastValidRound)) {
      throw conflict("The prepared transaction is still within its valid round window.");
    }
    record.status = "ABANDONED";
    record.abandonmentRound = parsedObservedRound;
    return structuredClone(record);
  }

  async complete(key: string, confirmedRound: string, response: unknown, escrow: Escrow): Promise<CommandRecord> {
    const parsedEscrow = escrowSchema.parse(escrow);
    const record = this.#commands.get(key);
    if (!record?.prepared || !record.transactionId) throw conflict("The command is not prepared.");
    if (record.status === "SUCCEEDED") return structuredClone(record);
    if (record.status !== "PREPARED") throw conflict("The command is not prepared.");
    const prior = this.#escrows.get(parsedEscrow.dealId);
    if (prior && sha256(immutableBinding(prior)) !== sha256(immutableBinding(parsedEscrow))) {
      throw conflict("The escrow immutable binding changed.");
    }
    this.#escrows.set(parsedEscrow.dealId, structuredClone(parsedEscrow));
    record.status = "SUCCEEDED";
    record.confirmedRound = confirmedRound;
    record.response = structuredClone(response);
    return structuredClone(record);
  }

  async getEscrow(dealId: string): Promise<Escrow | null> {
    const value = this.#escrows.get(dealId);
    return value ? structuredClone(value) : null;
  }

  async close(): Promise<void> {}
}

type DatabaseRow = {
  idempotency_key: string;
  deal_id: string;
  action: string;
  command_hash: string;
  permit_jti: string;
  permit_claims: unknown;
  status: string;
  prepared: unknown;
  response: unknown;
  transaction_id: string | null;
  confirmed_round: string | null;
  abandonment_round: string | null;
  cancellation_time: Date | string | null;
};

const rowSchema = z.object({
  idempotency_key: z.string(),
  deal_id: z.string(),
  action: actionSchema,
  command_hash: hashSchema,
  permit_jti: z.string(),
  permit_claims: permitClaimsSchema,
  status: z.enum(["PENDING", "PREPARED", "CANCELLED", "ABANDONED", "SUCCEEDED"]),
  prepared: z.unknown().nullable(),
  response: z.unknown().nullable(),
  transaction_id: transactionIdSchema.nullable(),
  confirmed_round: z.string().nullable(),
  abandonment_round: z.string().nullable(),
  cancellation_time: z.union([z.date(), z.string().datetime({ offset: true })]).nullable(),
}).strict();

function fromRow(input: DatabaseRow): CommandRecord {
  const row = rowSchema.parse(input);
  return {
    idempotencyKey: row.idempotency_key,
    dealId: row.deal_id,
    action: row.action,
    commandHash: row.command_hash,
    permitJti: row.permit_jti,
    permitClaims: row.permit_claims,
    status: row.status,
    ...(row.prepared === null ? {} : { prepared: preparedSchema.parse(row.prepared) }),
    ...(row.response === null ? {} : { response: row.response }),
    ...(row.transaction_id === null ? {} : { transactionId: row.transaction_id }),
    ...(row.confirmed_round === null ? {} : { confirmedRound: row.confirmed_round }),
    ...(row.abandonment_round === null ? {} : { abandonmentRound: row.abandonment_round }),
    ...(row.cancellation_time === null ? {} : {
      cancellationTime: row.cancellation_time instanceof Date
        ? row.cancellation_time.toISOString()
        : row.cancellation_time,
    }),
  };
}

export class PostgresExecutorStore implements ExecutorStore {
  readonly #pool: pg.Pool;
  readonly #lockPool: pg.Pool;

  constructor(private readonly config: ExecutorConfig) {
    const connection = {
      connectionString: config.DATABASE_URL,
      statement_timeout: 10_000,
      query_timeout: 10_000,
      ...(config.DATABASE_SSL_MODE === "disable" ? { ssl: false }
        : config.DATABASE_SSL_MODE === "verify-full" ? { ssl: { rejectUnauthorized: true } }
          : { ssl: { rejectUnauthorized: false } }),
    } as const;
    this.#pool = new pg.Pool({ ...connection, max: 10, application_name: "anchor-algorand-executor" });
    // Advisory locks use a separate pool so a full set of per-deal lock
    // sessions can never starve the data queries required to finish and release
    // those same locks.
    this.#lockPool = new pg.Pool({ ...connection, max: 10, application_name: "anchor-algorand-deal-lock" });
  }

  async initialize(): Promise<void> {
    if (this.config.DATABASE_AUTO_MIGRATE) {
      for (const name of ["001_executor.sql", "002_deal_serialization.sql", "003_prepared_recovery.sql", "004_pending_recovery.sql", "005_signed_command_binding.sql"]) {
        const path = fileURLToPath(new URL(`../migrations/${name}`, import.meta.url));
        await this.#pool.query(await readFile(path, "utf8"));
      }
    }
    const result = await this.#pool.query<{
      commands: string | null;
      permits: string | null;
      escrows: string | null;
      deal_id_ready: boolean;
      transaction_index_ready: boolean;
      active_deal_index_ready: boolean;
      prepared_recovery_ready: boolean;
      pending_recovery_ready: boolean;
      prepared_command_binding_ready: boolean;
    }>(
      `SELECT
         to_regclass('algorand_executor_commands')::text AS commands,
         to_regclass('algorand_executor_permits')::text AS permits,
         to_regclass('algorand_executor_escrows')::text AS escrows,
         EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = 'algorand_executor_commands'
             AND column_name = 'deal_id'
             AND is_nullable = 'NO'
             AND data_type = 'character varying'
             AND character_maximum_length = 128
         ) AS deal_id_ready,
         EXISTS (
           SELECT 1 FROM pg_index
           WHERE indexrelid = to_regclass('algorand_executor_commands_transaction_idx')
             AND indisunique AND indisvalid AND indpred IS NOT NULL
         ) AS transaction_index_ready,
         EXISTS (
           SELECT 1 FROM pg_index
           WHERE indexrelid = to_regclass('algorand_executor_one_active_command_per_deal_idx')
             AND indisunique AND indisvalid AND indpred IS NOT NULL
         ) AS active_deal_index_ready,
         EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = 'algorand_executor_commands'
             AND column_name = 'abandonment_round'
             AND data_type = 'numeric'
         )
         AND EXISTS (
           SELECT 1 FROM pg_constraint
           WHERE conrelid = 'algorand_executor_commands'::regclass
             AND conname IN (
               'algorand_executor_commands_status_v3_check',
               'algorand_executor_commands_status_v4_check'
             )
             AND pg_get_constraintdef(oid) LIKE '%ABANDONED%'
         )
         AND EXISTS (
           SELECT 1 FROM pg_constraint
           WHERE conrelid = 'algorand_executor_commands'::regclass
             AND conname IN (
               'algorand_executor_commands_state_v3_check',
               'algorand_executor_commands_state_v4_check'
             )
             AND pg_get_constraintdef(oid) LIKE '%lastValidRound%'
         ) AS prepared_recovery_ready,
         EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = 'algorand_executor_commands'
             AND column_name = 'cancellation_time'
             AND data_type = 'timestamp with time zone'
         )
         AND EXISTS (
           SELECT 1 FROM pg_constraint
           WHERE conrelid = 'algorand_executor_commands'::regclass
             AND conname = 'algorand_executor_commands_status_v4_check'
             AND pg_get_constraintdef(oid) LIKE '%CANCELLED%'
         )
         AND EXISTS (
           SELECT 1 FROM pg_constraint
           WHERE conrelid = 'algorand_executor_commands'::regclass
             AND conname = 'algorand_executor_commands_state_v4_check'
             AND pg_get_constraintdef(oid) LIKE '%cancellation_time%'
             AND pg_get_constraintdef(oid) LIKE '%permit_claims%'
             AND pg_get_constraintdef(oid) LIKE '%leaseExpiresAt%'
         ) AS pending_recovery_ready,
         EXISTS (
           SELECT 1 FROM pg_constraint
           WHERE conrelid = 'algorand_executor_commands'::regclass
             AND conname = 'algorand_executor_commands_prepared_v2_check'
             AND pg_get_constraintdef(oid) LIKE '%schemaVersion%'
             AND pg_get_constraintdef(oid) LIKE '%commandBindingHash%'
             AND pg_get_constraintdef(oid) LIKE '%transactionIds%'
         ) AS prepared_command_binding_ready`,
    );
    const row = result.rows[0];
    if (!row?.commands || !row.permits || !row.escrows || !row.deal_id_ready
      || !row.transaction_index_ready || !row.active_deal_index_ready
      || !row.prepared_recovery_ready || !row.pending_recovery_ready
      || !row.prepared_command_binding_ready) {
      throw unavailable("Executor database migrations 001 through 005 are not fully applied.");
    }
  }

  async withDealLock<T>(dealId: string, work: () => Promise<T>): Promise<T> {
    const client = await this.#lockPool.connect();
    let locked = false;
    let releaseWithError = false;
    try {
      await client.query("SELECT set_config('statement_timeout', $1, false)", [String(this.config.DATABASE_DEAL_LOCK_TIMEOUT_MS)]);
      await client.query("SELECT pg_advisory_lock(hashtextextended('anchor-algorand:' || $1, 0))", [dealId]);
      locked = true;
      await client.query("SELECT set_config('statement_timeout', '10000', false)");
      return await work();
    } catch (error) {
      releaseWithError = true;
      throw error;
    } finally {
      if (locked) {
        try {
          await client.query("SELECT pg_advisory_unlock(hashtextextended('anchor-algorand:' || $1, 0))", [dealId]);
        } catch {
          releaseWithError = true;
        }
      }
      client.release(releaseWithError ? new Error("Discarding executor deal-lock session.") : undefined);
    }
  }

  async getCommand(key: string): Promise<CommandRecord | null> {
    const result = await this.#pool.query<DatabaseRow>(
      "SELECT idempotency_key, deal_id, action, command_hash, permit_jti, permit_claims, status, prepared, response, transaction_id, confirmed_round::text, abandonment_round::text, cancellation_time FROM algorand_executor_commands WHERE idempotency_key = $1",
      [key],
    );
    return result.rows[0] ? fromRow(result.rows[0]) : null;
  }

  async getCommandByTransaction(transactionId: string): Promise<CommandRecord | null> {
    const result = await this.#pool.query<DatabaseRow>(
      "SELECT idempotency_key, deal_id, action, command_hash, permit_jti, permit_claims, status, prepared, response, transaction_id, confirmed_round::text, abandonment_round::text, cancellation_time FROM algorand_executor_commands WHERE transaction_id = $1",
      [transactionId],
    );
    return result.rows[0] ? fromRow(result.rows[0]) : null;
  }

  async beginCommand(dealId: string, action: ExecutorAction, key: string, commandHash: string, permit: PermitClaims): Promise<CommandRecord> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query<DatabaseRow>(
        `INSERT INTO algorand_executor_commands(idempotency_key, deal_id, action, command_hash, permit_jti, permit_claims, status)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'PENDING') ON CONFLICT DO NOTHING
         RETURNING idempotency_key, deal_id, action, command_hash, permit_jti, permit_claims, status, prepared, response, transaction_id, confirmed_round::text, abandonment_round::text, cancellation_time`,
        [key, dealId, action, commandHash, permit.jti, JSON.stringify(permit)],
      );
      if (inserted.rowCount === 1) {
        const permitInsert = await client.query(
          `INSERT INTO algorand_executor_permits(jti, idempotency_key, command_hash, expires_at)
           VALUES ($1, $2, $3, to_timestamp($4)) ON CONFLICT (jti) DO NOTHING`,
          [permit.jti, key, commandHash, permit.exp],
        );
        if (permitInsert.rowCount !== 1) throw conflict("The Fabric authorization permit has already been used.");
      }
      const selected = await client.query<DatabaseRow>(
        `SELECT idempotency_key, deal_id, action, command_hash, permit_jti, permit_claims, status, prepared, response, transaction_id, confirmed_round::text, abandonment_round::text, cancellation_time
         FROM algorand_executor_commands WHERE idempotency_key = $1 FOR UPDATE`,
        [key],
      );
      const record = selected.rows[0];
      if (!record) throw conflict("Another command for this deal must be reconciled first.");
      if (record.deal_id !== dealId) throw conflict("The idempotency key is already bound to another deal.");
      const parsed = assertSameCommand(fromRow(record), action, commandHash);
      await client.query("COMMIT");
      return parsed;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async reauthorizeCommand(key: string, permit: PermitClaims): Promise<CommandRecord> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<DatabaseRow>(
        `SELECT idempotency_key, deal_id, action, command_hash, permit_jti, permit_claims, status,
                prepared, response, transaction_id, confirmed_round::text, abandonment_round::text, cancellation_time
         FROM algorand_executor_commands WHERE idempotency_key = $1 FOR UPDATE`,
        [key],
      );
      const record = current.rows[0] ? fromRow(current.rows[0]) : null;
      if (!record || (record.status !== "PENDING" && record.status !== "PREPARED")) {
        throw conflict("The command cannot be reauthorized.");
      }
      if (permit.commandHash !== record.commandHash || permit.action !== record.action || permit.idempotencyKey !== key) {
        throw conflict("The replacement Fabric permit is bound to another command.");
      }
      await client.query(
        `INSERT INTO algorand_executor_permits(jti, idempotency_key, command_hash, expires_at)
         VALUES ($1, $2, $3, to_timestamp($4)) ON CONFLICT (jti) DO NOTHING`,
        [permit.jti, key, record.commandHash, permit.exp],
      );
      const reservation = await client.query<{ idempotency_key: string; command_hash: string }>(
        "SELECT idempotency_key, command_hash FROM algorand_executor_permits WHERE jti = $1",
        [permit.jti],
      );
      if (reservation.rows[0]?.idempotency_key !== key || reservation.rows[0]?.command_hash !== record.commandHash) {
        throw conflict("The Fabric authorization permit has already authorized another command.");
      }
      const updated = await client.query<DatabaseRow>(
        `UPDATE algorand_executor_commands
         SET permit_jti = $2, permit_claims = $3::jsonb, updated_at = clock_timestamp()
         WHERE idempotency_key = $1 AND status IN ('PENDING', 'PREPARED')
         RETURNING idempotency_key, deal_id, action, command_hash, permit_jti, permit_claims, status,
                   prepared, response, transaction_id, confirmed_round::text, abandonment_round::text, cancellation_time`,
        [key, permit.jti, JSON.stringify(permit)],
      );
      if (!updated.rows[0]) throw conflict("The command cannot be reauthorized.");
      await client.query("COMMIT");
      return fromRow(updated.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async markPrepared(key: string, prepared: PreparedTransaction): Promise<CommandRecord> {
    preparedSchema.parse(prepared);
    const result = await this.#pool.query<DatabaseRow>(
      `UPDATE algorand_executor_commands SET status = 'PREPARED', prepared = $2::jsonb,
         transaction_id = $3, updated_at = clock_timestamp()
       WHERE idempotency_key = $1 AND status = 'PENDING'
       RETURNING idempotency_key, deal_id, action, command_hash, permit_jti, permit_claims, status, prepared, response, transaction_id, confirmed_round::text, abandonment_round::text, cancellation_time`,
      [key, JSON.stringify(prepared), prepared.transactionId],
    );
    if (result.rows[0]) return fromRow(result.rows[0]);
    const existing = await this.getCommand(key);
    if (existing?.status === "CANCELLED") {
      throw conflict("The expired unsigned command cannot be prepared.");
    }
    if (!existing?.prepared || existing.status === "ABANDONED"
      || JSON.stringify(existing.prepared) !== JSON.stringify(prepared)) {
      throw conflict("The command already has different signed transactions.");
    }
    return existing;
  }

  async cancelPending(key: string): Promise<CommandRecord | null> {
    const result = await this.#pool.query<DatabaseRow>(
      `UPDATE algorand_executor_commands
       SET status = 'CANCELLED', cancellation_time = clock_timestamp(), updated_at = clock_timestamp()
       WHERE idempotency_key = $1
         AND action = 'release'
         AND status = 'PENDING'
         AND clock_timestamp() >= (permit_claims #>> '{releaseAuthorization,leaseExpiresAt}')::timestamptz
       RETURNING idempotency_key, deal_id, action, command_hash, permit_jti, permit_claims, status,
                 prepared, response, transaction_id, confirmed_round::text, abandonment_round::text, cancellation_time`,
      [key],
    );
    if (result.rows[0]) return fromRow(result.rows[0]);
    const existing = await this.getCommand(key);
    if (existing?.status === "CANCELLED") return existing;
    if (existing?.status === "PENDING" && existing.action === "release" && existing.permitClaims.action === "release") {
      return null;
    }
    throw conflict("Only an unsigned release command can be cancelled after lease expiry.");
  }

  async abandon(key: string, observedRound: string): Promise<CommandRecord> {
    const parsedObservedRound = uint64StringSchema.parse(observedRound);
    const result = await this.#pool.query<DatabaseRow>(
      `UPDATE algorand_executor_commands
       SET status = 'ABANDONED', abandonment_round = $2::numeric, updated_at = clock_timestamp()
       WHERE idempotency_key = $1
         AND status = 'PREPARED'
         AND $2::numeric >= (prepared ->> 'lastValidRound')::numeric
       RETURNING idempotency_key, deal_id, action, command_hash, permit_jti, permit_claims, status,
                 prepared, response, transaction_id, confirmed_round::text, abandonment_round::text, cancellation_time`,
      [key, parsedObservedRound],
    );
    if (result.rows[0]) return fromRow(result.rows[0]);
    const existing = await this.getCommand(key);
    if (existing?.status === "ABANDONED") return existing;
    if (existing?.status === "PREPARED" && existing.prepared
      && BigInt(parsedObservedRound) < BigInt(existing.prepared.lastValidRound)) {
      throw conflict("The prepared transaction is still within its valid round window.");
    }
    throw conflict("Only an unconfirmed prepared command can be abandoned.");
  }

  async complete(key: string, confirmedRound: string, response: unknown, escrow: Escrow): Promise<CommandRecord> {
    const parsedEscrow = escrowSchema.parse(escrow);
    const binding = immutableBinding(parsedEscrow);
    const bindingHash = sha256(binding);
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const prior = await client.query<{ immutable_binding_hash: string }>(
        "SELECT immutable_binding_hash FROM algorand_executor_escrows WHERE deal_id = $1 FOR UPDATE",
        [parsedEscrow.dealId],
      );
      if (prior.rows[0] && prior.rows[0].immutable_binding_hash !== bindingHash) throw conflict("The escrow immutable binding changed.");
      await client.query(
        `INSERT INTO algorand_executor_escrows(deal_id, immutable_binding_hash, binding, projection)
         VALUES ($1, $2, $3::jsonb, $4::jsonb)
         ON CONFLICT (deal_id) DO UPDATE SET projection = EXCLUDED.projection, updated_at = clock_timestamp()
         WHERE algorand_executor_escrows.immutable_binding_hash = EXCLUDED.immutable_binding_hash`,
        [parsedEscrow.dealId, bindingHash, JSON.stringify(binding), JSON.stringify(parsedEscrow)],
      );
      const result = await client.query<DatabaseRow>(
        `UPDATE algorand_executor_commands SET status = 'SUCCEEDED', response = $2::jsonb,
           confirmed_round = $3::numeric, updated_at = clock_timestamp()
         WHERE idempotency_key = $1 AND status IN ('PREPARED', 'SUCCEEDED')
         RETURNING idempotency_key, deal_id, action, command_hash, permit_jti, permit_claims, status, prepared, response, transaction_id, confirmed_round::text, abandonment_round::text, cancellation_time`,
        [key, JSON.stringify(response), confirmedRound],
      );
      if (!result.rows[0]) throw conflict("The command is not prepared.");
      await client.query("COMMIT");
      return fromRow(result.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getEscrow(dealId: string): Promise<Escrow | null> {
    const result = await this.#pool.query<{ projection: unknown }>(
      "SELECT projection FROM algorand_executor_escrows WHERE deal_id = $1",
      [dealId],
    );
    return result.rows[0] ? escrowSchema.parse(result.rows[0].projection) : null;
  }

  async close(): Promise<void> {
    await Promise.all([this.#pool.end(), this.#lockPool.end()]);
  }
}
