import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import algosdk from "algosdk";
import { describe, expect, it } from "vitest";

import {
  FileFabricEvidenceReader,
  MockFabricEvidenceReader,
  fabricTransactionHash,
  workEvidenceHash,
  workEvidenceSchema,
} from "../src/security/fabric-evidence-reader.js";
import { escrowExpectationSchema, releaseInputSchema } from "../src/types.js";
import { approvedEvidence, releaseInput } from "./helpers.js";

const DEAL = "DEAL-FIXTURE";
const MILESTONE = "MS-FIXTURE";
const FABRIC_TX = "FABRIC-FIXTURE-APPROVAL";

async function fixtureFile(body: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "optiwork-evidence-"));
  const path = join(directory, "evidence.json");
  await writeFile(path, JSON.stringify(body), "utf8");
  return path;
}

describe("file-backed Fabric evidence reader", () => {
  it("returns the approved version and rejects one that changed on disk", async () => {
    const record = approvedEvidence(FABRIC_TX);
    const key = MockFabricEvidenceReader.key(DEAL, MILESTONE);
    const query = {
      dealId: DEAL,
      milestoneId: MILESTONE,
      workEvidenceHash: workEvidenceHash(record),
      fabricTxHash: fabricTransactionHash(FABRIC_TX),
    };
    const path = await fixtureFile({ schemaVersion: "1.0", evidence: { [key]: record } });
    const reader = new FileFabricEvidenceReader(path);
    await expect(reader.readApprovedEvidence(query)).resolves.toMatchObject({ buyerDecision: "APPROVED" });
    await expect(reader.readiness()).resolves.toBe(true);

    await writeFile(path, JSON.stringify({
      schemaVersion: "1.0",
      evidence: { [key]: { ...record, version: 2 } },
    }), "utf8");
    await expect(reader.readApprovedEvidence(query)).rejects.toThrow(/changed after the release permit was signed/u);
  });

  it("fails closed on an unknown milestone and on a malformed fixture", async () => {
    const record = approvedEvidence(FABRIC_TX);
    const query = {
      dealId: DEAL,
      milestoneId: MILESTONE,
      workEvidenceHash: workEvidenceHash(record),
      fabricTxHash: fabricTransactionHash(FABRIC_TX),
    };
    const empty = new FileFabricEvidenceReader(await fixtureFile({ schemaVersion: "1.0", evidence: {} }));
    await expect(empty.readApprovedEvidence(query)).rejects.toThrow(/No Fabric work evidence/u);

    const malformed = new FileFabricEvidenceReader(await fixtureFile({ schemaVersion: "2.0", evidence: {} }));
    await expect(malformed.readApprovedEvidence(query)).rejects.toThrow(/fixture contract is invalid/u);

    const missing = new FileFabricEvidenceReader("/nonexistent/optiwork/evidence.json");
    await expect(missing.readApprovedEvidence(query)).rejects.toThrow(/fixture is unavailable/u);
    await expect(missing.readiness()).resolves.toBe(false);
  });
});

describe("ledger payloads carry no personal data", () => {
  it("rejects any field the ledger contract does not define", () => {
    const personal = { fullName: "A Person", email: "person@example.invalid", addressLine1: "1 Street" };

    expect(workEvidenceSchema.safeParse({ ...approvedEvidence(FABRIC_TX), ...personal }).success).toBe(false);

    const escrow = {
      dealId: DEAL,
      agreementHash: `sha256:${"a".repeat(64)}`,
      originProviderAddress: algosdk.generateAccount().addr.toString(),
      destinationProviderAddress: algosdk.generateAccount().addr.toString(),
      assetId: 1,
      amount: { amountMinor: "100", currency: "USD", scale: 6 },
    };
    expect(escrowExpectationSchema.safeParse(escrow).success).toBe(true);
    expect(escrowExpectationSchema.safeParse({ ...escrow, ...personal }).success).toBe(false);

    const release = releaseInput({
      escrowBinding: {
        ...escrow,
        network: "localnet",
        genesisHash: "x".repeat(24),
        applicationId: "1",
      },
      milestoneId: MILESTONE,
      amountMinor: "100",
      intentId: "INTENT-1",
      bindingHash: `sha256:${"d".repeat(64)}`,
      fenceGeneration: 1,
      leaseExpiresAt: "2030-01-01T00:00:00.000Z",
      fabricClaimTransactionId: FABRIC_TX,
      idempotencyKey: "KEY-1",
    });
    expect(releaseInputSchema.safeParse({ ...release, ...personal }).success).toBe(false);

    // Every value that reaches a ledger payload is a digest, an opaque
    // identifier, an Algorand address, an integer amount or a timestamp.
    const serialized = JSON.stringify(release);
    for (const value of Object.values(personal)) expect(serialized).not.toContain(value);
  });
});
