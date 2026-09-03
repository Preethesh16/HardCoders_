import { describe, expect, it } from "vitest";

import { preparedCommandBinding, type AlgorandChain, type PrepareInput, type PreparedTransactionReconciliation } from "../src/chain.js";
import { ExecutorService } from "../src/service.js";
import { MemoryExecutorStore, type PreparedTransaction } from "../src/store.js";
import { commandHash, releaseInputSchema, type CommandContext, type Escrow, type PermitClaims, type ReleaseInput } from "../src/types.js";
import { approvingEvidenceReader, releaseInput, testConfig } from "./helpers.js";

class FakeChain implements AlgorandChain {
  prepareCalls: PrepareInput[] = [];
  submitted: PreparedTransaction[] = [];
  releaseEvidenceBindingHash = `sha256:${"d".repeat(64)}`;
  releaseEvidenceAuthorizationCommitment = `sha256:${"e".repeat(64)}`;

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
  async submit(prepared: PreparedTransaction) {
    this.submitted.push(structuredClone(prepared));
    return { confirmedRound: String(100 + this.submitted.length) };
  }
  async assertProjection(_escrow: Escrow) {}
  async getReleaseEvidence(_escrow: Escrow, _milestoneId: string) {
    return {
      amountMinor: "100",
      bindingHash: this.releaseEvidenceBindingHash,
      fenceGeneration: 1,
      authorizationCommitment: this.releaseEvidenceAuthorizationCommitment,
      fabricClaimTransactionHash: `sha256:${"f".repeat(64)}`,
    };
  }
  async readiness() { return true; }
}

class BlockingChain extends FakeChain {
  #releaseFirst!: () => void;
  #enteredFirst!: () => void;
  readonly firstEntered = new Promise<void>((resolve) => { this.#enteredFirst = resolve; });
  readonly releaseFirst = new Promise<void>((resolve) => { this.#releaseFirst = resolve; });
  private blocked = false;

  unblock(): void { this.#releaseFirst(); }

  override async prepare(input: PrepareInput): Promise<PreparedTransaction> {
    const prepared = await super.prepare(input);
    if (!this.blocked && input.action === "release") {
      this.blocked = true;
      this.#enteredFirst();
      await this.releaseFirst;
    }
    return prepared;
  }
}

class AmbiguousOnceChain extends FakeChain {
  ambiguous = true;

  override async submit(prepared: PreparedTransaction) {
    this.submitted.push(structuredClone(prepared));
    if (this.ambiguous) {
      this.ambiguous = false;
      throw new Error("ambiguous submission");
    }
    return { confirmedRound: "901" };
  }
}

class PrepareFailsOnceChain extends FakeChain {
  failPrepare = true;

  override async prepare(input: PrepareInput): Promise<PreparedTransaction> {
    if (this.failPrepare) {
      this.failPrepare = false;
      throw new Error("preparation interrupted");
    }
    return super.prepare(input);
  }
}

class CrashBeforeReleasePreparationChain extends FakeChain {
  crashNextRelease = false;

  override async prepare(input: PrepareInput): Promise<PreparedTransaction> {
    if (this.crashNextRelease && input.action === "release") {
      this.crashNextRelease = false;
      throw new Error("process crashed before the unsigned reservation was prepared");
    }
    return super.prepare(input);
  }
}

class ConfirmedThenCrashChain extends FakeChain {
  confirmed = false;

  override async reconcile(prepared: PreparedTransaction): Promise<PreparedTransactionReconciliation> {
    return this.confirmed
      ? { status: "CONFIRMED", observedRound: "777", confirmedRound: "777" }
      : super.reconcile(prepared);
  }

  override async submit(prepared: PreparedTransaction): Promise<{ confirmedRound: string }> {
    this.submitted.push(structuredClone(prepared));
    this.confirmed = true;
    throw new Error("process crashed after Algorand confirmation");
  }
}

class UnconfirmedAmbiguousChain extends FakeChain {
  override async submit(prepared: PreparedTransaction): Promise<{ confirmedRound: string }> {
    this.submitted.push(structuredClone(prepared));
    throw new Error("ambiguous and not confirmed");
  }
}

class ExpiringPreparedChain extends FakeChain {
  failNextSubmission = false;
  reconciliation: PreparedTransactionReconciliation = { status: "PENDING", observedRound: "99" };

  override async submit(prepared: PreparedTransaction): Promise<{ confirmedRound: string }> {
    if (!this.failNextSubmission) return super.submit(prepared);
    this.failNextSubmission = false;
    this.submitted.push(structuredClone(prepared));
    throw new Error("ambiguous release submission");
  }

  override async reconcile(_prepared: PreparedTransaction): Promise<PreparedTransactionReconciliation> {
    return structuredClone(this.reconciliation);
  }
}

function claims(command: CommandContext, release?: ReleaseInput): PermitClaims {
  const seconds = Math.floor(Date.now() / 1_000);
  const claimTransactionId = release?.fabricClaimTransactionId ?? `FABRIC-${command.idempotencyKey}`;
  const common = {
    iss: "test-fabric-gateway", aud: "test-algorand-executor", sub: "optiwork-payments" as const,
    jti: `permit-${command.idempotencyKey}`, iat: seconds, exp: seconds + 20,
    schemaVersion: "1.0" as const, method: "POST" as const, path: command.path,
    idempotencyKey: command.idempotencyKey, commandHash: commandHash(command),
    fabricTransactionId: claimTransactionId,
    authoritativeReads: [],
  };
  return command.action === "release" ? {
    ...common, action: "release", authoritativeReads: [{
      path: `/v1/evidence/${encodeURIComponent(release!.evidenceId)}/projection`,
      dataHash: release!.releaseBinding.workEvidenceHash,
    }],
    releaseAuthorization: { ...release!, fabricClaimTransactionId: claimTransactionId },
  } : { ...common, action: command.action } as PermitClaims;
}

describe("durable executor lifecycle", () => {
  it("fails readiness when the authoritative Fabric reader cannot authenticate", async () => {
    const service = new ExecutorService(
      testConfig(),
      new MemoryExecutorStore(),
      { verify: async () => { throw new Error("not used"); } },
      { verifyCurrent: async () => undefined, readiness: async () => false },
      new FakeChain(),
      approvingEvidenceReader(),
    );
    await expect(service.readiness()).resolves.toBe(false);
  });

  it("persists confirmed evidence for every lifecycle mutation and replays without resigning", async () => {
    const config = testConfig();
    const store = new MemoryExecutorStore();
    const chain = new FakeChain();
    let currentClaims!: PermitClaims;
    const service = new ExecutorService(
      config,
      store,
      { verify: async () => currentClaims },
      { verifyCurrent: async () => undefined },
      chain,
      approvingEvidenceReader(),
    );
    const createBody = {
      dealId: "DEAL-001", agreementHash: `sha256:${"c".repeat(64)}`,
      originProviderAddress: config.ALGORAND_ORIGIN_PROVIDER_TREASURY_ADDRESS,
      destinationProviderAddress: config.ALGORAND_SIGNER_ADDRESS,
      assetId: Number(config.ALGORAND_ASSET_ID),
      amount: { amountMinor: "100", currency: "USD", scale: 2 },
    };
    const run = async (command: CommandContext, release?: ReleaseInput) => {
      currentClaims = claims(command, release);
      return service.mutate(command, "signed-permit-placeholder");
    };
    const create: CommandContext = { action: "create", method: "POST", path: "/escrows", idempotencyKey: "CREATE", body: createBody };
    await run(create);
    await run({ action: "fund", method: "POST", path: "/escrows/DEAL-001/fund", idempotencyKey: "FUND", body: null });
    await run({ action: "pause", method: "POST", path: "/escrows/DEAL-001/pause", idempotencyKey: "PAUSE", body: null });
    await run({ action: "resume", method: "POST", path: "/escrows/DEAL-001/resume", idempotencyKey: "RESUME", body: null });
    const escrow = await service.getEscrow("DEAL-001");
    const binding = {
      dealId: escrow.dealId, agreementHash: escrow.agreementHash, originProviderAddress: escrow.originProviderAddress,
      destinationProviderAddress: escrow.destinationProviderAddress, assetId: escrow.assetId, amount: escrow.amount,
      network: escrow.network, genesisHash: escrow.genesisHash, applicationId: escrow.applicationId,
    };
    const release: ReleaseInput = releaseInput({
      escrowBinding: binding,
      milestoneId: "MS-001", amountMinor: "100", intentId: "INTENT-001",
      bindingHash: `sha256:${"d".repeat(64)}`, fenceGeneration: 1,
      leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
      fabricClaimTransactionId: "FABRIC-RELEASE",
      idempotencyKey: "RELEASE",
    });
    chain.releaseEvidenceAuthorizationCommitment = release.authorizationCommitment;
    const releaseCommand: CommandContext = {
      action: "release", method: "POST", path: "/escrows/DEAL-001/releases", idempotencyKey: "RELEASE", body: release,
    };
    await run(releaseCommand, release);
    await expect(service.getReleaseEvidence("DEAL-001", "MS-001")).resolves.toMatchObject({
      transactionId: expect.any(String),
      bindingHash: release.bindingHash,
    });
    chain.releaseEvidenceBindingHash = `sha256:${"0".repeat(64)}`;
    await expect(service.getReleaseEvidence("DEAL-001", "MS-001"))
      .rejects.toThrow(/conflicts with the durable authorization/iu);
    chain.releaseEvidenceBindingHash = release.bindingHash;
    await run({ action: "complete", method: "POST", path: "/escrows/DEAL-001/complete", idempotencyKey: "COMPLETE", body: null });

    for (const key of ["PAUSE", "RESUME", "COMPLETE"]) {
      await expect(service.evidence(key)).resolves.toMatchObject({ idempotencyKey: key, replay: true });
    }
    const beforeReplay = chain.prepareCalls.length;
    currentClaims = claims(releaseCommand, release);
    await expect(service.mutate(releaseCommand, "ignored-on-confirmed-replay")).resolves.toMatchObject({ replay: true });
    expect(chain.prepareCalls).toHaveLength(beforeReplay);
    expect(chain.submitted).toHaveLength(beforeReplay);
  });

  it("refuses preparation when the Fabric lease cannot fit the safety margin", async () => {
    const config = testConfig();
    const store = new MemoryExecutorStore();
    const chain = new FakeChain();
    let currentClaims!: PermitClaims;
    const service = new ExecutorService(config, store, { verify: async () => currentClaims }, { verifyCurrent: async () => undefined }, chain, approvingEvidenceReader());
    const createBody = {
      dealId: "DEAL-001", agreementHash: `sha256:${"f".repeat(64)}`,
      originProviderAddress: config.ALGORAND_ORIGIN_PROVIDER_TREASURY_ADDRESS, destinationProviderAddress: config.ALGORAND_SIGNER_ADDRESS,
      assetId: Number(config.ALGORAND_ASSET_ID), amount: { amountMinor: "10", currency: "USD", scale: 2 },
    };
    const create: CommandContext = { action: "create", method: "POST", path: "/escrows", idempotencyKey: "CREATE-SHORT", body: createBody };
    currentClaims = claims(create);
    await service.mutate(create, "permit");
    const fund: CommandContext = { action: "fund", method: "POST", path: "/escrows/DEAL-001/fund", idempotencyKey: "FUND-SHORT", body: null };
    currentClaims = claims(fund);
    await service.mutate(fund, "permit");
    const escrow = await service.getEscrow("DEAL-001");
    const binding = {
      dealId: escrow.dealId, agreementHash: escrow.agreementHash, originProviderAddress: escrow.originProviderAddress,
      destinationProviderAddress: escrow.destinationProviderAddress, assetId: escrow.assetId, amount: escrow.amount,
      network: escrow.network, genesisHash: escrow.genesisHash, applicationId: escrow.applicationId,
    };
    const release: ReleaseInput = releaseInput({
      escrowBinding: binding, milestoneId: "MS-001", amountMinor: "10", intentId: "INTENT-001",
      bindingHash: `sha256:${"1".repeat(64)}`, fenceGeneration: 1,
      leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
      fabricClaimTransactionId: "FABRIC-RELEASE-SHORT",
      idempotencyKey: "RELEASE-SHORT",
    });
    const command: CommandContext = { action: "release", method: "POST", path: "/escrows/DEAL-001/releases", idempotencyKey: "RELEASE-SHORT", body: release };
    currentClaims = claims(command, release);
    await expect(service.mutate(command, "permit")).rejects.toThrow(/safety margin/u);
    expect(chain.prepareCalls).toHaveLength(2);
  });

  it("serializes different commands for one deal through confirmed projection persistence", async () => {
    const config = testConfig();
    const store = new MemoryExecutorStore();
    const chain = new BlockingChain();
    const service = new ExecutorService(
      config,
      store,
      { verify: async (_permit, command) => claims(command, command.action === "release" ? releaseInputSchema.parse(command.body) : undefined) },
      { verifyCurrent: async () => undefined },
      chain,
      approvingEvidenceReader(),
    );
    const createBody = {
      dealId: "DEAL-001", agreementHash: `sha256:${"7".repeat(64)}`,
      originProviderAddress: config.ALGORAND_ORIGIN_PROVIDER_TREASURY_ADDRESS, destinationProviderAddress: config.ALGORAND_SIGNER_ADDRESS,
      assetId: Number(config.ALGORAND_ASSET_ID), amount: { amountMinor: "100", currency: "USD", scale: 2 },
    };
    await service.mutate({ action: "create", method: "POST", path: "/escrows", idempotencyKey: "SERIAL-CREATE", body: createBody }, "permit");
    await service.mutate({ action: "fund", method: "POST", path: "/escrows/DEAL-001/fund", idempotencyKey: "SERIAL-FUND", body: null }, "permit");
    const current = await service.getEscrow("DEAL-001");
    const escrowBinding = {
      dealId: current.dealId, agreementHash: current.agreementHash, originProviderAddress: current.originProviderAddress,
      destinationProviderAddress: current.destinationProviderAddress, assetId: current.assetId, amount: current.amount,
      network: current.network, genesisHash: current.genesisHash, applicationId: current.applicationId,
    };
    const release = (milestoneId: string, amountMinor: string, idempotencyKey: string): ReleaseInput => releaseInput({
      escrowBinding, milestoneId, amountMinor, intentId: `INTENT-${milestoneId}`,
      bindingHash: `sha256:${"8".repeat(64)}`, fenceGeneration: 1,
      leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
      fabricClaimTransactionId: `FABRIC-${idempotencyKey}`,
      idempotencyKey,
    });
    const firstBody = release("MS-001", "40", "SERIAL-REL-1");
    const secondBody = release("MS-002", "60", "SERIAL-REL-2");
    const first = service.mutate({ action: "release", method: "POST", path: "/escrows/DEAL-001/releases", idempotencyKey: "SERIAL-REL-1", body: firstBody }, "permit");
    await chain.firstEntered;
    const second = service.mutate({ action: "release", method: "POST", path: "/escrows/DEAL-001/releases", idempotencyKey: "SERIAL-REL-2", body: secondBody }, "permit");
    await new Promise((resolve) => setImmediate(resolve));
    expect(chain.prepareCalls.filter(({ action }) => action === "release")).toHaveLength(1);
    chain.unblock();
    await Promise.all([first, second]);
    const final = await service.getEscrow("DEAL-001");
    expect(final).toMatchObject({ state: "COMPLETED", lockedMinor: "0", releasedMinor: "100" });
    expect(Object.keys(final.releases)).toEqual(["MS-001", "MS-002"]);
  });

  it("blocks later commands until a prepared ambiguous command is reconciled after restart", async () => {
    const config = testConfig();
    const store = new MemoryExecutorStore();
    const chain = new AmbiguousOnceChain();
    const verifier = { verify: async (_permit: string, command: CommandContext) => claims(command) };
    const fabric = { verifyCurrent: async () => undefined };
    const service = new ExecutorService(config, store, verifier, fabric, chain, approvingEvidenceReader());
    const createBody = {
      dealId: "DEAL-001", agreementHash: `sha256:${"6".repeat(64)}`,
      originProviderAddress: config.ALGORAND_ORIGIN_PROVIDER_TREASURY_ADDRESS, destinationProviderAddress: config.ALGORAND_SIGNER_ADDRESS,
      assetId: Number(config.ALGORAND_ASSET_ID), amount: { amountMinor: "25", currency: "USD", scale: 2 },
    };
    // Initial lifecycle calls use the normal chain path.
    chain.ambiguous = false;
    await service.mutate({ action: "create", method: "POST", path: "/escrows", idempotencyKey: "RECOVER-CREATE", body: createBody }, "permit");
    await service.mutate({ action: "fund", method: "POST", path: "/escrows/DEAL-001/fund", idempotencyKey: "RECOVER-FUND", body: null }, "permit");
    chain.ambiguous = true;
    const pause: CommandContext = { action: "pause", method: "POST", path: "/escrows/DEAL-001/pause", idempotencyKey: "RECOVER-PAUSE", body: null };
    await expect(service.mutate(pause, "permit")).rejects.toThrow(/ambiguous/u);
    const prepared = await store.getCommand("RECOVER-PAUSE");
    expect(prepared).toMatchObject({ status: "PREPARED", dealId: "DEAL-001" });

    const restartedChain = new FakeChain();
    const restarted = new ExecutorService(config, store, verifier, fabric, restartedChain, approvingEvidenceReader());
    await expect(restarted.mutate({ action: "refund", method: "POST", path: "/escrows/DEAL-001/refund", idempotencyKey: "RECOVER-ATTACK", body: null }, "permit"))
      .rejects.toThrow(/reconciled first/u);
    await expect(restarted.mutate(pause, "same-command-retry")).resolves.toMatchObject({ state: "PAUSED" });
    expect(restartedChain.prepareCalls).toHaveLength(0);
    expect(restartedChain.submitted).toHaveLength(1);
    await expect(restarted.evidence("RECOVER-PAUSE")).resolves.toMatchObject({ transactionId: prepared?.transactionId });
  });

  it("requires a currently valid permit before retrying a PENDING command", async () => {
    const config = testConfig();
    const store = new MemoryExecutorStore();
    const chain = new PrepareFailsOnceChain();
    let verifyCalls = 0;
    let fabricCalls = 0;
    const command: CommandContext = {
      action: "create", method: "POST", path: "/escrows", idempotencyKey: "PENDING-EXPIRY",
      body: {
        dealId: "DEAL-PENDING", agreementHash: `sha256:${"4".repeat(64)}`,
        originProviderAddress: config.ALGORAND_ORIGIN_PROVIDER_TREASURY_ADDRESS, destinationProviderAddress: config.ALGORAND_SIGNER_ADDRESS,
        assetId: Number(config.ALGORAND_ASSET_ID), amount: { amountMinor: "25", currency: "USD", scale: 2 },
      },
    };
    const service = new ExecutorService(
      config,
      store,
      { verify: async () => {
        verifyCalls += 1;
        if (verifyCalls > 1) throw new Error("permit expired");
        return claims(command);
      } },
      { verifyCurrent: async () => { fabricCalls += 1; } },
      chain,
      approvingEvidenceReader(),
    );
    await expect(service.mutate(command, "current-permit")).rejects.toThrow(/preparation interrupted/u);
    await expect(store.getCommand(command.idempotencyKey)).resolves.toMatchObject({ status: "PENDING" });
    await expect(service.mutate(command, "expired-permit")).rejects.toThrow(/permit expired/u);
    expect(verifyCalls).toBe(2);
    expect(fabricCalls).toBe(1);
    expect(chain.prepareCalls).toHaveLength(0);
  });

  it("reconciles a confirmed PREPARED transaction before expired permits or changed Fabric state", async () => {
    const config = testConfig();
    const store = new MemoryExecutorStore();
    const chain = new ConfirmedThenCrashChain();
    let verifyCalls = 0;
    let fabricCalls = 0;
    const command: CommandContext = {
      action: "create", method: "POST", path: "/escrows", idempotencyKey: "CONFIRMED-CRASH",
      body: {
        dealId: "DEAL-CONFIRMED", agreementHash: `sha256:${"5".repeat(64)}`,
        originProviderAddress: config.ALGORAND_ORIGIN_PROVIDER_TREASURY_ADDRESS, destinationProviderAddress: config.ALGORAND_SIGNER_ADDRESS,
        assetId: Number(config.ALGORAND_ASSET_ID), amount: { amountMinor: "25", currency: "USD", scale: 2 },
      },
    };
    const service = new ExecutorService(
      config,
      store,
      { verify: async () => {
        verifyCalls += 1;
        if (verifyCalls > 1) throw new Error("permit expired");
        return claims(command);
      } },
      { verifyCurrent: async () => {
        fabricCalls += 1;
        if (fabricCalls > 1) throw new Error("Fabric authorization changed");
      } },
      chain,
      approvingEvidenceReader(),
    );
    await expect(service.mutate(command, "current-permit")).rejects.toThrow(/crashed after Algorand confirmation/u);
    await expect(store.getCommand(command.idempotencyKey)).resolves.toMatchObject({ status: "PREPARED" });
    await expect(service.reconcile(command)).resolves.toMatchObject({
      status: "CONFIRMED",
      transactionId: "B".repeat(52),
      confirmedRound: "777",
    });
    await expect(service.getEscrow("DEAL-CONFIRMED")).resolves.toMatchObject({ state: "CREATED" });
    expect(verifyCalls).toBe(1);
    expect(fabricCalls).toBe(1);
    expect(chain.submitted).toHaveLength(1);
    await expect(service.evidence(command.idempotencyKey)).resolves.toMatchObject({ confirmedRound: "777" });
  });

  it("does not broadcast an unconfirmed PREPARED transaction after its permit expires", async () => {
    const config = testConfig();
    const store = new MemoryExecutorStore();
    const chain = new UnconfirmedAmbiguousChain();
    let verifyCalls = 0;
    const command: CommandContext = {
      action: "create", method: "POST", path: "/escrows", idempotencyKey: "UNCONFIRMED-EXPIRY",
      body: {
        dealId: "DEAL-UNCONFIRMED", agreementHash: `sha256:${"3".repeat(64)}`,
        originProviderAddress: config.ALGORAND_ORIGIN_PROVIDER_TREASURY_ADDRESS, destinationProviderAddress: config.ALGORAND_SIGNER_ADDRESS,
        assetId: Number(config.ALGORAND_ASSET_ID), amount: { amountMinor: "25", currency: "USD", scale: 2 },
      },
    };
    const service = new ExecutorService(
      config,
      store,
      { verify: async () => {
        verifyCalls += 1;
        if (verifyCalls > 1) throw new Error("permit expired");
        return claims(command);
      } },
      { verifyCurrent: async () => undefined },
      chain,
      approvingEvidenceReader(),
    );
    await expect(service.mutate(command, "current-permit")).rejects.toThrow(/not confirmed/u);
    await expect(service.mutate(command, "expired-permit")).rejects.toThrow(/permit expired/u);
    expect(chain.submitted).toHaveLength(1);
    expect(verifyCalls).toBe(2);
  });

  it("abandons a PREPARED generation only after definitive last-valid-round evidence and admits N+1", async () => {
    const config = testConfig();
    const store = new MemoryExecutorStore();
    const chain = new ExpiringPreparedChain();
    const service = new ExecutorService(
      config,
      store,
      { verify: async (_permit, command) => claims(
        command,
        command.action === "release" ? releaseInputSchema.parse(command.body) : undefined,
      ) },
      { verifyCurrent: async () => undefined },
      chain,
      approvingEvidenceReader(),
    );
    const createBody = {
      dealId: "DEAL-GENERATION", agreementHash: `sha256:${"a".repeat(64)}`,
      originProviderAddress: config.ALGORAND_ORIGIN_PROVIDER_TREASURY_ADDRESS, destinationProviderAddress: config.ALGORAND_SIGNER_ADDRESS,
      assetId: Number(config.ALGORAND_ASSET_ID), amount: { amountMinor: "25", currency: "USD", scale: 2 },
    };
    await service.mutate({ action: "create", method: "POST", path: "/escrows", idempotencyKey: "GEN-CREATE", body: createBody }, "permit");
    await service.mutate({ action: "fund", method: "POST", path: "/escrows/DEAL-GENERATION/fund", idempotencyKey: "GEN-FUND", body: null }, "permit");
    const escrow = await service.getEscrow("DEAL-GENERATION");
    const escrowBinding = {
      dealId: escrow.dealId, agreementHash: escrow.agreementHash, originProviderAddress: escrow.originProviderAddress,
      destinationProviderAddress: escrow.destinationProviderAddress, assetId: escrow.assetId, amount: escrow.amount,
      network: escrow.network, genesisHash: escrow.genesisHash, applicationId: escrow.applicationId,
    };
    const release = (generation: number, idempotencyKey: string): { command: CommandContext; input: ReleaseInput } => {
      const input: ReleaseInput = releaseInput({
        escrowBinding, milestoneId: "MS-GENERATION", amountMinor: "25", intentId: "INTENT-GENERATION",
        bindingHash: `sha256:${"b".repeat(64)}`, fenceGeneration: generation,
        leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
        fabricClaimTransactionId: `FABRIC-GENERATION-${generation}`,
        idempotencyKey,
      });
      return {
        input,
        command: { action: "release", method: "POST", path: "/escrows/DEAL-GENERATION/releases", idempotencyKey, body: input },
      };
    };
    const generationN = release(1, "ALG-INTENT-GENERATION-1");
    const generationNPlusOne = release(2, "ALG-INTENT-GENERATION-2");

    chain.failNextSubmission = true;
    await expect(service.mutate(generationN.command, "permit-n")).rejects.toThrow(/ambiguous release/u);
    await expect(store.getCommand(generationN.command.idempotencyKey)).resolves.toMatchObject({ status: "PREPARED" });

    chain.reconciliation = { status: "PENDING", observedRound: "99" };
    await expect(service.reconcile(generationN.command)).resolves.toMatchObject({
      status: "PREPARED",
      observedRound: "99",
      lastValidRound: "100",
    });
    await expect(service.mutate(generationNPlusOne.command, "permit-n-plus-one"))
      .rejects.toThrow(/reconciled first/u);
    await expect(store.getCommand(generationN.command.idempotencyKey)).resolves.toMatchObject({ status: "PREPARED" });

    chain.reconciliation = { status: "EXPIRED", observedRound: "100" };
    await expect(service.reconcile(generationN.command)).resolves.toMatchObject({
      status: "EXPIRED",
      observedRound: "100",
      lastValidRound: "100",
    });
    await expect(store.getCommand(generationN.command.idempotencyKey)).resolves.toMatchObject({
      status: "ABANDONED",
      abandonmentRound: "100",
    });

    await expect(service.mutate({
      ...generationNPlusOne.command,
      idempotencyKey: generationN.command.idempotencyKey,
    }, "permit-reused-key")).rejects.toThrow(/bound to another command/u);
    await expect(service.mutate(generationNPlusOne.command, "permit-n-plus-one")).resolves.toMatchObject({
      escrow: { state: "COMPLETED", releasedMinor: "25" },
      replay: false,
    });
    await expect(service.mutate(generationN.command, "permit-n-replay"))
      .rejects.toThrow(/expired without confirmation/u);
    expect(chain.submitted).toHaveLength(4);
  });

  it("terminally cancels an exact expired unsigned PENDING generation under concurrent reconciliation", async () => {
    const now = new Date("2026-08-28T00:00:00.000Z");
    const realNow = Date.now;
    let currentTime = now.getTime();
    Date.now = () => currentTime;
    try {
      const config = testConfig();
      const store = new MemoryExecutorStore();
      const chain = new CrashBeforeReleasePreparationChain();
      const service = new ExecutorService(
        config,
        store,
        { verify: async (_permit, command) => claims(
          command,
          command.action === "release" ? releaseInputSchema.parse(command.body) : undefined,
        ) },
        { verifyCurrent: async () => undefined },
        chain,
        approvingEvidenceReader(),
      );
      const createBody = {
        dealId: "DEAL-PENDING-GENERATION", agreementHash: `sha256:${"a".repeat(64)}`,
        originProviderAddress: config.ALGORAND_ORIGIN_PROVIDER_TREASURY_ADDRESS, destinationProviderAddress: config.ALGORAND_SIGNER_ADDRESS,
        assetId: Number(config.ALGORAND_ASSET_ID), amount: { amountMinor: "30", currency: "USD", scale: 2 },
      };
      await service.mutate({ action: "create", method: "POST", path: "/escrows", idempotencyKey: "PENDING-CREATE", body: createBody }, "permit");
      await service.mutate({ action: "fund", method: "POST", path: "/escrows/DEAL-PENDING-GENERATION/fund", idempotencyKey: "PENDING-FUND", body: null }, "permit");
      const escrow = await service.getEscrow("DEAL-PENDING-GENERATION");
      const release = (generation: number, idempotencyKey: string, leaseExpiresAt: string) => {
        const input: ReleaseInput = releaseInput({
          escrowBinding: {
            dealId: escrow.dealId, agreementHash: escrow.agreementHash, originProviderAddress: escrow.originProviderAddress,
            destinationProviderAddress: escrow.destinationProviderAddress, assetId: escrow.assetId, amount: escrow.amount,
            network: escrow.network, genesisHash: escrow.genesisHash, applicationId: escrow.applicationId,
          },
          milestoneId: "MS-PENDING-GENERATION", amountMinor: "30", intentId: "INTENT-PENDING-GENERATION",
          bindingHash: `sha256:${"b".repeat(64)}`, fenceGeneration: generation, leaseExpiresAt,
          fabricClaimTransactionId: `FABRIC-PENDING-GENERATION-${generation}`,
          idempotencyKey,
        });
        return {
          input,
          command: {
            action: "release", method: "POST", path: "/escrows/DEAL-PENDING-GENERATION/releases",
            idempotencyKey, body: input,
          } satisfies CommandContext,
        };
      };
      const generationN = release(1, "ALG-PENDING-GENERATION-1", new Date(currentTime + 120_000).toISOString());
      chain.crashNextRelease = true;
      await expect(service.mutate(generationN.command, "permit-n"))
        .rejects.toThrow(/crashed before the unsigned reservation/iu);
      await expect(store.getCommand(generationN.command.idempotencyKey)).resolves.toMatchObject({ status: "PENDING" });
      expect(chain.submitted).toHaveLength(2);

      await expect(service.reconcile(generationN.command)).resolves.toEqual({
        status: "PENDING",
        idempotencyKey: generationN.command.idempotencyKey,
        action: "release",
      });
      await expect(store.getCommand(generationN.command.idempotencyKey)).resolves.toMatchObject({ status: "PENDING" });

      currentTime += 121_000;
      const [first, replay] = await Promise.all([
        service.reconcile(generationN.command),
        service.reconcile(generationN.command),
      ]);
      expect(first).toMatchObject({ status: "CANCELLED", action: "release", leaseExpiresAt: generationN.input.leaseExpiresAt });
      expect(replay).toEqual(first);
      await expect(store.getCommand(generationN.command.idempotencyKey)).resolves.toMatchObject({
        status: "CANCELLED",
        cancellationTime: expect.any(String),
      });

      await expect(service.mutate(generationN.command, "permit-n-replay"))
        .rejects.toThrow(/cancelled|expired/iu);
      expect(chain.submitted).toHaveLength(2);
      const generationNPlusOne = release(2, "ALG-PENDING-GENERATION-2", new Date(currentTime + 120_000).toISOString());
      await expect(service.mutate(generationNPlusOne.command, "permit-n-plus-one")).resolves.toMatchObject({
        escrow: { state: "COMPLETED", releasedMinor: "30" },
        replay: false,
      });
      expect(chain.submitted).toHaveLength(3);
    } finally {
      Date.now = realNow;
    }
  });
});
