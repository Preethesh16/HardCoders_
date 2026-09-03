import type { ExecutorConfig } from "./config.js";
import { conflict, notFound } from "./errors.js";
import { nextProjection, PreparedTransactionExpiredError, type AlgorandChain, type PrepareInput } from "./chain.js";
import type { FabricEvidenceReader } from "./security/fabric-evidence-reader.js";
import type { AuthoritativeFabricReader } from "./security/gateway-reader.js";
import type { FabricPermitVerifier } from "./security/permit.js";
import type { CommandRecord, ExecutorStore } from "./store.js";
import {
  canonicalIdSchema,
  commandHash,
  escrowBindingSchema,
  escrowExpectationSchema,
  releaseInputSchema,
  type CommandReconciliation,
  type CommandContext,
  type CommandEvidence,
  type Escrow,
  type EscrowBinding,
  type ExecutorAction,
  releaseBindingCommitment,
  type ReleaseInput,
  type ReleaseEvidence,
} from "./types.js";

type MutationResult = Escrow | { escrow: Escrow; transactionId: string; replay: boolean };

export class ExecutorService {
  constructor(
    private readonly config: ExecutorConfig,
    private readonly store: ExecutorStore,
    private readonly permits: FabricPermitVerifier,
    private readonly fabric: AuthoritativeFabricReader,
    private readonly chain: AlgorandChain,
    private readonly workEvidence: FabricEvidenceReader,
  ) {}

  async initialize(): Promise<void> {
    await this.store.initialize();
  }

  async mutate(command: CommandContext, compactPermit: string): Promise<MutationResult> {
    const dealId = this.commandDealId(command);
    return this.store.withDealLock(dealId, () => this.mutateLocked(dealId, command, compactPermit));
  }

  async reconcile(command: CommandContext): Promise<CommandReconciliation> {
    const dealId = this.commandDealId(command);
    return this.store.withDealLock(dealId, async () => {
      const record = await this.store.getCommand(command.idempotencyKey);
      if (!record) return { status: "NOT_FOUND", idempotencyKey: command.idempotencyKey };
      this.assertCommand(record, command.action, commandHash(command));
      if (record.dealId !== dealId) throw conflict("The idempotency key is bound to another deal.");
      if (record.status === "PENDING") {
        if (record.action === "release") {
          const cancelled = await this.store.cancelPending(record.idempotencyKey);
          if (cancelled) return this.cancelledReconciliation(cancelled);
        }
        return { status: "PENDING", idempotencyKey: record.idempotencyKey, action: record.action };
      }
      if (record.status === "SUCCEEDED") {
        if (!record.transactionId || !record.confirmedRound) throw conflict("Confirmed command evidence is incomplete.");
        return {
          status: "CONFIRMED",
          idempotencyKey: record.idempotencyKey,
          action: record.action,
          transactionId: record.transactionId,
          confirmedRound: record.confirmedRound,
        };
      }
      if (record.status === "ABANDONED") return this.expiredReconciliation(record);
      if (record.status === "CANCELLED") return this.cancelledReconciliation(record);
      return this.reconcilePrepared(record, command);
    });
  }

  private async mutateLocked(dealId: string, command: CommandContext, compactPermit: string): Promise<MutationResult> {
    const hash = commandHash(command);
    let record = await this.store.getCommand(command.idempotencyKey);
    if (record) {
      this.assertCommand(record, command.action, hash);
      if (record.dealId !== dealId) throw conflict("The idempotency key is bound to another deal.");
      if (record.status === "SUCCEEDED") return replayResponse(command.action, record.response);
      if (record.status === "CANCELLED") {
        throw conflict("The unsigned Algorand command was cancelled after its Fabric release lease expired; use the next Fabric generation command.");
      }
      if (record.status === "ABANDONED") {
        throw conflict("The prepared Algorand command expired without confirmation; use the next Fabric generation command.");
      }

      // A PREPARED transaction may already be irreversible. Reconcile that
      // exact signed transaction before consulting any mutable/expiring Fabric
      // authorization state, so a later lease recovery cannot orphan confirmed
      // Algorand evidence.
      if (record.status === "PREPARED") {
        const reconciled = await this.reconcilePrepared(record, command);
        if (reconciled.status === "CONFIRMED") {
          const completed = await this.store.getCommand(command.idempotencyKey);
          if (completed?.status !== "SUCCEEDED") throw conflict("Confirmed command persistence is incomplete.");
          return replayResponse(command.action, completed.response);
        }
        if (reconciled.status === "EXPIRED") {
          throw conflict("The prepared Algorand command expired without confirmation; use the next Fabric generation command.");
        }
      }

      // PENDING commands and unconfirmed PREPARED commands are still mutable.
      // Re-verify JWT time bounds and the current authoritative Fabric state on
      // every retry; persisted claims alone never authorize a later broadcast.
      const currentClaims = await this.permits.verify(compactPermit, command);
      await this.fabric.verifyCurrent(currentClaims, command);
      record = await this.store.reauthorizeCommand(command.idempotencyKey, currentClaims);
    } else {
      const claims = await this.permits.verify(compactPermit, command);
      await this.fabric.verifyCurrent(claims, command);
      record = await this.store.beginCommand(dealId, command.action, command.idempotencyKey, hash, claims);
      if (record.status === "SUCCEEDED") return replayResponse(command.action, record.response);
    }

    const { binding, release } = await this.resolveBinding(command);
    const prior = await this.store.getEscrow(binding.dealId);
    const expectedPreparedCommand = this.expectedPreparedCommand(record, command, binding, release);
    // Fail invalid transitions before any transaction is signed.
    nextProjection(command.action, binding, prior, "A".repeat(52), release);

    if (record.status === "PENDING") {
      if (release && Date.parse(release.leaseExpiresAt) - Date.now()
        <= this.config.ALGORAND_RELEASE_SAFETY_MARGIN_SECONDS * 1_000) {
        throw conflict("The Fabric release lease cannot fit the configured Algorand confirmation safety margin.");
      }
      // Nothing has been signed yet, so this is the last safe moment to insist
      // that Fabric still holds the exact approved work version the permit was
      // minted against. A changed, withdrawn or unapproved version fails closed.
      if (release) await this.assertApprovedWorkEvidence(release);
      const prepared = await this.chain.prepare(expectedPreparedCommand);
      record = await this.store.markPrepared(command.idempotencyKey, prepared);
    }
    if (!record.prepared) throw conflict("The durable command is missing prepared Algorand evidence.");
    let confirmation: { confirmedRound: string };
    try {
      confirmation = await this.chain.submit(record.prepared, expectedPreparedCommand);
    } catch (error) {
      if (!(error instanceof PreparedTransactionExpiredError)) throw error;
      await this.store.abandon(command.idempotencyKey, error.observedRound);
      throw conflict("The prepared Algorand command expired without confirmation; use the next Fabric generation command.");
    }
    return this.completeConfirmed(record, command, confirmation.confirmedRound, {
      binding,
      prior,
      ...(release ? { release } : {}),
    });
  }

  private async reconcilePrepared(record: CommandRecord, command: CommandContext): Promise<CommandReconciliation> {
    if (!record.prepared || !record.transactionId) {
      throw conflict("The durable command is missing prepared Algorand evidence.");
    }
    const { binding, release } = await this.resolveBinding(command);
    const reconciliation = await this.chain.reconcile(
      record.prepared,
      this.expectedPreparedCommand(record, command, binding, release),
    );
    if (reconciliation.status === "CONFIRMED") {
      await this.completeConfirmed(record, command, reconciliation.confirmedRound);
      return {
        status: "CONFIRMED",
        idempotencyKey: record.idempotencyKey,
        action: record.action,
        transactionId: record.transactionId,
        confirmedRound: reconciliation.confirmedRound,
      };
    }
    if (reconciliation.status === "EXPIRED") {
      const abandoned = await this.store.abandon(record.idempotencyKey, reconciliation.observedRound);
      return this.expiredReconciliation(abandoned);
    }
    return {
      status: "PREPARED",
      idempotencyKey: record.idempotencyKey,
      action: record.action,
      transactionId: record.transactionId,
      lastValidRound: record.prepared.lastValidRound,
      observedRound: reconciliation.observedRound,
    };
  }

  private expiredReconciliation(record: CommandRecord): CommandReconciliation {
    if (!record.prepared || !record.transactionId || !record.abandonmentRound) {
      throw conflict("Expired command evidence is incomplete.");
    }
    return {
      status: "EXPIRED",
      idempotencyKey: record.idempotencyKey,
      action: record.action,
      transactionId: record.transactionId,
      lastValidRound: record.prepared.lastValidRound,
      observedRound: record.abandonmentRound,
    };
  }

  private cancelledReconciliation(record: CommandRecord): CommandReconciliation {
    if (record.action !== "release" || record.permitClaims.action !== "release" || !record.cancellationTime) {
      throw conflict("Cancelled command evidence is incomplete.");
    }
    return {
      status: "CANCELLED",
      idempotencyKey: record.idempotencyKey,
      action: "release",
      leaseExpiresAt: record.permitClaims.releaseAuthorization.leaseExpiresAt,
      cancelledAt: record.cancellationTime,
    };
  }

  private async completeConfirmed(
    record: CommandRecord,
    command: CommandContext,
    confirmedRound: string,
    resolved?: { binding: EscrowBinding; prior: Escrow | null; release?: ReleaseInput },
  ): Promise<MutationResult> {
    const current = resolved ?? await (async () => {
      const { binding, release } = await this.resolveBinding(command);
      return { binding, release, prior: await this.store.getEscrow(binding.dealId) };
    })();
    const { binding, prior, release } = current;
    if (!record.prepared) throw conflict("The durable command is missing prepared Algorand evidence.");
    const escrow = nextProjection(command.action, binding, prior, record.prepared.transactionId, release);
    await this.chain.assertProjection(escrow);
    const response: MutationResult = command.action === "release" || command.action === "refund"
      ? { escrow, transactionId: record.prepared.transactionId, replay: false }
      : escrow;
    const completed = await this.store.complete(command.idempotencyKey, confirmedRound, response, escrow);
    return completed.response as MutationResult;
  }

  /** Re-reads the approved Fabric work evidence bound by a release permit. */
  private async assertApprovedWorkEvidence(release: ReleaseInput): Promise<void> {
    await this.workEvidence.readApprovedEvidence({
      dealId: release.escrowBinding.dealId,
      milestoneId: release.milestoneId,
      workEvidenceHash: release.releaseBinding.workEvidenceHash,
      fabricTxHash: release.releaseBinding.fabricTxHash,
    });
  }

  private commandDealId(command: CommandContext): string {
    if (command.action === "create") return escrowExpectationSchema.parse(command.body).dealId;
    if (command.action === "release") return releaseInputSchema.parse(command.body).escrowBinding.dealId;
    return canonicalIdSchema.parse(decodeURIComponent(command.path.split("/")[2] ?? ""));
  }

  async getEscrow(dealId: string): Promise<Escrow> {
    const escrow = await this.store.getEscrow(dealId);
    if (!escrow) throw notFound("The escrow does not exist.");
    await this.chain.assertProjection(escrow);
    return escrow;
  }

  async getReleaseEvidence(dealId: string, milestoneId: string): Promise<ReleaseEvidence> {
    const escrow = await this.getEscrow(dealId);
    const release = escrow.releases[milestoneId];
    if (!release) throw conflict("The milestone has no confirmed Algorand release.");
    const command = await this.store.getCommandByTransaction(release.transactionId);
    if (!command || command.action !== "release" || command.status !== "SUCCEEDED" || !command.confirmedRound) {
      throw conflict("Durable confirmed command evidence is missing for the milestone release.");
    }
    if (command.permitClaims.action !== "release") {
      throw conflict("Durable release authorization evidence is missing for the milestone release.");
    }
    const onChain = await this.chain.getReleaseEvidence(escrow, milestoneId);
    const releaseBinding = command.permitClaims.releaseAuthorization.releaseBinding;
    if (onChain.amountMinor !== release.amountMinor
      || onChain.bindingHash !== command.permitClaims.releaseAuthorization.bindingHash
      || onChain.authorizationCommitment !== releaseBindingCommitment(releaseBinding)) {
      throw conflict("On-chain release evidence conflicts with the durable authorization and projection.");
    }
    return {
      dealId,
      milestoneId,
      transactionId: release.transactionId,
      confirmedRound: command.confirmedRound,
      ...onChain,
      releaseBinding,
    };
  }

  async readiness(): Promise<boolean> {
    const [chainReady, fabricReady, evidenceReady] = await Promise.all([
      this.chain.readiness(),
      this.fabric.readiness?.() ?? Promise.resolve(true),
      this.workEvidence.readiness?.() ?? Promise.resolve(true),
    ]);
    return chainReady && fabricReady && evidenceReady;
  }

  async evidence(idempotencyKey: string): Promise<CommandEvidence> {
    const command = await this.store.getCommand(idempotencyKey);
    if (!command || command.status !== "SUCCEEDED" || !command.transactionId || !command.confirmedRound) {
      throw conflict("Confirmed command evidence is not available.");
    }
    return {
      idempotencyKey,
      action: command.action,
      transactionId: command.transactionId,
      confirmedRound: command.confirmedRound,
      replay: true,
    };
  }

  async close(): Promise<void> {
    await this.store.close();
  }

  private async resolveBinding(command: CommandContext): Promise<{ binding: EscrowBinding; release?: ReleaseInput }> {
    if (command.action === "create") {
      const expected = escrowExpectationSchema.parse(command.body);
      if (BigInt(expected.assetId) !== this.config.ALGORAND_ASSET_ID) throw conflict("The escrow uses a different configured asset.");
      return {
        binding: escrowBindingSchema.parse({
          ...expected,
          network: this.config.ALGORAND_NETWORK,
          genesisHash: this.config.ALGORAND_GENESIS_HASH,
          applicationId: this.config.ALGORAND_APPLICATION_ID.toString(),
        }),
      };
    }
    if (command.action === "release") {
      const release = releaseInputSchema.parse(command.body);
      this.assertConfiguredBinding(release.escrowBinding);
      const stored = await this.store.getEscrow(release.escrowBinding.dealId);
      if (!stored || !sameBinding(stored, release.escrowBinding)) throw conflict("The release escrow binding differs from durable state.");
      return { binding: release.escrowBinding, release };
    }
    const dealId = decodeURIComponent(command.path.split("/")[2] ?? "");
    const stored = await this.store.getEscrow(dealId);
    if (!stored) throw conflict("The escrow does not exist.");
    const binding = escrowBindingSchema.parse({
      dealId: stored.dealId,
      agreementHash: stored.agreementHash,
      originProviderAddress: stored.originProviderAddress,
      destinationProviderAddress: stored.destinationProviderAddress,
      assetId: stored.assetId,
      amount: stored.amount,
      network: stored.network,
      genesisHash: stored.genesisHash,
      applicationId: stored.applicationId,
    });
    this.assertConfiguredBinding(binding);
    return { binding };
  }

  private assertConfiguredBinding(binding: EscrowBinding): void {
    if (binding.network !== this.config.ALGORAND_NETWORK
      || binding.genesisHash !== this.config.ALGORAND_GENESIS_HASH
      || binding.applicationId !== this.config.ALGORAND_APPLICATION_ID.toString()
      || BigInt(binding.assetId) !== this.config.ALGORAND_ASSET_ID
      || binding.originProviderAddress !== this.config.ALGORAND_ORIGIN_PROVIDER_TREASURY_ADDRESS) {
      throw conflict("The escrow is bound to another Algorand deployment.");
    }
  }

  private assertCommand(record: CommandRecord, action: ExecutorAction, hash: string): void {
    if (record.action !== action || record.commandHash !== hash) throw conflict("The idempotency key is bound to another command.");
  }

  private expectedPreparedCommand(
    record: CommandRecord,
    command: CommandContext,
    binding: EscrowBinding,
    release?: ReleaseInput,
  ): PrepareInput {
    if (command.action === "release") {
      if (!release || record.permitClaims.action !== "release"
        || record.permitClaims.releaseAuthorization.fabricClaimTransactionId !== release.fabricClaimTransactionId) {
        throw conflict("The durable Fabric authorization does not match the expected Algorand release command.");
      }
      return {
        action: "release",
        commandHash: commandHash(command),
        binding,
        idempotencyKey: command.idempotencyKey,
        release,
        fabricClaimTransactionId: release.fabricClaimTransactionId,
      };
    }
    if (release !== undefined || record.permitClaims.action !== command.action) {
      throw conflict("The durable Fabric authorization does not match the expected Algorand command.");
    }
    return {
      action: command.action,
      commandHash: commandHash(command),
      binding,
      idempotencyKey: command.idempotencyKey,
    };
  }
}

function sameBinding(escrow: Escrow, binding: EscrowBinding): boolean {
  return escrow.dealId === binding.dealId
    && escrow.agreementHash === binding.agreementHash
    && escrow.network === binding.network
    && escrow.genesisHash === binding.genesisHash
    && escrow.originProviderAddress === binding.originProviderAddress
    && escrow.destinationProviderAddress === binding.destinationProviderAddress
    && escrow.assetId === binding.assetId
    && escrow.amount.amountMinor === binding.amount.amountMinor
    && escrow.amount.currency === binding.amount.currency
    && escrow.amount.scale === binding.amount.scale
    && escrow.applicationId === binding.applicationId;
}

function replayResponse(action: ExecutorAction, response: unknown): MutationResult {
  if (action !== "release" && action !== "refund") return response as Escrow;
  const value = response as { escrow: Escrow; transactionId: string; replay: boolean };
  return { ...value, replay: true };
}
