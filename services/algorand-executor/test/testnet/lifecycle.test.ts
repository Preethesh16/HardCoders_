/**
 * Public Algorand **TestNet** escrow lifecycle verification.
 *
 * Opt-in. It runs only when `OPTIWORK_TESTNET_E2E=1` and a deployment manifest
 * plus disposable account file are present, so the default suite stays offline
 * and deterministic and the LocalNet regression is never displaced.
 *
 * Every value moved here is a dummy TestAlgo or a zero-value demonstration
 * asset. MainNet is unreachable: the pinned genesis guard in `config.ts` refuses
 * it, and this suite additionally asserts the observed genesis identity.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import algosdk from "algosdk";
import { describe, expect, it } from "vitest";

import { sha256Text } from "../../src/canonical.js";
import { RealAlgorandChain } from "../../src/chain.js";
import { loadConfig, type ExecutorConfig } from "../../src/config.js";
import { ALGORAND_TESTNET_GENESIS_HASH, ALGORAND_TESTNET_GENESIS_ID } from "../../src/networks.js";
import { Ed25519FabricPermitVerifier } from "../../src/security/permit.js";
import { ExecutorService } from "../../src/service.js";
import { MemoryExecutorStore } from "../../src/store.js";
import { DEFAULT_TESTNET_ACCOUNTS_PATH, DEFAULT_TESTNET_MANIFEST_PATH } from "../../src/testnet-constants.js";
import { readAccountFile } from "../../src/testnet-accounts.js";
import type { CommandContext, Escrow, ReleaseInput } from "../../src/types.js";
import {
  RecordingFabricReader,
  StrandNextSubmissionChain,
  binding,
  createPermitSigner,
  signedPermit,
} from "../support/permit-harness.js";

const ALGOD_URL = process.env.OPTIWORK_TESTNET_ALGOD_URL ?? "https://testnet-api.algonode.cloud";
const enabled = process.env.OPTIWORK_TESTNET_E2E === "1";
const packageRoot = new URL("../../", import.meta.url).pathname;

/**
 * Waits for the chain to pass a round. TestNet produces roughly one round every
 * three seconds, so this is a bounded poll, never an arbitrary sleep.
 */
async function waitForRound(algod: algosdk.Algodv2, target: bigint, budgetMs = 180_000): Promise<bigint> {
  const deadline = Date.now() + budgetMs;
  let last = BigInt((await algod.status().do()).lastRound);
  while (last < target) {
    if (Date.now() > deadline) {
      throw new Error(`TestNet did not reach round ${target} within ${budgetMs} ms (last observed ${last}).`);
    }
    await algod.statusAfterBlock(Number(last)).do();
    last = BigInt((await algod.status().do()).lastRound);
  }
  return last;
}

describe.skipIf(!enabled)("public Algorand TestNet escrow", () => {
  it("confirms the full lifecycle, replay safety, fence enforcement, and recovery on public TestNet", async () => {
    const manifestPath = resolve(packageRoot, process.env.OPTIWORK_TESTNET_MANIFEST_PATH ?? DEFAULT_TESTNET_MANIFEST_PATH);
    const accountsPath = resolve(packageRoot, process.env.OPTIWORK_TESTNET_ACCOUNTS_PATH ?? DEFAULT_TESTNET_ACCOUNTS_PATH);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      network: string;
      genesisHash: string;
      applicationId: string;
      assetId: string;
      applicationAddress: string;
    };
    const accounts = await readAccountFile(accountsPath);

    // The deployment must be the pinned public TestNet, never another chain.
    expect(manifest.network).toBe("testnet");
    expect(manifest.genesisHash).toBe(ALGORAND_TESTNET_GENESIS_HASH);

    const algod = new algosdk.Algodv2("", new URL(ALGOD_URL).origin, "");
    const params = await algod.getTransactionParams().do();
    expect(Buffer.from(params.genesisHash ?? []).toString("base64")).toBe(ALGORAND_TESTNET_GENESIS_HASH);
    expect(params.genesisID).toBe(ALGORAND_TESTNET_GENESIS_ID);

    const seller = accounts.sellers["ORG-SELL-001"];
    const assetId = BigInt(manifest.assetId);
    const appAddress = algosdk.Address.fromString(manifest.applicationAddress);

    const signer = await createPermitSigner("testnet-fabric-permit-key", "testnet-fabric-gateway", "testnet-algorand-executor");
    const config: ExecutorConfig = loadConfig({
      HOST: "127.0.0.1",
      PORT: "4301",
      LOG_LEVEL: "silent",
      EXECUTOR_BEARER_TOKEN: "testnet-executor-transport-token-acceptance-0001",
      DATABASE_URL: "postgresql://unused:unused@127.0.0.1:5432/unused",
      DATABASE_SSL_MODE: "disable",
      DATABASE_AUTO_MIGRATE: "false",
      DATABASE_DEAL_LOCK_TIMEOUT_MS: "120000",
      // Loaded as a genuine TestNet configuration, so the escrow binding records
      // network `testnet` and the pinned-genesis guard applies. That forces
      // HTTPS Gateway OIDC credentials, which are supplied here even though the
      // authoritative reader itself is stubbed and issues no Gateway request.
      FABRIC_GATEWAY_URL: "https://gateway.anchor.invalid",
      FABRIC_GATEWAY_OIDC_TOKEN_URL: "https://identity.anchor.invalid/realms/anchor/protocol/openid-connect/token",
      FABRIC_GATEWAY_OIDC_CLIENT_ID: "anchor-algorand-executor",
      FABRIC_GATEWAY_OIDC_CLIENT_SECRET: process.env.OPTIWORK_TESTNET_GATEWAY_CLIENT_SECRET
        ?? "unused-stubbed-reader-secret-0000000001",
      FABRIC_GATEWAY_TIMEOUT_MS: "3000",
      FABRIC_PERMIT_ISSUER: signer.issuer,
      FABRIC_PERMIT_AUDIENCE: signer.audience,
      FABRIC_PERMIT_PUBLIC_JWK_JSON: JSON.stringify(signer.publicJwk),
      FABRIC_PERMIT_MAX_AGE_SECONDS: "60",
      ALGORAND_RELEASE_SAFETY_MARGIN_SECONDS: "30",
      ALGORAND_NETWORK: "testnet",
      ALGORAND_ALGOD_URL: ALGOD_URL,
      ALGORAND_ALGOD_TOKEN: "",
      ALGORAND_INDEXER_URL: process.env.OPTIWORK_TESTNET_INDEXER_URL ?? "https://testnet-idx.algonode.cloud",
      // Public TestNet occasionally holds an algod request beyond 30 seconds
      // while a transaction is entering the next round. Keep the request
      // bounded, but use the executor's validated 120-second ceiling for this
      // opt-in public-network gate. Operators can lower it explicitly when
      // diagnosing a faster endpoint.
      ALGORAND_REQUEST_TIMEOUT_MS: process.env.OPTIWORK_TESTNET_REQUEST_TIMEOUT_MS ?? "120000",
      // Algorand rounds are final when certified; this public demo still waits
      // for two additional rounds so the confirmation-depth path is exercised
      // without turning every lifecycle transition into a minute-long wait.
      // Operators can raise the depth for a release-candidate endurance run.
      ALGORAND_CONFIRMATION_ROUNDS: process.env.OPTIWORK_TESTNET_CONFIRMATION_ROUNDS ?? "3",
      ALGORAND_GENESIS_HASH: ALGORAND_TESTNET_GENESIS_HASH,
      ALGORAND_APPLICATION_ID: manifest.applicationId,
      ALGORAND_ASSET_ID: manifest.assetId,
      ALGORAND_SIGNER_ADDRESS: accounts.deployer.address,
      ALGORAND_SIGNER_PRIVATE_KEY_BASE64: accounts.deployer.privateKeyBase64,
      ALGORAND_ORIGIN_PROVIDER_TREASURY_ADDRESS: accounts.originProviderTreasury.address,
      ALGORAND_ORIGIN_PROVIDER_TREASURY_PRIVATE_KEY_BASE64: accounts.originProviderTreasury.privateKeyBase64,
      ALGORAND_MAX_VALIDITY_ROUNDS: "100",
    });

    const reader = new RecordingFabricReader();
    const store = new MemoryExecutorStore();
    const service = new ExecutorService(
      config,
      store,
      new Ed25519FabricPermitVerifier(config),
      reader,
      new RealAlgorandChain(config),
    );
    await service.initialize();
    expect(await service.readiness()).toBe(true);

    const run = async (command: CommandContext, options?: { jti?: string }) =>
      service.mutate(command, (await signedPermit(command, reader, signer, options)).compact);

    const stamp = Date.now().toString(36).toUpperCase();
    const sellerBefore = await algod.accountAssetInformation(algosdk.Address.fromString(seller.address), assetId).do();
    const sellerStart = sellerBefore.assetHolding?.amount ?? 0n;

    // ---- Deal A: create, fund, pause, resume, release, complete -----------
    const dealA = `DEAL-TESTNET-RELEASE-${stamp}`;
    const createA: CommandContext = {
      action: "create",
      method: "POST",
      path: "/escrows",
      idempotencyKey: `TESTNET-CREATE-A-${stamp}`,
      body: {
        dealId: dealA,
        agreementHash: `sha256:${"1".repeat(64)}`,
        originProviderAddress: accounts.originProviderTreasury.address,
        destinationProviderAddress: seller.address,
        assetId: Number(assetId),
        amount: { amountMinor: "1000", currency: "USD", scale: 2 },
      },
    };

    // A permit bound to the original command must not authorize a swapped payee.
    const originalPermit = await signedPermit(createA, reader, signer);
    await expect(service.mutate(
      { ...createA, body: { ...(createA.body as Record<string, unknown>), destinationProviderAddress: accounts.deployer.address } },
      originalPermit.compact,
    )).rejects.toThrow(/permit|bind|invalid/iu);

    const createdA = await run(createA) as Escrow;
    expect(createdA).toMatchObject({ dealId: dealA, network: "testnet", genesisHash: ALGORAND_TESTNET_GENESIS_HASH });

    // Exact replay must not create a second transaction.
    const replayA = await service.mutate(createA, (await signedPermit(createA, reader, signer)).compact) as Escrow;
    expect(replayA.createTxId).toBe(createdA.createTxId);

    await run({ action: "fund", method: "POST", path: `/escrows/${dealA}/fund`, idempotencyKey: `TESTNET-FUND-A-${stamp}`, body: null });

    // A permit whose Fabric state moved after issuance must be refused.
    const stalePause: CommandContext = {
      action: "pause", method: "POST", path: `/escrows/${dealA}/pause`,
      idempotencyKey: `TESTNET-STALE-PAUSE-${stamp}`, body: null,
    };
    const stalePermit = await signedPermit(stalePause, reader, signer);
    reader.tamper(stalePermit.paths[0]!);
    await expect(service.mutate(stalePause, stalePermit.compact)).rejects.toThrow(/Fabric state changed/u);

    await run({ action: "pause", method: "POST", path: `/escrows/${dealA}/pause`, idempotencyKey: `TESTNET-PAUSE-A-${stamp}`, body: null });
    await run({ action: "resume", method: "POST", path: `/escrows/${dealA}/resume`, idempotencyKey: `TESTNET-RESUME-A-${stamp}`, body: null });

    const escrowA = await service.getEscrow(dealA);
    const releaseA: ReleaseInput = {
      escrowBinding: binding(escrowA),
      milestoneId: `MS-TESTNET-001-${stamp}`,
      amountMinor: "1000",
      intentId: `INTENT-TESTNET-001-${stamp}`,
      bindingHash: `sha256:${"2".repeat(64)}`,
      fenceGeneration: 1,
      leaseExpiresAt: new Date(Date.now() + 600_000).toISOString(),
      authorizationCommitment: `sha256:${"3".repeat(64)}`,
      fabricClaimTransactionId: `FABRIC-TESTNET-CLAIM-001-${stamp}`,
    };
    const releaseCommandA: CommandContext = {
      action: "release", method: "POST", path: `/escrows/${dealA}/releases`,
      idempotencyKey: `TESTNET-RELEASE-A-${stamp}`, body: releaseA,
    };
    const released = await run(releaseCommandA) as { escrow: Escrow; transactionId: string; replay: boolean };
    expect(released).toMatchObject({ replay: false, escrow: { state: "COMPLETED", lockedMinor: "0", releasedMinor: "1000" } });
    expect(released.transactionId).toMatch(/^[A-Z2-7]{52}$/u);

    // One payment intent must produce at most one confirmed TestNet payout.
    const releaseReplay = await service.mutate(
      releaseCommandA,
      (await signedPermit(releaseCommandA, reader, signer)).compact,
    ) as { transactionId: string; replay: boolean };
    expect(releaseReplay).toMatchObject({ transactionId: released.transactionId, replay: true });

    const evidence = await service.getReleaseEvidence(dealA, releaseA.milestoneId);
    expect(evidence).toMatchObject({
      transactionId: released.transactionId,
      amountMinor: "1000",
      bindingHash: releaseA.bindingHash,
      fenceGeneration: 1,
      authorizationCommitment: releaseA.authorizationCommitment,
      fabricClaimTransactionHash: sha256Text(releaseA.fabricClaimTransactionId),
    });
    expect(BigInt(evidence.confirmedRound)).toBeGreaterThan(0n);

    await run({ action: "complete", method: "POST", path: `/escrows/${dealA}/complete`, idempotencyKey: `TESTNET-COMPLETE-A-${stamp}`, body: null });

    // ---- Deal B: single-use permit JTI and the refund branch ---------------
    const dealB = `DEAL-TESTNET-REFUND-${stamp}`;
    await run({
      action: "create", method: "POST", path: "/escrows", idempotencyKey: `TESTNET-CREATE-B-${stamp}`,
      body: {
        dealId: dealB,
        agreementHash: `sha256:${"4".repeat(64)}`,
        originProviderAddress: accounts.originProviderTreasury.address,
        destinationProviderAddress: seller.address,
        assetId: Number(assetId),
        amount: { amountMinor: "700", currency: "USD", scale: 2 },
      },
    });
    await run({ action: "fund", method: "POST", path: `/escrows/${dealB}/fund`, idempotencyKey: `TESTNET-FUND-B-${stamp}`, body: null });

    const singleUseJti = `PERMIT-TESTNET-SINGLE-USE-${stamp}`;
    await run(
      { action: "pause", method: "POST", path: `/escrows/${dealB}/pause`, idempotencyKey: `TESTNET-PAUSE-B-${stamp}`, body: null },
      { jti: singleUseJti },
    );
    await expect(run(
      { action: "resume", method: "POST", path: `/escrows/${dealB}/resume`, idempotencyKey: `TESTNET-REUSED-JTI-${stamp}`, body: null },
      { jti: singleUseJti },
    )).rejects.toThrow(/already authorized another command/u);

    const refundCommand: CommandContext = {
      action: "refund", method: "POST", path: `/escrows/${dealB}/refund`,
      idempotencyKey: `TESTNET-REFUND-B-${stamp}`, body: null,
    };
    const refunded = await run(refundCommand) as { escrow: Escrow; transactionId: string; replay: boolean };
    expect(refunded).toMatchObject({ replay: false, escrow: { state: "REFUNDED", lockedMinor: "0", refundedMinor: "700" } });
    const refundReplay = await service.mutate(
      refundCommand,
      (await signedPermit(refundCommand, reader, signer)).compact,
    ) as { transactionId: string; replay: boolean };
    expect(refundReplay).toMatchObject({ transactionId: refunded.transactionId, replay: true });
    await run({ action: "complete", method: "POST", path: `/escrows/${dealB}/complete`, idempotencyKey: `TESTNET-COMPLETE-B-${stamp}`, body: null });

    // ---- Deal C: ambiguous submission recovery and restart recovery --------
    const dealC = `DEAL-TESTNET-RECOVERY-${stamp}`;
    await run({
      action: "create", method: "POST", path: "/escrows", idempotencyKey: `TESTNET-CREATE-C-${stamp}`,
      body: {
        dealId: dealC,
        agreementHash: `sha256:${"5".repeat(64)}`,
        originProviderAddress: accounts.originProviderTreasury.address,
        destinationProviderAddress: seller.address,
        assetId: Number(assetId),
        amount: { amountMinor: "500", currency: "USD", scale: 2 },
      },
    });
    await run({ action: "fund", method: "POST", path: `/escrows/${dealC}/fund`, idempotencyKey: `TESTNET-FUND-C-${stamp}`, body: null });

    // A short validity window lets the stranded transaction expire in a handful
    // of TestNet rounds instead of waiting on the default window.
    const shortValidity: ExecutorConfig = { ...config, ALGORAND_MAX_VALIDITY_ROUNDS: 6 };
    const strandChain = new StrandNextSubmissionChain(new RealAlgorandChain(shortValidity));
    // A fresh service over the same durable store is the restart boundary.
    const recovered = new ExecutorService(
      shortValidity,
      store,
      new Ed25519FabricPermitVerifier(shortValidity),
      reader,
      strandChain,
    );

    const escrowC = await recovered.getEscrow(dealC);
    expect(escrowC.state).toBe("FUNDED");

    const releaseN: ReleaseInput = {
      escrowBinding: binding(escrowC),
      milestoneId: `MS-TESTNET-RECOVERY-${stamp}`,
      amountMinor: "500",
      intentId: `INTENT-TESTNET-RECOVERY-${stamp}`,
      bindingHash: `sha256:${"6".repeat(64)}`,
      fenceGeneration: 1,
      leaseExpiresAt: new Date(Date.now() + 900_000).toISOString(),
      authorizationCommitment: `sha256:${"7".repeat(64)}`,
      fabricClaimTransactionId: `FABRIC-TESTNET-RECOVERY-N-${stamp}`,
    };
    const releaseCommandN: CommandContext = {
      action: "release", method: "POST", path: `/escrows/${dealC}/releases`,
      idempotencyKey: `TESTNET-RELEASE-RECOVERY-N-${stamp}`, body: releaseN,
    };
    await expect(recovered.mutate(
      releaseCommandN,
      (await signedPermit(releaseCommandN, reader, signer)).compact,
    )).rejects.toThrow(/intentionally stranded/iu);

    const preparedN = await store.getCommand(releaseCommandN.idempotencyKey);
    expect(preparedN).toMatchObject({ status: "PREPARED", transactionId: strandChain.stranded?.transactionId });
    const lastValidRound = BigInt(preparedN!.prepared!.lastValidRound);
    const observed = await waitForRound(algod, lastValidRound + 1n);
    expect(observed).toBeGreaterThan(lastValidRound);

    const expired = await recovered.reconcile(releaseCommandN);
    expect(expired).toMatchObject({ status: "EXPIRED", transactionId: preparedN!.prepared!.transactionId });
    expect(await store.getCommand(releaseCommandN.idempotencyKey)).toMatchObject({ status: "ABANDONED" });

    // The abandoned generation must never be resubmitted.
    const attemptsAfterExpiry = strandChain.submissionAttempts;
    await expect(recovered.mutate(
      releaseCommandN,
      (await signedPermit(releaseCommandN, reader, signer)).compact,
    )).rejects.toThrow(/expired without confirmation/iu);
    expect(strandChain.submissionAttempts).toBe(attemptsAfterExpiry);

    // Generation N+1 produces one distinct confirmed TestNet payout.
    const releaseNext: ReleaseInput = {
      ...releaseN,
      fenceGeneration: 2,
      authorizationCommitment: `sha256:${"8".repeat(64)}`,
      fabricClaimTransactionId: `FABRIC-TESTNET-RECOVERY-N1-${stamp}`,
    };
    const releaseCommandNext: CommandContext = {
      ...releaseCommandN,
      idempotencyKey: `TESTNET-RELEASE-RECOVERY-N1-${stamp}`,
      body: releaseNext,
    };
    const recoveredRelease = await recovered.mutate(
      releaseCommandNext,
      (await signedPermit(releaseCommandNext, reader, signer)).compact,
    ) as { escrow: Escrow; transactionId: string; replay: boolean };
    expect(recoveredRelease).toMatchObject({
      replay: false,
      escrow: { state: "COMPLETED", lockedMinor: "0", releasedMinor: "500" },
    });
    expect(recoveredRelease.transactionId).not.toBe(preparedN!.prepared!.transactionId);

    // ---- Exact accounting on the public network ---------------------------
    const [sellerAfter, appHolding] = await Promise.all([
      algod.accountAssetInformation(algosdk.Address.fromString(seller.address), assetId).do(),
      algod.accountAssetInformation(appAddress, assetId).do(),
    ]);
    // Deal A released 1000 and deal C released 500; deal B was fully refunded.
    expect((sellerAfter.assetHolding?.amount ?? 0n) - sellerStart).toBe(1_500n);
    expect(appHolding.assetHolding?.amount).toBe(0n);
    expect(reader.verifiedCommands).toBeGreaterThanOrEqual(14);
    await service.close();
  }, 900_000);
});
