import { readFile } from "node:fs/promises";

import pg from "pg";
import { describe, expect, it } from "vitest";

import { PostgresExecutorStore, type PreparedTransaction } from "../src/store.js";
import type { PermitClaims, ReleaseInput } from "../src/types.js";
import { releaseInput, testConfig } from "./helpers.js";

const databaseUrl = process.env.ALGORAND_EXECUTOR_TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres("executor PostgreSQL recovery migrations", () => {
  it("recovers both signed PREPARED and expired unsigned PENDING generations without key reuse", async () => {
    const config = testConfig({
      DATABASE_URL: databaseUrl!,
      DATABASE_SSL_MODE: "disable",
      DATABASE_AUTO_MIGRATE: "false",
    });
    const database = new pg.Pool({ connectionString: databaseUrl!, ssl: false, max: 2 });
    let store: PostgresExecutorStore | undefined;
    try {
      const existing = await database.query<{ commands: string | null }>(
        "SELECT to_regclass('algorand_executor_commands')::text AS commands",
      );
      if (existing.rows[0]?.commands !== null) {
        throw new Error("The executor recovery integration test requires an empty dedicated database.");
      }

      const migrations = new URL("../migrations/", import.meta.url);
      const baseline = await readFile(new URL("001_executor.sql", migrations), "utf8");
      const serialization = await readFile(new URL("002_deal_serialization.sql", migrations), "utf8");
      const recovery = await readFile(new URL("003_prepared_recovery.sql", migrations), "utf8");
      const pendingRecovery = await readFile(new URL("004_pending_recovery.sql", migrations), "utf8");
      const commandBinding = await readFile(new URL("005_signed_command_binding.sql", migrations), "utf8");
      await database.query(baseline);

      const dealId = "DEAL-PG-PREPARED-RECOVERY";
      const milestoneId = "MS-PG-PREPARED-RECOVERY";
      const intentId = "INTENT-PG-PREPARED-RECOVERY";
      const commandKeyN = "PAY-ALGORAND-PG-RECOVERY-N";
      const commandKeyNPlusOne = "PAY-ALGORAND-PG-RECOVERY-N-PLUS-ONE";
      const commandHashN = `sha256:${"a".repeat(64)}`;
      const commandHashNPlusOne = `sha256:${"b".repeat(64)}`;
      const preparedN: PreparedTransaction = {
        schemaVersion: "2.0",
        commandHash: commandHashN,
        commandBindingHash: `sha256:${"9".repeat(64)}`,
        transactionId: "A".repeat(52),
        transactionIds: ["A".repeat(52)],
        signedTransactionsBase64: ["QUJDRA=="],
        lastValidRound: "100",
      };
      const buildRelease = (
        generation: number,
        key: string,
        targetDealId = dealId,
        leaseExpiresAt = "2030-01-01T00:00:00.000Z",
      ): ReleaseInput => releaseInput({
        escrowBinding: {
          dealId: targetDealId,
          agreementHash: `sha256:${"c".repeat(64)}`,
          originProviderAddress: config.ALGORAND_ORIGIN_PROVIDER_TREASURY_ADDRESS,
          destinationProviderAddress: config.ALGORAND_SIGNER_ADDRESS,
          assetId: Number(config.ALGORAND_ASSET_ID),
          amount: { amountMinor: "5000", currency: "USD", scale: 2 },
          network: config.ALGORAND_NETWORK,
          genesisHash: config.ALGORAND_GENESIS_HASH,
          applicationId: config.ALGORAND_APPLICATION_ID.toString(),
        },
        milestoneId,
        amountMinor: "5000",
        intentId,
        bindingHash: `sha256:${"d".repeat(64)}`,
        fenceGeneration: generation,
        leaseExpiresAt,
        fabricClaimTransactionId: `FABRIC-PG-CLAIM-${generation}`,
        idempotencyKey: key,
      });
      const permit = (
        key: string,
        hash: string,
        generation: number,
        targetDealId = dealId,
        leaseExpiresAt = "2030-01-01T00:00:00.000Z",
      ): PermitClaims => ({
        iss: "test-fabric-gateway",
        aud: "test-algorand-executor",
        sub: "optiwork-payments",
        jti: `PERMIT-${key}`,
        iat: 1_700_000_000,
        exp: 1_700_000_060,
        schemaVersion: "1.0",
        action: "release",
        method: "POST",
        path: `/escrows/${targetDealId}/releases`,
        idempotencyKey: key,
        commandHash: hash,
        fabricTransactionId: `FABRIC-PERMIT-${generation}`,
        authoritativeReads: [{
          path: `/ledger/deals/${targetDealId}/milestones/${milestoneId}/payment-intents/${intentId}`,
          dataHash: `sha256:${"1".repeat(64)}`,
        }],
        releaseAuthorization: buildRelease(generation, key, targetDealId, leaseExpiresAt),
      });

      await database.query(
        `INSERT INTO algorand_executor_commands
           (idempotency_key, action, command_hash, permit_jti, permit_claims, status, prepared, transaction_id)
         VALUES ($1, 'release', $2, $3, $4::jsonb, 'PREPARED', $5::jsonb, $6)`,
        [
          commandKeyN,
          commandHashN,
          permit(commandKeyN, commandHashN, 1).jti,
          JSON.stringify(permit(commandKeyN, commandHashN, 1)),
          JSON.stringify(preparedN),
          preparedN.transactionId,
        ],
      );
      await database.query(serialization);
      await database.query(recovery);
      await database.query(pendingRecovery);
      await database.query(commandBinding);

      store = new PostgresExecutorStore(config);
      await store.initialize();
      await expect(store.getCommand(commandKeyN)).resolves.toMatchObject({
        dealId,
        status: "PREPARED",
        prepared: preparedN,
      });
      await expect(store.abandon(commandKeyN, "99"))
        .rejects.toThrow(/still within its valid round window/iu);
      await expect(store.getCommand(commandKeyN)).resolves.toMatchObject({ status: "PREPARED" });

      await expect(store.abandon(commandKeyN, "100")).resolves.toMatchObject({
        dealId,
        status: "ABANDONED",
        abandonmentRound: "100",
      });
      await expect(store.beginCommand(
        dealId,
        "release",
        commandKeyNPlusOne,
        commandHashNPlusOne,
        permit(commandKeyNPlusOne, commandHashNPlusOne, 2),
      )).resolves.toMatchObject({
        dealId,
        idempotencyKey: commandKeyNPlusOne,
        status: "PENDING",
      });
      await expect(store.beginCommand(
        dealId,
        "release",
        commandKeyN,
        commandHashNPlusOne,
        permit(commandKeyN, commandHashNPlusOne, 2),
      )).rejects.toThrow(/already bound to another command/iu);

      const pendingDealId = "DEAL-PG-PENDING-RECOVERY";
      const pendingKeyN = "PAY-ALGORAND-PG-PENDING-N";
      const pendingKeyNPlusOne = "PAY-ALGORAND-PG-PENDING-N-PLUS-ONE";
      const expiredLease = "2020-01-01T00:00:00.000Z";
      await expect(store.beginCommand(
        pendingDealId,
        "release",
        pendingKeyN,
        commandHashN,
        permit(pendingKeyN, commandHashN, 1, pendingDealId, expiredLease),
      )).resolves.toMatchObject({ status: "PENDING" });
      const [cancelled, cancelledReplay] = await Promise.all([
        store.cancelPending(pendingKeyN),
        store.cancelPending(pendingKeyN),
      ]);
      expect(cancelled).toMatchObject({
        dealId: pendingDealId,
        status: "CANCELLED",
        cancellationTime: expect.any(String),
      });
      expect(cancelledReplay).toEqual(cancelled);
      await expect(store.markPrepared(pendingKeyN, {
        schemaVersion: "2.0",
        commandHash: commandHashN,
        commandBindingHash: `sha256:${"8".repeat(64)}`,
        transactionId: "B".repeat(52),
        transactionIds: ["B".repeat(52)],
        signedTransactionsBase64: ["QUJDRA=="],
        lastValidRound: "101",
      })).rejects.toThrow(/expired unsigned command|different signed transactions/iu);
      await expect(store.beginCommand(
        pendingDealId,
        "release",
        pendingKeyNPlusOne,
        commandHashNPlusOne,
        permit(pendingKeyNPlusOne, commandHashNPlusOne, 2, pendingDealId),
      )).resolves.toMatchObject({ status: "PENDING" });
      await expect(store.cancelPending(pendingKeyNPlusOne)).resolves.toBeNull();
      await expect(store.getCommand(pendingKeyNPlusOne)).resolves.toMatchObject({ status: "PENDING" });
      await expect(store.beginCommand(
        pendingDealId,
        "release",
        pendingKeyN,
        commandHashNPlusOne,
        permit(pendingKeyN, commandHashNPlusOne, 2, pendingDealId),
      )).rejects.toThrow(/already bound to another command/iu);

      // The migration is deliberately rerunnable for local auto-migration.
      // Reapplying 003 through 005 must preserve all terminal and active rows.
      await database.query(recovery);
      await database.query(pendingRecovery);
      await database.query(commandBinding);
      await expect(store.getCommand(commandKeyN)).resolves.toMatchObject({ status: "ABANDONED" });
      await expect(store.getCommand(commandKeyNPlusOne)).resolves.toMatchObject({ status: "PENDING" });
      await expect(store.getCommand(pendingKeyN)).resolves.toMatchObject({ status: "CANCELLED" });
      await expect(store.getCommand(pendingKeyNPlusOne)).resolves.toMatchObject({ status: "PENDING" });
    } finally {
      await store?.close();
      await database.end();
    }
  }, 30_000);
});
