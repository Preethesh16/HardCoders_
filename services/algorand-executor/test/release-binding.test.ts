import algosdk from "algosdk";
import { describe, expect, it } from "vitest";

import { preparedCommandBinding, type AlgorandChain, type OnChainReleaseEvidence, type PrepareInput, type PreparedTransactionReconciliation } from "../src/chain.js";
import { MockFabricEvidenceReader, workEvidenceHash } from "../src/security/fabric-evidence-reader.js";
import { ExecutorService } from "../src/service.js";
import { MemoryExecutorStore, type PreparedTransaction } from "../src/store.js";
import {
  escrowBindingCommitment,
  releaseBindingCommitment,
  releaseInputSchema,
  type CommandContext,
  type Escrow,
  type PermitClaims,
  type ReleaseInput,
} from "../src/types.js";
import { approvedEvidence, releaseInput, testConfig } from "./helpers.js";

class RecordingChain implements AlgorandChain {
  prepareCalls: PrepareInput[] = [];

  async prepare(input: PrepareInput): Promise<PreparedTransaction> {
    this.prepareCalls.push(structuredClone(input));
    const transactionId = String.fromCharCode(65 + this.prepareCalls.length).repeat(52);
    return {
      schemaVersion: "2.0",
      commandHash: input.commandHash,
      commandBindingHash: preparedCommandBinding(input),
      transactionId,
      transactionIds: [transactionId],
      signedTransactionsBase64: ["AA=="],
      lastValidRound: "100",
    };
  }
  async reconcile(prepared: PreparedTransaction): Promise<PreparedTransactionReconciliation> {
    return { status: "PENDING", observedRound: (BigInt(prepared.lastValidRound) - 1n).toString() };
  }
  async submit() { return { confirmedRound: "101" }; }
  async assertProjection() {}
  async getReleaseEvidence(): Promise<OnChainReleaseEvidence> {
    throw new Error("not used");
  }
  async readiness() { return true; }
}

const DEAL = "DEAL-EVIDENCE";
const MILESTONE = "MS-EVIDENCE";
const FABRIC_TX = "FABRIC-EVIDENCE-APPROVAL";

async function fixture() {
  const config = testConfig();
  const store = new MemoryExecutorStore();
  const chain = new RecordingChain();
  const evidence = new MockFabricEvidenceReader();
  let currentClaims!: PermitClaims;
  const service = new ExecutorService(
    config,
    store,
    { verify: async () => currentClaims },
    { verifyCurrent: async () => undefined },
    chain,
    evidence,
  );
  const { commandHash } = await import("../src/types.js");
  const claims = (command: CommandContext, release?: ReleaseInput): PermitClaims => {
    const seconds = Math.floor(Date.now() / 1_000);
    const base = {
      iss: "test-fabric-gateway", aud: "test-algorand-executor", sub: "optiwork-payments" as const,
      jti: `permit-${command.idempotencyKey}`, iat: seconds, exp: seconds + 20,
      schemaVersion: "1.0" as const, method: "POST" as const, path: command.path,
      idempotencyKey: command.idempotencyKey, commandHash: commandHash(command),
      fabricTransactionId: release?.fabricClaimTransactionId ?? `FABRIC-${command.idempotencyKey}`,
      authoritativeReads: [{ path: `/ledger/deals/${DEAL}/algorand-authorization`, dataHash: `sha256:${"a".repeat(64)}` }],
    };
    return release
      ? { ...base, action: "release" as const, releaseAuthorization: release } as PermitClaims
      : { ...base, action: command.action } as PermitClaims;
  };
  const run = async (command: CommandContext, release?: ReleaseInput) => {
    currentClaims = claims(command, release);
    return service.mutate(command, "signed-permit-placeholder");
  };
  await run({
    action: "create", method: "POST", path: "/escrows", idempotencyKey: "EV-CREATE",
    body: {
      dealId: DEAL, agreementHash: `sha256:${"c".repeat(64)}`,
      originProviderAddress: config.ALGORAND_ORIGIN_PROVIDER_TREASURY_ADDRESS,
      destinationProviderAddress: config.ALGORAND_SIGNER_ADDRESS,
      assetId: Number(config.ALGORAND_ASSET_ID),
      amount: { amountMinor: "100", currency: "USD", scale: 2 },
    },
  });
  await run({ action: "fund", method: "POST", path: `/escrows/${DEAL}/fund`, idempotencyKey: "EV-FUND", body: null });
  const escrow: Escrow = await service.getEscrow(DEAL);
  const escrowBinding = {
    dealId: escrow.dealId, agreementHash: escrow.agreementHash,
    originProviderAddress: escrow.originProviderAddress,
    destinationProviderAddress: escrow.destinationProviderAddress,
    assetId: escrow.assetId, amount: escrow.amount, network: escrow.network,
    genesisHash: escrow.genesisHash, applicationId: escrow.applicationId,
  };
  return { config, service, chain, evidence, escrowBinding, run };
}

function release(
  escrowBinding: ReleaseInput["escrowBinding"],
  idempotencyKey: string,
  hash: string,
  amountMinor = "100",
  milestoneId = MILESTONE,
): { input: ReleaseInput; command: CommandContext } {
  const input = releaseInput({
    evidenceId: `EVIDENCE-${FABRIC_TX}`,
    escrowBinding,
    milestoneId,
    amountMinor,
    intentId: `INTENT-${idempotencyKey}`,
    bindingHash: `sha256:${"d".repeat(64)}`,
    fenceGeneration: 1,
    leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
    fabricClaimTransactionId: FABRIC_TX,
    idempotencyKey,
    workEvidenceHash: hash,
  });
  return {
    input,
    command: {
      action: "release", method: "POST", path: `/escrows/${DEAL}/releases`,
      idempotencyKey, body: input,
    },
  };
}

describe("release authorization binding", () => {
  it("commits the escrow, work evidence, Fabric claim, compliance, quote, generation, key and expiry", () => {
    const binding = {
      dealId: DEAL, agreementHash: `sha256:${"c".repeat(64)}`,
      originProviderAddress: algosdk.generateAccount().addr.toString(),
      destinationProviderAddress: algosdk.generateAccount().addr.toString(),
      assetId: 1, amount: { amountMinor: "1", currency: "USD", scale: 2 },
      network: "localnet" as const, genesisHash: "x".repeat(24), applicationId: "1",
    };
    const parsed = releaseInputSchema.safeParse({
      evidenceId: "EVIDENCE-TEST-001",
      escrowBinding: binding,
      milestoneId: MILESTONE, amountMinor: "1", intentId: "INTENT-1",
      bindingHash: `sha256:${"d".repeat(64)}`, fenceGeneration: 1,
      leaseExpiresAt: "2030-01-01T00:00:00.000Z",
      authorizationCommitment: `sha256:${"9".repeat(64)}`,
      fabricClaimTransactionId: FABRIC_TX,
      releaseBinding: {
        escrowBindingHash: `sha256:${"0".repeat(64)}`,
        workEvidenceHash: `sha256:${"1".repeat(64)}`,
        fabricTxHash: `sha256:${"2".repeat(64)}`,
        complianceResultHash: `sha256:${"3".repeat(64)}`,
        fxQuoteHash: `sha256:${"4".repeat(64)}`,
        generation: 1,
        idempotencyKey: "KEY-1",
        expiresAt: "2030-01-01T00:00:00.000Z",
      },
    });
    expect(parsed.success).toBe(false);
    const messages = parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
    expect(messages).toEqual(expect.arrayContaining([
      expect.stringMatching(/escrowBindingHash must commit/u),
      expect.stringMatching(/fabricTxHash must commit/u),
      expect.stringMatching(/authorizationCommitment must be the canonical hash/u),
    ]));
  });

  it("makes the on-chain authorization commitment the canonical release-binding hash", () => {
    const escrowBinding = {
      dealId: DEAL, agreementHash: `sha256:${"c".repeat(64)}`,
      originProviderAddress: algosdk.generateAccount().addr.toString(),
      destinationProviderAddress: algosdk.generateAccount().addr.toString(),
      assetId: 1, amount: { amountMinor: "1", currency: "USD", scale: 2 },
      network: "localnet" as const, genesisHash: "x".repeat(24), applicationId: "1",
    };
    const input = releaseInput({
      escrowBinding, milestoneId: MILESTONE, amountMinor: "1", intentId: "INTENT-1",
      bindingHash: `sha256:${"d".repeat(64)}`, fenceGeneration: 3,
      leaseExpiresAt: "2030-01-01T00:00:00.000Z",
      fabricClaimTransactionId: FABRIC_TX,
      idempotencyKey: "KEY-1",
    });
    expect(input.releaseBinding.escrowBindingHash).toBe(escrowBindingCommitment(escrowBinding));
    expect(input.releaseBinding.generation).toBe(3);
    expect(input.releaseBinding.idempotencyKey).toBe("KEY-1");
    expect(input.releaseBinding.expiresAt).toBe(input.leaseExpiresAt);
    expect(input.authorizationCommitment).toBe(releaseBindingCommitment(input.releaseBinding));
  });
});

describe("approved Fabric evidence re-read", () => {
  it("re-reads approved evidence before signing and releases once", async () => {
    const { service, chain, evidence, escrowBinding, run } = await fixture();
    const record = approvedEvidence(FABRIC_TX);
    evidence.set(DEAL, MILESTONE, record);
    const { input, command } = release(escrowBinding, "EV-RELEASE", workEvidenceHash(record));

    const result = await run(command, input) as { escrow: Escrow; replay: boolean };
    expect(evidence.reads).toBe(1);
    expect(result.escrow).toMatchObject({ state: "COMPLETED", releasedMinor: "100" });
    expect(chain.prepareCalls.filter(({ action }) => action === "release")).toHaveLength(1);

    // An exact replay must never sign or re-read a second time.
    const replay = await run(command, input) as { replay: boolean };
    expect(replay.replay).toBe(true);
    expect(evidence.reads).toBe(1);
    expect(chain.prepareCalls.filter(({ action }) => action === "release")).toHaveLength(1);
  });

  it("refuses a second release of the same milestone", async () => {
    const { evidence, escrowBinding, run } = await fixture();
    const record = approvedEvidence(FABRIC_TX);
    evidence.set(DEAL, MILESTONE, record);
    const first = release(escrowBinding, "EV-REL-1", workEvidenceHash(record), "60");
    await run(first.command, first.input);
    const second = release(escrowBinding, "EV-REL-2", workEvidenceHash(record), "40");
    await expect(run(second.command, second.input)).rejects.toThrow(/already released/u);
  });

  it("refuses a release when the approved Fabric evidence changed after signing", async () => {
    const { chain, evidence, escrowBinding, run } = await fixture();
    const record = approvedEvidence(FABRIC_TX);
    evidence.set(DEAL, MILESTONE, record);
    const { input, command } = release(escrowBinding, "EV-CHANGED", workEvidenceHash(record));
    evidence.revise(DEAL, MILESTONE, { version: 2, fileHash: `sha256:${"9".repeat(64)}` });
    await expect(run(command, input)).rejects.toThrow(/changed after the release permit was signed/u);
    expect(chain.prepareCalls.filter(({ action }) => action === "release")).toHaveLength(0);
  });

  it("refuses a release when the buyer decision is not an approval", async () => {
    const { chain, evidence, escrowBinding, run } = await fixture();
    const record = approvedEvidence(FABRIC_TX, {
      buyerDecision: "REVISION_REQUIRED",
      buyerDecisionHash: undefined,
    });
    evidence.set(DEAL, MILESTONE, record);
    const { input, command } = release(escrowBinding, "EV-UNAPPROVED", workEvidenceHash(record));
    await expect(run(command, input)).rejects.toThrow(/confirmed buyer approval/u);
    expect(chain.prepareCalls.filter(({ action }) => action === "release")).toHaveLength(0);
  });

  it("refuses a release when Fabric holds no evidence for the milestone", async () => {
    const { escrowBinding, run } = await fixture();
    const { input, command } = release(escrowBinding, "EV-MISSING", `sha256:${"7".repeat(64)}`);
    await expect(run(command, input)).rejects.toThrow(/No Fabric work evidence/u);
  });

  it("refuses evidence whose Fabric approval transaction differs from the permit", async () => {
    const { evidence, escrowBinding, run } = await fixture();
    const record = approvedEvidence(FABRIC_TX);
    evidence.set(DEAL, MILESTONE, record);
    const hash = workEvidenceHash(record);
    evidence.revise(DEAL, MILESTONE, { fabricTxId: "FABRIC-OTHER-APPROVAL" });
    const { input, command } = release(escrowBinding, "EV-TX", hash);
    await expect(run(command, input)).rejects.toThrow(/changed after the release permit was signed/u);
  });

  it("keeps the escrow releasable after a rejected release attempt", async () => {
    const { service, evidence, escrowBinding, run } = await fixture();
    const record = approvedEvidence(FABRIC_TX);
    evidence.set(DEAL, MILESTONE, record);
    const stale = release(escrowBinding, "EV-STALE", `sha256:${"6".repeat(64)}`);
    await expect(run(stale.command, stale.input)).rejects.toThrow();
    await expect(service.getEscrow(DEAL)).resolves.toMatchObject({ state: "FUNDED", lockedMinor: "100" });
  });
});
