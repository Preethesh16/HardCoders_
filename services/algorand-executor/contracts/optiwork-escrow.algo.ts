import {
  Asset,
  BoxMap,
  Contract,
  Global,
  GlobalState,
  Txn,
  arc4,
  assert,
  clone,
  gtxn,
  itxn,
  op,
  uint64,
} from "@algorandfoundation/algorand-typescript";

const STATE_CREATED: uint64 = 1;
const STATE_FUNDED: uint64 = 2;
const STATE_PAUSED: uint64 = 3;
const STATE_PARTIALLY_RELEASED: uint64 = 4;
const STATE_REFUNDED: uint64 = 5;
const STATE_COMPLETED: uint64 = 6;

class EscrowRecord extends arc4.Struct<{
  agreementHash: arc4.StaticBytes<32>;
  originProvider: arc4.Address;
  destinationProvider: arc4.Address;
  assetId: arc4.Uint64;
  total: arc4.Uint64;
  locked: arc4.Uint64;
  released: arc4.Uint64;
  refunded: arc4.Uint64;
  currency: arc4.Str;
  scale: arc4.Uint8;
  state: arc4.Uint8;
  finalized: arc4.Bool;
}> {}

class ReleaseRecord extends arc4.Struct<{
  amount: arc4.Uint64;
  bindingHash: arc4.StaticBytes<32>;
  authorizationCommitment: arc4.StaticBytes<32>;
  fabricClaimTransaction: arc4.StaticBytes<32>;
  fenceGeneration: arc4.Uint64;
}> {}

class FenceRecord extends arc4.Struct<{
  authorizationCommitment: arc4.StaticBytes<32>;
  generation: arc4.Uint64;
  releaseKey: arc4.StaticBytes<32>;
}> {}

/**
 * Reusable, server-operated escrow application.
 *
 * Plain deal/agreement/milestone identifiers never enter public state. Their
 * SHA-256 digests key fixed-size boxes. The application creator is the only
 * transaction sender allowed to mutate state, while the application account
 * is the sole ASA custodian between funding and payout/refund.
 */
export class OptiWorkEscrow extends Contract {
  private readonly assetId = GlobalState<uint64>({ key: "asset" });
  private readonly assetOptedIn = GlobalState<uint64>({ key: "ready" });
  private readonly escrows = BoxMap<arc4.StaticBytes<32>, EscrowRecord>({ keyPrefix: "e" });
  private readonly releases = BoxMap<arc4.StaticBytes<32>, ReleaseRecord>({ keyPrefix: "r" });
  private readonly fences = BoxMap<arc4.StaticBytes<32>, FenceRecord>({ keyPrefix: "f" });

  @arc4.abimethod({ onCreate: "require" })
  public createApplication(assetId: uint64): void {
    assert(Txn.sender === Global.creatorAddress, "creator required");
    assert(Txn.rekeyTo === Global.zeroAddress, "rekey forbidden");
    assert(assetId > 0, "asset required");
    this.assetId.value = assetId;
    this.assetOptedIn.value = 0;
  }

  public optInAsset(): void {
    this.assertExecutor();
    assert(this.assetOptedIn.value === 0, "already opted in");
    itxn.assetTransfer({
      xferAsset: Asset(this.assetId.value),
      assetAmount: 0,
      assetReceiver: Global.currentApplicationAddress,
      fee: 0,
    }).submit();
    this.assetOptedIn.value = 1;
  }

  public createEscrow(
    dealKey: arc4.StaticBytes<32>,
    agreementHash: arc4.StaticBytes<32>,
    originProvider: arc4.Address,
    destinationProvider: arc4.Address,
    amount: arc4.Uint64,
    currency: arc4.Str,
    scale: arc4.Uint8,
  ): void {
    this.assertExecutor();
    assert(this.assetOptedIn.value === 1, "asset not ready");
    assert(!this.escrows(dealKey).exists, "escrow exists");
    assert(originProvider.native !== destinationProvider.native, "providers must differ");
    assert(amount.asUint64() > 0, "positive amount required");
    // ARC-4 strings include a two-byte length prefix in their encoded form.
    assert(currency.bytes.length >= 5 && currency.bytes.length <= 14, "invalid currency");
    assert(scale.asUint64() <= 8, "invalid scale");
    this.escrows(dealKey).value = new EscrowRecord({
      agreementHash,
      originProvider,
      destinationProvider,
      assetId: new arc4.Uint64(this.assetId.value),
      total: amount,
      locked: new arc4.Uint64(0),
      released: new arc4.Uint64(0),
      refunded: new arc4.Uint64(0),
      currency,
      scale,
      state: new arc4.Uint8(STATE_CREATED),
      finalized: new arc4.Bool(false),
    });
  }

  public fundEscrow(dealKey: arc4.StaticBytes<32>, funding: gtxn.AssetTransferTxn): void {
    this.assertExecutor();
    const box = this.escrows(dealKey);
    assert(box.exists, "escrow missing");
    const record = clone(box.value);
    assert(record.state.asUint64() === STATE_CREATED, "invalid funding state");
    // The executor submits the application call, but only the immutable origin
    // provider can contribute the asset transfer that funds this escrow. The atomic
    // group therefore requires two independent signatures.
    assert(funding.sender === record.originProvider.native, "origin provider funding required");
    assert(funding.rekeyTo === Global.zeroAddress, "funding rekey forbidden");
    assert(funding.assetSender === Global.zeroAddress, "clawback forbidden");
    assert(funding.assetCloseTo === Global.zeroAddress, "close forbidden");
    assert(funding.assetReceiver === Global.currentApplicationAddress, "wrong escrow account");
    assert(funding.xferAsset.id === this.assetId.value, "wrong asset");
    assert(funding.assetAmount === record.total.asUint64(), "wrong funding amount");
    record.locked = new arc4.Uint64(record.total.asUint64());
    record.state = new arc4.Uint8(STATE_FUNDED);
    box.value = clone(record);
  }

  public pauseEscrow(dealKey: arc4.StaticBytes<32>): void {
    this.assertExecutor();
    const box = this.escrows(dealKey);
    assert(box.exists, "escrow missing");
    const record = clone(box.value);
    const state = record.state.asUint64();
    assert(state === STATE_FUNDED || state === STATE_PARTIALLY_RELEASED, "invalid pause state");
    record.state = new arc4.Uint8(STATE_PAUSED);
    box.value = clone(record);
  }

  public resumeEscrow(dealKey: arc4.StaticBytes<32>): void {
    this.assertExecutor();
    const box = this.escrows(dealKey);
    assert(box.exists, "escrow missing");
    const record = clone(box.value);
    assert(record.state.asUint64() === STATE_PAUSED, "invalid resume state");
    record.state = new arc4.Uint8(
      record.released.asUint64() > 0 ? STATE_PARTIALLY_RELEASED : STATE_FUNDED,
    );
    box.value = clone(record);
  }

  public releaseEscrow(
    dealKey: arc4.StaticBytes<32>,
    milestoneKey: arc4.StaticBytes<32>,
    intentKey: arc4.StaticBytes<32>,
    amount: arc4.Uint64,
    bindingHash: arc4.StaticBytes<32>,
    fenceGeneration: arc4.Uint64,
    leaseExpiresAt: arc4.Uint64,
    authorizationCommitment: arc4.StaticBytes<32>,
    fabricClaimTransaction: arc4.StaticBytes<32>,
  ): void {
    this.assertExecutor();
    assert(Global.latestTimestamp < leaseExpiresAt.asUint64(), "lease expired");
    assert(fenceGeneration.asUint64() > 0, "invalid generation");
    const box = this.escrows(dealKey);
    assert(box.exists, "escrow missing");
    const record = clone(box.value);
    const state = record.state.asUint64();
    assert(state === STATE_FUNDED || state === STATE_PARTIALLY_RELEASED, "invalid release state");
    assert(amount.asUint64() > 0 && amount.asUint64() <= record.locked.asUint64(), "invalid release amount");

    const releaseKey = new arc4.StaticBytes<32>(op.sha256(dealKey.bytes.concat(milestoneKey.bytes)));
    assert(!this.releases(releaseKey).exists, "milestone already released");
    assert(!this.fences(intentKey).exists, "intent already consumed");

    itxn.assetTransfer({
      xferAsset: Asset(this.assetId.value),
      assetAmount: amount.asUint64(),
      assetReceiver: record.destinationProvider.native,
      fee: 0,
    }).submit();

    record.locked = new arc4.Uint64(record.locked.asUint64() - amount.asUint64());
    record.released = new arc4.Uint64(record.released.asUint64() + amount.asUint64());
    record.state = new arc4.Uint8(record.locked.asUint64() === 0 ? STATE_COMPLETED : STATE_PARTIALLY_RELEASED);
    box.value = clone(record);
    this.releases(releaseKey).value = new ReleaseRecord({
      amount,
      bindingHash,
      authorizationCommitment,
      fabricClaimTransaction,
      fenceGeneration,
    });
    this.fences(intentKey).value = new FenceRecord({
      authorizationCommitment,
      generation: fenceGeneration,
      releaseKey,
    });
  }

  public refundEscrow(dealKey: arc4.StaticBytes<32>): void {
    this.assertExecutor();
    const box = this.escrows(dealKey);
    assert(box.exists, "escrow missing");
    const record = clone(box.value);
    const state = record.state.asUint64();
    assert(
      state === STATE_FUNDED || state === STATE_PARTIALLY_RELEASED || state === STATE_PAUSED,
      "invalid refund state",
    );
    assert(record.locked.asUint64() > 0, "nothing to refund");
    const refundAmount = record.locked.asUint64();
    itxn.assetTransfer({
      xferAsset: Asset(this.assetId.value),
      assetAmount: refundAmount,
      assetReceiver: record.originProvider.native,
      fee: 0,
    }).submit();
    record.locked = new arc4.Uint64(0);
    record.refunded = new arc4.Uint64(refundAmount);
    record.state = new arc4.Uint8(STATE_REFUNDED);
    box.value = clone(record);
  }

  public completeEscrow(dealKey: arc4.StaticBytes<32>): void {
    this.assertExecutor();
    const box = this.escrows(dealKey);
    assert(box.exists, "escrow missing");
    const record = clone(box.value);
    const state = record.state.asUint64();
    assert(state === STATE_COMPLETED || state === STATE_REFUNDED, "escrow is not terminal");
    assert(record.locked.asUint64() === 0, "locked funds remain");
    assert(!record.finalized.native, "already finalized");
    record.finalized = new arc4.Bool(true);
    box.value = clone(record);
  }

  @arc4.abimethod({ readonly: true })
  public getEscrow(dealKey: arc4.StaticBytes<32>): EscrowRecord {
    const box = this.escrows(dealKey);
    assert(box.exists, "escrow missing");
    return box.value;
  }

  @arc4.abimethod({ readonly: true })
  public getRelease(
    dealKey: arc4.StaticBytes<32>,
    milestoneKey: arc4.StaticBytes<32>,
  ): ReleaseRecord {
    const key = new arc4.StaticBytes<32>(op.sha256(dealKey.bytes.concat(milestoneKey.bytes)));
    const box = this.releases(key);
    assert(box.exists, "release missing");
    return box.value;
  }

  private assertExecutor(): void {
    assert(Txn.sender === Global.creatorAddress, "executor required");
    assert(Txn.rekeyTo === Global.zeroAddress, "rekey forbidden");
  }
}
