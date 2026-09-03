import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

describe("executor database migration compatibility", () => {
  it("keeps 001 immutable and adds fail-closed recovery and signed-command migrations", async () => {
    const migrations = new URL("../migrations/", import.meta.url);
    const baseline = await readFile(fileURLToPath(new URL("001_executor.sql", migrations)), "utf8");
    const upgrade = await readFile(fileURLToPath(new URL("002_deal_serialization.sql", migrations)), "utf8");
    const recovery = await readFile(fileURLToPath(new URL("003_prepared_recovery.sql", migrations)), "utf8");
    const pendingRecovery = await readFile(fileURLToPath(new URL("004_pending_recovery.sql", migrations)), "utf8");
    const commandBinding = await readFile(fileURLToPath(new URL("005_signed_command_binding.sql", migrations)), "utf8");

    const commandTable = baseline.split("CREATE TABLE IF NOT EXISTS algorand_executor_permits")[0] ?? baseline;
    expect(commandTable).not.toMatch(/\bdeal_id\s+varchar\(128\)/u);
    expect(baseline).not.toContain("algorand_executor_one_active_command_per_deal_idx");
    expect(upgrade).toContain("ADD COLUMN IF NOT EXISTS deal_id");
    expect(upgrade).toContain("Cannot safely derive deal_id");
    expect(upgrade).toContain("ALTER COLUMN deal_id SET NOT NULL");
    expect(upgrade).toContain("algorand_executor_commands_transaction_idx");
    expect(upgrade).toContain("algorand_executor_one_active_command_per_deal_idx");
    expect(recovery).toContain("ABANDONED");
    expect(recovery).toContain("abandonment_round");
    expect(recovery).toContain("lastValidRound");
    expect(recovery).not.toContain("DROP TABLE");
    expect(pendingRecovery).toContain("CANCELLED");
    expect(pendingRecovery).toContain("cancellation_time");
    expect(pendingRecovery).toContain("releaseAuthorization,leaseExpiresAt");
    expect(pendingRecovery).not.toContain("DROP TABLE");
    expect(commandBinding).toContain("schemaVersion");
    expect(commandBinding).toContain("commandBindingHash");
    expect(commandBinding).toContain("transactionIds");
    expect(commandBinding).toContain("prepared ->> 'commandHash' = command_hash");
    expect(commandBinding).not.toContain("DROP TABLE");
  });
});
