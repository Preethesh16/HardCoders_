import { readFile } from "node:fs/promises";

import { AlgorandClient } from "@algorandfoundation/algokit-utils";
import { AlgoAmount } from "@algorandfoundation/algokit-utils/types/amount";
import { AppFactory } from "@algorandfoundation/algokit-utils/types/app-factory";
import algosdk from "algosdk";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";

import { sha256, sha256Text } from "../../src/canonical.js";
import {
  RealAlgorandChain,
  type AlgorandChain,
  type PreparedTransactionReconciliation,
} from "../../src/chain.js";
import { loadConfig, type ExecutorConfig } from "../../src/config.js";
import { MockFabricEvidenceReader } from "../../src/security/fabric-evidence-reader.js";
import type { AuthoritativeFabricReader } from "../../src/security/gateway-reader.js";
import { Ed25519FabricPermitVerifier, FABRIC_PERMIT_TYPE } from "../../src/security/permit.js";
import { ExecutorService } from "../../src/service.js";
import { MemoryExecutorStore, type PreparedTransaction } from "../../src/store.js";
import {
  commandHash,
  type CommandContext,
  type Escrow,
  type PermitClaims,
  type ReleaseInput,
} from "../../src/types.js";
import { approvedEvidence, releaseInput, seedApprovedEvidence } from "../helpers.js";

const ALGOD_URL = "http://127.0.0.1:4001";
const ALGOD_TOKEN = "a".repeat(64);

class LocalFabricReader implements AuthoritativeFabricReader {
  readonly values = new Map<string, unknown>();
  verifiedCommands = 0;

  set(path: string, value: unknown): void {
    this.values.set(path, structuredClone(value));
  }

  tamper(path: string): void {
    this.values.set(path, { state: "changed-after-permit" });
  }

  async verifyCurrent(claims: PermitClaims, command: CommandContext): Promise<void> {
    this.verifiedCommands += 1;
    if (claims.action !== command.action) throw new Error("Fabric action mismatch.");
    if (claims.action === "release" && claims.authoritativeReads.length !== 1) {
      throw new Error("Release did not perform its single approved-evidence Fabric read.");
    }
    if (claims.action !== "release" && claims.authoritativeReads.length !== 0) {
      throw new Error("A lifecycle permit must not claim mutable Fabric reads.");
    }
    for (const read of claims.authoritativeReads) {
      if (!this.values.has(read.path) || sha256(this.values.get(read.path)) !== read.dataHash) {
        throw new Error("Fabric state changed after permit issuance.");
      }
    }
  }
}

class StrandNextSubmissionChain implements AlgorandChain {
  stranded?: PreparedTransaction;
  submissionAttempts = 0;

  constructor(private readonly delegate: AlgorandChain) {}

  prepare(input: Parameters<AlgorandChain["prepare"]>[0]): Promise<PreparedTransaction> {
    return this.delegate.prepare(input);
  }

  reconcile(
    prepared: PreparedTransaction,
    expected: Parameters<AlgorandChain["reconcile"]>[1],
  ): Promise<PreparedTransactionReconciliation> {
    return this.delegate.reconcile(prepared, expected);
  }

  async submit(
    prepared: PreparedTransaction,
    expected: Parameters<AlgorandChain["submit"]>[1],
  ): Promise<{ confirmedRound: string }> {
    this.submissionAttempts += 1;
    if (!this.stranded) {
      this.stranded = structuredClone(prepared);
      throw new Error("Intentionally stranded the prepared LocalNet transaction before broadcast.");
    }
    return this.delegate.submit(prepared, expected);
  }

  assertProjection(escrow: Escrow): Promise<void> {
    return this.delegate.assertProjection(escrow);
  }

  getReleaseEvidence(
    escrow: Escrow,
    milestoneId: string,
  ): ReturnType<AlgorandChain["getReleaseEvidence"]> {
    return this.delegate.getReleaseEvidence(escrow, milestoneId);
  }

  readiness(): Promise<boolean> {
    return this.delegate.readiness();
  }
}

type PermitSigner = {
  privateKey: CryptoKey;
  kid: string;
  sequence: number;
};

async function signedPermit(
  command: CommandContext,
  reader: LocalFabricReader,
  signer: PermitSigner,
  options: { jti?: string } = {},
): Promise<{ compact: string; paths: string[] }> {
  signer.sequence += 1;
  const release = command.action === "release" ? command.body as ReleaseInput : undefined;
  const paths = release ? [`/v1/evidence/${encodeURIComponent(release.evidenceId)}/projection`] : [];
  const authoritativeReads = release ? paths.map((path) => {
    const value = approvedEvidence(release.fabricClaimTransactionId, { evidenceId: release.evidenceId });
    reader.set(path, value);
    return { path, dataHash: sha256(value) };
  }) : [];
  const now = Math.floor(Date.now() / 1_000);
  const fabricTransactionId = release?.fabricClaimTransactionId
    ?? `FABRIC-${command.action.toUpperCase()}-${signer.sequence}`;
  const common = {
    iss: "localnet-fabric-gateway",
    aud: "localnet-algorand-executor",
    sub: "optiwork-payments" as const,
    jti: options.jti ?? `PERMIT-${command.action.toUpperCase()}-${signer.sequence}`,
    iat: now,
    exp: now + 20,
    schemaVersion: "1.0" as const,
    action: command.action,
    method: "POST" as const,
    path: command.path,
    idempotencyKey: command.idempotencyKey,
    commandHash: commandHash(command),
    fabricTransactionId,
    authoritativeReads,
  };
  const claims = release
    ? { ...common, action: "release" as const, releaseAuthorization: release }
    : common;
  const compact = await new SignJWT(claims)
    .setProtectedHeader({ alg: "EdDSA", typ: FABRIC_PERMIT_TYPE, kid: signer.kid })
    .sign(signer.privateKey);
  return { compact, paths };
}

function binding(escrow: Escrow) {
  return {
    dealId: escrow.dealId,
    agreementHash: escrow.agreementHash,
    originProviderAddress: escrow.originProviderAddress,
    destinationProviderAddress: escrow.destinationProviderAddress,
    assetId: escrow.assetId,
    amount: escrow.amount,
    network: escrow.network,
    genesisHash: escrow.genesisHash,
    applicationId: escrow.applicationId,
  };
}

describe("real AlgoKit LocalNet escrow", () => {
  it("automates deployment and confirms create/fund/pause/resume/release/refund/complete with signed permits", async () => {
    const algorand = AlgorandClient.defaultLocalNet().setDefaultValidityWindow(100);
    const algod = algorand.client.algod;
    const dispenser = await algorand.account.localNetDispenser();
    const executor = algosdk.generateAccount();
    const originTreasury = algosdk.generateAccount();
    const destinationProvider = algosdk.generateAccount();
    const executorSigner = algosdk.makeBasicAccountTransactionSigner(executor);
    const originTreasurySigner = algosdk.makeBasicAccountTransactionSigner(originTreasury);
    const destinationSigner = algosdk.makeBasicAccountTransactionSigner(destinationProvider);
    algorand
      .setSigner(executor.addr, executorSigner)
      .setSigner(originTreasury.addr, originTreasurySigner)
      .setSigner(destinationProvider.addr, destinationSigner);

    for (const receiver of [executor.addr, originTreasury.addr, destinationProvider.addr]) {
      await algorand.send.payment({
        sender: dispenser.addr,
        signer: dispenser.signer,
        receiver,
        amount: AlgoAmount.Algo(20),
        maxRoundsToWaitForConfirmation: 20,
        suppressLog: true,
      });
    }

    const createdAsset = await algorand.send.assetCreate({
      sender: originTreasury.addr,
      signer: originTreasurySigner,
      total: 1_000_000n,
      decimals: 6,
      assetName: "OptiUSD-DEMO",
      unitName: "OPTUSD",
      maxRoundsToWaitForConfirmation: 20,
      suppressLog: true,
    });
    const assetId = createdAsset.assetId;
    await algorand.send.assetOptIn({
      sender: destinationProvider.addr,
      signer: destinationSigner,
      assetId,
      maxRoundsToWaitForConfirmation: 20,
      suppressLog: true,
    });

    const appSpec = await readFile(
      new URL("../../contracts/artifacts/OptiWorkEscrow.arc56.json", import.meta.url),
      "utf8",
    );
    const factory = new AppFactory({
      algorand,
      appSpec,
      appName: "OptiWorkEscrowLocalNetAcceptance",
      defaultSender: executor.addr,
      defaultSigner: executorSigner,
    });
    const createdApp = await factory.send.create({
      method: "createApplication",
      args: [assetId],
      sender: executor.addr,
      signer: executorSigner,
      maxRoundsToWaitForConfirmation: 20,
      suppressLog: true,
    });
    await createdApp.appClient.send.fundAppAccount({
      amount: AlgoAmount.Algo(10),
      sender: executor.addr,
      signer: executorSigner,
      maxRoundsToWaitForConfirmation: 20,
      suppressLog: true,
    });
    await createdApp.appClient.send.call({
      method: "optInAsset",
      args: [],
      sender: executor.addr,
      signer: executorSigner,
      assetReferences: [assetId],
      maxFee: AlgoAmount.MicroAlgo(2_000),
      coverAppCallInnerTransactionFees: true,
      maxRoundsToWaitForConfirmation: 20,
      suppressLog: true,
    });

    const params = await algod.getTransactionParams().do();
    const genesisHash = Buffer.from(params.genesisHash ?? []).toString("base64");
    const { publicKey, privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
    const kid = "localnet-fabric-permit-key";
    const publicJwk = { ...await exportJWK(publicKey), kid, alg: "EdDSA", use: "sig" };
    const config: ExecutorConfig = loadConfig({
      HOST: "127.0.0.1",
      PORT: "4301",
      LOG_LEVEL: "silent",
      EXECUTOR_BEARER_TOKEN: "localnet-executor-transport-token-acceptance",
      DATABASE_URL: "postgresql://unused:unused@127.0.0.1:5432/unused",
      DATABASE_SSL_MODE: "disable",
      DATABASE_AUTO_MIGRATE: "false",
      DATABASE_DEAL_LOCK_TIMEOUT_MS: "120000",
      FABRIC_GATEWAY_URL: "http://127.0.0.1:4200",
      FABRIC_GATEWAY_BEARER_TOKEN: "localnet-fabric-reader-token",
      FABRIC_GATEWAY_TIMEOUT_MS: "3000",
      FABRIC_PERMIT_ISSUER: "localnet-fabric-gateway",
      FABRIC_PERMIT_AUDIENCE: "localnet-algorand-executor",
      FABRIC_PERMIT_PUBLIC_JWK_JSON: JSON.stringify(publicJwk),
      FABRIC_PERMIT_MAX_AGE_SECONDS: "60",
      ALGORAND_RELEASE_SAFETY_MARGIN_SECONDS: "30",
      ALGORAND_NETWORK: "localnet",
      ALGORAND_ALGOD_URL: ALGOD_URL,
      ALGORAND_ALGOD_TOKEN: ALGOD_TOKEN,
      ALGORAND_REQUEST_TIMEOUT_MS: "15000",
      ALGORAND_CONFIRMATION_ROUNDS: "1",
      ALGORAND_GENESIS_HASH: genesisHash,
      ALGORAND_APPLICATION_ID: createdApp.result.appId.toString(),
      ALGORAND_ASSET_ID: assetId.toString(),
      ALGORAND_SIGNER_ADDRESS: executor.addr.toString(),
      ALGORAND_SIGNER_PRIVATE_KEY_BASE64: Buffer.from(executor.sk).toString("base64"),
      ALGORAND_ORIGIN_PROVIDER_TREASURIES_JSON: JSON.stringify([{
        address: originTreasury.addr.toString(),
        privateKeyBase64: Buffer.from(originTreasury.sk).toString("base64"),
      }]),
      ALGORAND_MAX_VALIDITY_ROUNDS: "100",
    });
    const reader = new LocalFabricReader();
    const evidenceReader = new MockFabricEvidenceReader();
    const store = new MemoryExecutorStore();
    const realChain = new RealAlgorandChain(config);
    const service = new ExecutorService(
      config,
      store,
      new Ed25519FabricPermitVerifier(config),
      reader,
      realChain,
      evidenceReader,
    );
    await service.initialize();
    const permitSigner: PermitSigner = { privateKey, kid, sequence: 0 };
    const run = async (command: CommandContext, options?: { jti?: string }) => {
      const permit = await signedPermit(command, reader, permitSigner, options);
      return service.mutate(command, permit.compact);
    };

    const dealA = "DEAL-LOCALNET-RELEASE";
    const createA: CommandContext = {
      action: "create",
      method: "POST",
      path: "/escrows",
      idempotencyKey: "LOCALNET-CREATE-A",
      body: {
        dealId: dealA,
        agreementHash: `sha256:${"1".repeat(64)}`,
        originProviderAddress: originTreasury.addr.toString(),
        destinationProviderAddress: destinationProvider.addr.toString(),
        assetId: Number(assetId),
        amount: { amountMinor: "10000", currency: "USD", scale: 6 },
      },
    };

    const permitForOriginal = await signedPermit(createA, reader, permitSigner);
    const beneficiarySwap: CommandContext = {
      ...createA,
      body: { ...(createA.body as Record<string, unknown>), destinationProviderAddress: executor.addr.toString() },
    };
    await expect(service.mutate(beneficiarySwap, permitForOriginal.compact)).rejects.toThrow(/permit|bind|invalid/iu);

    const createdA = await run(createA) as Escrow;
    const createReplay = await service.mutate(createA, (await signedPermit(createA, reader, permitSigner)).compact) as Escrow;
    expect(createReplay.createTxId).toBe(createdA.createTxId);
    await run({ action: "fund", method: "POST", path: `/escrows/${dealA}/fund`, idempotencyKey: "LOCALNET-FUND-A", body: null });

    await run({ action: "pause", method: "POST", path: `/escrows/${dealA}/pause`, idempotencyKey: "LOCALNET-PAUSE-A", body: null });
    await run({ action: "resume", method: "POST", path: `/escrows/${dealA}/resume`, idempotencyKey: "LOCALNET-RESUME-A", body: null });

    const escrowA = await service.getEscrow(dealA);
    const leaseExpiresAt = new Date(Date.now() + 180_000).toISOString();
    const releaseA: ReleaseInput = releaseInput({
      escrowBinding: binding(escrowA),
      milestoneId: "MS-LOCALNET-001",
      amountMinor: "10000",
      intentId: "INTENT-LOCALNET-001",
      bindingHash: `sha256:${"2".repeat(64)}`,
      fenceGeneration: 1,
      leaseExpiresAt,
      fabricClaimTransactionId: "FABRIC-LOCALNET-CLAIM-001",
      idempotencyKey: "LOCALNET-RELEASE-A",
      workEvidenceHash: seedApprovedEvidence(
        evidenceReader, dealA, "MS-LOCALNET-001", "FABRIC-LOCALNET-CLAIM-001", { evidenceId: "EVIDENCE-TEST-001" },
      ),
    });
    const releaseCommand: CommandContext = {
      action: "release",
      method: "POST",
      path: `/escrows/${dealA}/releases`,
      idempotencyKey: "LOCALNET-RELEASE-A",
      body: releaseA,
    };
    const stalePermit = await signedPermit(releaseCommand, reader, permitSigner);
    reader.tamper(stalePermit.paths[0]!);
    await expect(service.mutate(releaseCommand, stalePermit.compact)).rejects.toThrow(/Fabric state changed/u);
    const released = await run(releaseCommand) as { escrow: Escrow; transactionId: string; replay: boolean };
    expect(released).toMatchObject({ replay: false, escrow: { state: "COMPLETED", lockedMinor: "0", releasedMinor: "10000" } });
    const releaseReplay = await service.mutate(
      releaseCommand,
      (await signedPermit(releaseCommand, reader, permitSigner)).compact,
    ) as { transactionId: string; replay: boolean };
    expect(releaseReplay).toMatchObject({ transactionId: released.transactionId, replay: true });
    const releaseEvidence = await service.getReleaseEvidence(dealA, "MS-LOCALNET-001");
    expect(releaseEvidence).toMatchObject({
      transactionId: released.transactionId,
      amountMinor: "10000",
      bindingHash: releaseA.bindingHash,
      fenceGeneration: 1,
      authorizationCommitment: releaseA.authorizationCommitment,
      fabricClaimTransactionHash: sha256Text(releaseA.fabricClaimTransactionId),
    });
    await run({ action: "complete", method: "POST", path: `/escrows/${dealA}/complete`, idempotencyKey: "LOCALNET-COMPLETE-A", body: null });

    const dealB = "DEAL-LOCALNET-REFUND";
    await run({
      action: "create", method: "POST", path: "/escrows", idempotencyKey: "LOCALNET-CREATE-B",
      body: {
        dealId: dealB,
        agreementHash: `sha256:${"4".repeat(64)}`,
        originProviderAddress: originTreasury.addr.toString(),
        destinationProviderAddress: destinationProvider.addr.toString(),
        assetId: Number(assetId),
        amount: { amountMinor: "7000", currency: "USD", scale: 6 },
      },
    });
    await run({ action: "fund", method: "POST", path: `/escrows/${dealB}/fund`, idempotencyKey: "LOCALNET-FUND-B", body: null });
    const pauseB: CommandContext = {
      action: "pause", method: "POST", path: `/escrows/${dealB}/pause`, idempotencyKey: "LOCALNET-PAUSE-B", body: null,
    };
    await run(pauseB, { jti: "PERMIT-LOCALNET-SINGLE-USE" });
    const reusedJtiResume: CommandContext = {
      action: "resume", method: "POST", path: `/escrows/${dealB}/resume`, idempotencyKey: "LOCALNET-REUSED-JTI", body: null,
    };
    await expect(run(reusedJtiResume, { jti: "PERMIT-LOCALNET-SINGLE-USE" }))
      .rejects.toThrow(/already authorized another command/u);
    await run({ action: "resume", method: "POST", path: `/escrows/${dealB}/resume`, idempotencyKey: "LOCALNET-RESUME-B", body: null });
    await run({ action: "pause", method: "POST", path: `/escrows/${dealB}/pause`, idempotencyKey: "LOCALNET-PAUSE-B-AGAIN", body: null });
    const refundCommand: CommandContext = {
      action: "refund", method: "POST", path: `/escrows/${dealB}/refund`, idempotencyKey: "LOCALNET-REFUND-B", body: null,
    };
    const refunded = await run(refundCommand) as { escrow: Escrow; transactionId: string; replay: boolean };
    expect(refunded).toMatchObject({ replay: false, escrow: { state: "REFUNDED", lockedMinor: "0", refundedMinor: "7000" } });
    const refundReplay = await service.mutate(
      refundCommand,
      (await signedPermit(refundCommand, reader, permitSigner)).compact,
    ) as { transactionId: string; replay: boolean };
    expect(refundReplay).toMatchObject({ transactionId: refunded.transactionId, replay: true });
    await run({ action: "complete", method: "POST", path: `/escrows/${dealB}/complete`, idempotencyKey: "LOCALNET-COMPLETE-B", body: null });

    const dealC = "DEAL-LOCALNET-PREPARED-RECOVERY";
    await run({
      action: "create", method: "POST", path: "/escrows", idempotencyKey: "LOCALNET-CREATE-C",
      body: {
        dealId: dealC,
        agreementHash: `sha256:${"5".repeat(64)}`,
        originProviderAddress: originTreasury.addr.toString(),
        destinationProviderAddress: destinationProvider.addr.toString(),
        assetId: Number(assetId),
        amount: { amountMinor: "5000", currency: "USD", scale: 6 },
      },
    });
    await run({ action: "fund", method: "POST", path: `/escrows/${dealC}/fund`, idempotencyKey: "LOCALNET-FUND-C", body: null });

    const shortValidityConfig: ExecutorConfig = { ...config, ALGORAND_MAX_VALIDITY_ROUNDS: 4 };
    const strandChain = new StrandNextSubmissionChain(new RealAlgorandChain(shortValidityConfig));
    const recoveryService = new ExecutorService(
      shortValidityConfig,
      store,
      new Ed25519FabricPermitVerifier(shortValidityConfig),
      reader,
      strandChain,
      evidenceReader,
    );
    const escrowC = await recoveryService.getEscrow(dealC);
    const releaseN: ReleaseInput = releaseInput({
      escrowBinding: binding(escrowC),
      milestoneId: "MS-LOCALNET-RECOVERY",
      amountMinor: "5000",
      intentId: "INTENT-LOCALNET-RECOVERY",
      bindingHash: `sha256:${"6".repeat(64)}`,
      fenceGeneration: 1,
      leaseExpiresAt: new Date(Date.now() + 180_000).toISOString(),
      fabricClaimTransactionId: "FABRIC-LOCALNET-CLAIM-RECOVERY-N",
      idempotencyKey: "LOCALNET-RELEASE-RECOVERY-N",
      workEvidenceHash: seedApprovedEvidence(
        evidenceReader, dealC, "MS-LOCALNET-RECOVERY", "FABRIC-LOCALNET-CLAIM-RECOVERY-N", { evidenceId: "EVIDENCE-TEST-001" },
      ),
    });
    const releaseCommandN: CommandContext = {
      action: "release",
      method: "POST",
      path: `/escrows/${dealC}/releases`,
      idempotencyKey: "LOCALNET-RELEASE-RECOVERY-N",
      body: releaseN,
    };
    await expect(recoveryService.mutate(
      releaseCommandN,
      (await signedPermit(releaseCommandN, reader, permitSigner)).compact,
    )).rejects.toThrow(/intentionally stranded/iu);
    const preparedN = await store.getCommand(releaseCommandN.idempotencyKey);
    expect(preparedN).toMatchObject({ status: "PREPARED", transactionId: strandChain.stranded?.transactionId });
    expect(preparedN?.prepared).toBeDefined();
    const lastValidRoundN = BigInt(preparedN!.prepared!.lastValidRound);
    let advancementSequence = 0;
    while ((await algod.status().do()).lastRound < lastValidRoundN) {
      advancementSequence += 1;
      await algorand.send.payment({
        sender: dispenser.addr,
        signer: dispenser.signer,
        receiver: executor.addr,
        amount: AlgoAmount.MicroAlgo(1),
        note: new TextEncoder().encode(`optiwork-prepared-expiry-${advancementSequence}`),
        maxRoundsToWaitForConfirmation: 20,
        suppressLog: true,
      });
    }

    // Recreate the service after signed bytes are durable. Reconciliation must
    // resume from those exact bytes without a new permit or a second signing
    // operation, matching a real executor process restart.
    const restartedRecoveryService = new ExecutorService(
      shortValidityConfig,
      store,
      new Ed25519FabricPermitVerifier(shortValidityConfig),
      reader,
      new RealAlgorandChain(shortValidityConfig),
      evidenceReader,
    );
    const expiredN = await restartedRecoveryService.reconcile(releaseCommandN);
    expect(expiredN).toMatchObject({
      status: "EXPIRED",
      transactionId: preparedN!.prepared!.transactionId,
      lastValidRound: preparedN!.prepared!.lastValidRound,
    });
    if (expiredN.status !== "EXPIRED") throw new Error("The stranded LocalNet transaction was not terminally expired.");
    expect(BigInt(expiredN.observedRound)).toBeGreaterThanOrEqual(lastValidRoundN);
    expect(await store.getCommand(releaseCommandN.idempotencyKey)).toMatchObject({
      status: "ABANDONED",
      abandonmentRound: expect.any(String),
    });
    const attemptsAfterExpiry = strandChain.submissionAttempts;
    await expect(recoveryService.mutate(
      releaseCommandN,
      (await signedPermit(releaseCommandN, reader, permitSigner)).compact,
    )).rejects.toThrow(/expired without confirmation/iu);
    expect(strandChain.submissionAttempts).toBe(attemptsAfterExpiry);

    const releaseNPlusOne: ReleaseInput = releaseInput({
      escrowBinding: releaseN.escrowBinding,
      milestoneId: releaseN.milestoneId,
      amountMinor: releaseN.amountMinor,
      intentId: releaseN.intentId,
      bindingHash: releaseN.bindingHash,
      leaseExpiresAt: releaseN.leaseExpiresAt,
      fenceGeneration: 2,
      fabricClaimTransactionId: "FABRIC-LOCALNET-CLAIM-RECOVERY-N-PLUS-ONE",
      idempotencyKey: "LOCALNET-RELEASE-RECOVERY-N-PLUS-ONE",
      workEvidenceHash: seedApprovedEvidence(
        evidenceReader, dealC, "MS-LOCALNET-RECOVERY", "FABRIC-LOCALNET-CLAIM-RECOVERY-N-PLUS-ONE", { evidenceId: "EVIDENCE-TEST-001" },
      ),
    });
    const releaseCommandNPlusOne: CommandContext = {
      ...releaseCommandN,
      idempotencyKey: "LOCALNET-RELEASE-RECOVERY-N-PLUS-ONE",
      body: releaseNPlusOne,
    };
    const recoveredRelease = await recoveryService.mutate(
      releaseCommandNPlusOne,
      (await signedPermit(releaseCommandNPlusOne, reader, permitSigner)).compact,
    ) as { escrow: Escrow; transactionId: string; replay: boolean };
    expect(recoveredRelease).toMatchObject({
      replay: false,
      escrow: { state: "COMPLETED", lockedMinor: "0", releasedMinor: "5000" },
    });
    expect(recoveredRelease.transactionId).not.toBe(preparedN!.prepared!.transactionId);
    await expect(recoveryService.getReleaseEvidence(dealC, releaseN.milestoneId)).resolves.toMatchObject({
      transactionId: recoveredRelease.transactionId,
      bindingHash: releaseNPlusOne.bindingHash,
      fenceGeneration: 2,
      authorizationCommitment: releaseNPlusOne.authorizationCommitment,
      fabricClaimTransactionHash: sha256Text(releaseNPlusOne.fabricClaimTransactionId),
    });

    const [destinationHolding, originTreasuryHolding, appHolding] = await Promise.all([
      algod.accountAssetInformation(destinationProvider.addr, assetId).do(),
      algod.accountAssetInformation(originTreasury.addr, assetId).do(),
      algod.accountAssetInformation(createdApp.result.appAddress, assetId).do(),
    ]);
    expect(destinationHolding.assetHolding?.amount).toBe(15_000n);
    expect(originTreasuryHolding.assetHolding?.amount).toBe(985_000n);
    expect(appHolding.assetHolding?.amount).toBe(0n);
    expect(await service.readiness()).toBe(true);
    expect(reader.verifiedCommands).toBeGreaterThanOrEqual(14);
    await service.close();
  }, 240_000);
});
