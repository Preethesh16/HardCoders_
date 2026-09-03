import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";

import algosdk, { ABIContract, ABIType, AtomicTransactionComposer } from "algosdk";

import { digestBytes, parseSha256, sha256 } from "./canonical.js";
import type { ExecutorConfig } from "./config.js";
import { conflict, unavailable } from "./errors.js";
import type { PreparedTransaction } from "./store.js";
import {
  escrowBindingSchema,
  escrowSchema,
  hashSchema,
  idempotencyKeySchema,
  releaseInputSchema,
  type Escrow,
  type EscrowBinding,
  type ExecutorAction,
  type ReleaseInput,
  type ReleaseEvidence,
} from "./types.js";
import { BoundedAlgodHttpClient, BoundedHttpError } from "./algod-http.js";

const CONTRACT = new ABIContract({
  name: "OptiWorkEscrow",
  methods: [
    { name: "createEscrow", args: [
      { type: "byte[32]" }, { type: "byte[32]" }, { type: "address" }, { type: "address" },
      { type: "uint64" }, { type: "string" }, { type: "uint8" },
    ], returns: { type: "void" } },
    { name: "fundEscrow", args: [{ type: "byte[32]" }, { type: "axfer" }], returns: { type: "void" } },
    { name: "pauseEscrow", args: [{ type: "byte[32]" }], returns: { type: "void" } },
    { name: "resumeEscrow", args: [{ type: "byte[32]" }], returns: { type: "void" } },
    { name: "releaseEscrow", args: [
      { type: "byte[32]" }, { type: "byte[32]" }, { type: "byte[32]" }, { type: "uint64" }, { type: "byte[32]" },
      { type: "uint64" }, { type: "uint64" }, { type: "byte[32]" }, { type: "byte[32]" },
    ], returns: { type: "void" } },
    { name: "refundEscrow", args: [{ type: "byte[32]" }], returns: { type: "void" } },
    { name: "completeEscrow", args: [{ type: "byte[32]" }], returns: { type: "void" } },
  ],
});

const RECORD_TYPE = ABIType.from("(byte[32],address,address,uint64,uint64,uint64,uint64,uint64,string,uint8,uint8,bool)");
const RELEASE_RECORD_TYPE = ABIType.from("(uint64,byte[32],byte[32],byte[32],uint64)");
const ABI_BYTES_32 = ABIType.from("byte[32]");
const ABI_ADDRESS = ABIType.from("address");
const ABI_UINT64 = ABIType.from("uint64");
const ABI_UINT8 = ABIType.from("uint8");
const ABI_STRING = ABIType.from("string");
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const STATE = ["INVALID", "CREATED", "FUNDED", "PAUSED", "PARTIALLY_RELEASED", "REFUNDED", "COMPLETED"] as const;

export type PrepareInput = {
  action: ExecutorAction;
  commandHash: `sha256:${string}`;
  binding: EscrowBinding;
  idempotencyKey: string;
  release?: ReleaseInput;
  fabricClaimTransactionId?: string;
};

export type PreparedTransactionReconciliation =
  | { status: "PENDING"; observedRound: string }
  | { status: "EXPIRED"; observedRound: string }
  | { status: "CONFIRMED"; observedRound: string; confirmedRound: string };

export class PreparedTransactionExpiredError extends Error {
  constructor(readonly observedRound: string) {
    super("The prepared Algorand transaction expired without confirmation.");
    this.name = "PreparedTransactionExpiredError";
  }
}

export interface AlgorandChain {
  prepare(input: PrepareInput): Promise<PreparedTransaction>;
  reconcile(prepared: PreparedTransaction, expected: PrepareInput): Promise<PreparedTransactionReconciliation>;
  submit(prepared: PreparedTransaction, expected: PrepareInput): Promise<{ confirmedRound: string }>;
  assertProjection(escrow: Escrow): Promise<void>;
  getReleaseEvidence(escrow: Escrow, milestoneId: string): Promise<Omit<ReleaseEvidence, "dealId" | "milestoneId" | "transactionId" | "confirmedRound">>;
  readiness(): Promise<boolean>;
}

function boxName(prefix: string, key: Uint8Array): Uint8Array {
  return Uint8Array.from([prefix.charCodeAt(0), ...key]);
}

function releaseBoxKey(dealKey: Uint8Array, milestoneKey: Uint8Array): Uint8Array {
  return createHash("sha256").update(dealKey).update(milestoneKey).digest();
}

function abiByteArray(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) return value;
  if (!Array.isArray(value) || value.some((item) => !Number.isInteger(item) || item < 0 || item > 255)) {
    return undefined;
  }
  return Uint8Array.from(value as number[]);
}

function safeParams(params: algosdk.SuggestedParams, config: ExecutorConfig, innerTransactions = 0): algosdk.SuggestedParams {
  const minFee = BigInt(params.minFee);
  const first = BigInt(params.firstValid);
  const networkLast = BigInt(params.lastValid);
  const boundedLast = first + BigInt(config.ALGORAND_MAX_VALIDITY_ROUNDS);
  const fee = minFee * BigInt(1 + innerTransactions);
  if (minFee <= 0n || fee > BigInt(config.ALGORAND_MAX_TRANSACTION_FEE_MICROALGOS)) {
    throw conflict("Algod suggested a transaction fee outside the configured microAlgo cap.");
  }
  return {
    ...params,
    flatFee: true,
    fee,
    lastValid: boundedLast < networkLast ? boundedLast : networkLast,
  };
}

export function preparedCommandBinding(input: PrepareInput): `sha256:${string}` {
  return sha256({
    schemaVersion: "2.0",
    commandHash: input.commandHash,
    action: input.action,
    binding: input.binding,
    idempotencyKey: input.idempotencyKey,
    release: input.release ?? null,
    fabricClaimTransactionId: input.fabricClaimTransactionId ?? null,
  });
}

function sameBytes(left: Uint8Array | undefined, right: Uint8Array | undefined): boolean {
  return left === undefined || right === undefined
    ? left === right
    : Buffer.from(left).equals(Buffer.from(right));
}

function sameByteArrays(left: ReadonlyArray<Uint8Array>, right: ReadonlyArray<Uint8Array>): boolean {
  return left.length === right.length && left.every((value, index) => sameBytes(value, right[index]));
}

function expectedApplicationArguments(input: PrepareInput): Uint8Array[] {
  const values: Uint8Array[] = [
    CONTRACT.getMethodByName(`${input.action}Escrow`).getSelector(),
    ABI_BYTES_32.encode(digestBytes(input.binding.dealId)),
  ];
  if (input.action === "create") {
    values.push(
      ABI_BYTES_32.encode(parseSha256(input.binding.agreementHash)),
      ABI_ADDRESS.encode(input.binding.originProviderAddress),
      ABI_ADDRESS.encode(input.binding.destinationProviderAddress),
      ABI_UINT64.encode(BigInt(input.binding.amount.amountMinor)),
      ABI_STRING.encode(input.binding.amount.currency),
      ABI_UINT8.encode(input.binding.amount.scale),
    );
  } else if (input.action === "release") {
    if (!input.release || !input.fabricClaimTransactionId) throw new Error("Release command binding is incomplete.");
    values.push(
      ABI_BYTES_32.encode(digestBytes(input.release.milestoneId)),
      ABI_BYTES_32.encode(digestBytes(input.release.intentId)),
      ABI_UINT64.encode(BigInt(input.release.amountMinor)),
      ABI_BYTES_32.encode(parseSha256(input.release.bindingHash)),
      ABI_UINT64.encode(BigInt(input.release.fenceGeneration)),
      ABI_UINT64.encode(BigInt(Math.floor(Date.parse(input.release.leaseExpiresAt) / 1_000))),
      ABI_BYTES_32.encode(parseSha256(input.release.authorizationCommitment)),
      ABI_BYTES_32.encode(digestBytes(input.fabricClaimTransactionId)),
    );
  }
  return values;
}

function verifyTransactionSignature(
  signed: ReturnType<typeof algosdk.decodeSignedTransaction>,
  expectedAddress: string,
): boolean {
  if (!signed.sig || signed.sig.length !== 64 || signed.sgnr || signed.msig || signed.lsig || signed.pqsig) return false;
  const publicKey = algosdk.Address.fromString(expectedAddress).publicKey;
  const key = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKey)]),
    format: "der",
    type: "spki",
  });
  return verifySignature(null, signed.txn.bytesToSign(), key, signed.sig);
}

function expectedBoxNames(input: PrepareInput): Uint8Array[] {
  const dealKey = digestBytes(input.binding.dealId);
  const names = [boxName("e", dealKey)];
  if (input.action === "release") {
    if (!input.release) throw new Error("Release command binding is incomplete.");
    const milestoneKey = digestBytes(input.release.milestoneId);
    names.push(
      boxName("r", releaseBoxKey(dealKey, milestoneKey)),
      boxName("f", digestBytes(input.release.intentId)),
    );
  }
  return names;
}

function assertExpectedInput(input: PrepareInput, config: ExecutorConfig): void {
  const binding = escrowBindingSchema.safeParse(input.binding);
  const commandHashValid = hashSchema.safeParse(input.commandHash).success;
  const idempotencyValid = idempotencyKeySchema.safeParse(input.idempotencyKey).success;
  const deploymentMatches = binding.success
    && binding.data.network === config.ALGORAND_NETWORK
    && binding.data.genesisHash === config.ALGORAND_GENESIS_HASH
    && binding.data.applicationId === config.ALGORAND_APPLICATION_ID.toString()
    && BigInt(binding.data.assetId) === config.ALGORAND_ASSET_ID
    && binding.data.originProviderAddress === config.ALGORAND_ORIGIN_PROVIDER_TREASURY_ADDRESS;
  const releaseMatches = input.action === "release"
    ? input.release !== undefined
      && releaseInputSchema.safeParse(input.release).success
      && input.fabricClaimTransactionId === input.release.fabricClaimTransactionId
      && sha256(input.release.escrowBinding) === sha256(input.binding)
    : input.release === undefined && input.fabricClaimTransactionId === undefined;
  if (!commandHashValid || !idempotencyValid || !deploymentMatches || !releaseMatches) {
    throw conflict("The expected Algorand command binding is invalid or targets another deployment.");
  }
}

export class RealAlgorandChain implements AlgorandChain {
  readonly #algod: algosdk.Algodv2;
  readonly #signer: algosdk.TransactionSigner;
  readonly #account: algosdk.Account;
  readonly #buyerSigner: algosdk.TransactionSigner;
  readonly #buyerAccount: algosdk.Account;

  constructor(private readonly config: ExecutorConfig) {
    this.#algod = new algosdk.Algodv2(
      new BoundedAlgodHttpClient(config.ALGORAND_ALGOD_URL, config.ALGORAND_ALGOD_TOKEN, config.ALGORAND_REQUEST_TIMEOUT_MS),
      "",
    );
    this.#account = {
      addr: algosdk.Address.fromString(config.ALGORAND_SIGNER_ADDRESS),
      sk: config.signerPrivateKey,
    };
    this.#signer = algosdk.makeBasicAccountTransactionSigner(this.#account);
    this.#buyerAccount = {
      addr: algosdk.Address.fromString(config.ALGORAND_ORIGIN_PROVIDER_TREASURY_ADDRESS),
      sk: config.originProviderTreasuryPrivateKey,
    };
    this.#buyerSigner = algosdk.makeBasicAccountTransactionSigner(this.#buyerAccount);
  }

  async prepare(input: PrepareInput): Promise<PreparedTransaction> {
    assertExpectedInput(input, this.config);
    if (input.binding.originProviderAddress !== this.config.ALGORAND_ORIGIN_PROVIDER_TREASURY_ADDRESS) {
      throw conflict("The escrow buyer does not match the configured buyer treasury signer.");
    }
    if (input.action === "release") {
      if (!input.release || !input.fabricClaimTransactionId
        || input.release.fabricClaimTransactionId !== input.fabricClaimTransactionId) {
        throw conflict("Release authorization is missing or conflicts with the signed command.");
      }
      const remainingMs = Date.parse(input.release.leaseExpiresAt) - Date.now();
      if (remainingMs <= this.config.ALGORAND_RELEASE_SAFETY_MARGIN_SECONDS * 1_000) {
        throw conflict("The Fabric release lease cannot fit the configured Algorand confirmation safety margin.");
      }
    } else if (input.release !== undefined || input.fabricClaimTransactionId !== undefined) {
      throw conflict("Only a release command may carry release authorization fields.");
    }
    const params = await this.#algod.getTransactionParams().do();
    this.assertAlgodGenesis(params.genesisHash);
    const dealKey = digestBytes(input.binding.dealId);
    const appId = this.config.ALGORAND_APPLICATION_ID;
    const boxes: algosdk.BoxReference[] = [{ appIndex: appId, name: boxName("e", dealKey) }];
    const atc = new AtomicTransactionComposer();
    const methodArgs: algosdk.ABIArgument[] = [dealKey];
    const accounts: string[] = [];
    const assets: bigint[] = [this.config.ALGORAND_ASSET_ID];
    let innerTransactions = 0;

    switch (input.action) {
      case "create":
        methodArgs.push(
          parseSha256(input.binding.agreementHash),
          input.binding.originProviderAddress,
          input.binding.destinationProviderAddress,
          BigInt(input.binding.amount.amountMinor),
          input.binding.amount.currency,
          input.binding.amount.scale,
        );
        break;
      case "fund": {
        const funding = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
          sender: this.#buyerAccount.addr,
          receiver: algosdk.getApplicationAddress(appId),
          amount: BigInt(input.binding.amount.amountMinor),
          assetIndex: this.config.ALGORAND_ASSET_ID,
          suggestedParams: safeParams(params, this.config),
        });
        methodArgs.push({ txn: funding, signer: this.#buyerSigner });
        break;
      }
      case "release": {
        if (!input.release || !input.fabricClaimTransactionId) throw conflict("Release authorization is missing.");
        const milestoneKey = digestBytes(input.release.milestoneId);
        const intentKey = digestBytes(input.release.intentId);
        const releaseKey = releaseBoxKey(dealKey, milestoneKey);
        boxes.push(
          { appIndex: appId, name: boxName("r", releaseKey) },
          { appIndex: appId, name: boxName("f", intentKey) },
        );
        methodArgs.push(
          milestoneKey,
          intentKey,
          BigInt(input.release.amountMinor),
          parseSha256(input.release.bindingHash),
          BigInt(input.release.fenceGeneration),
          BigInt(Math.floor(Date.parse(input.release.leaseExpiresAt) / 1_000)),
          parseSha256(input.release.authorizationCommitment),
          digestBytes(input.fabricClaimTransactionId),
        );
        accounts.push(input.binding.destinationProviderAddress);
        innerTransactions = 1;
        break;
      }
      case "refund":
        accounts.push(input.binding.originProviderAddress);
        innerTransactions = 1;
        break;
      case "pause":
      case "resume":
      case "complete":
        break;
    }

    atc.addMethodCall({
      appID: appId,
      method: CONTRACT.getMethodByName(`${input.action}Escrow`),
      methodArgs,
      sender: this.#account.addr,
      signer: this.#signer,
      suggestedParams: safeParams(params, this.config, innerTransactions),
      boxes,
      appAccounts: accounts,
      appForeignAssets: assets,
      lease: digestBytes(`anchor-executor:${input.idempotencyKey}`),
    });
    const group = atc.buildGroup();
    const txIds = group.map(({ txn }) => txn.txID());
    const groupFee = group.reduce((total, { txn }) => total + txn.fee, 0n);
    if (groupFee > BigInt(this.config.ALGORAND_MAX_GROUP_FEE_MICROALGOS)) {
      throw conflict("Algod suggested a transaction group fee outside the configured microAlgo cap.");
    }
    const signed = await atc.gatherSignatures();
    const transactionId = txIds.at(-1);
    const lastValidRound = group.reduce((minimum, item) => item.txn.lastValid < minimum ? item.txn.lastValid : minimum, group[0]!.txn.lastValid);
    if (!transactionId) throw unavailable("Algorand command produced no transaction.");
    return {
      schemaVersion: "2.0",
      commandHash: input.commandHash,
      commandBindingHash: preparedCommandBinding(input),
      transactionId,
      transactionIds: txIds,
      signedTransactionsBase64: signed.map((bytes) => Buffer.from(bytes).toString("base64")),
      lastValidRound: lastValidRound.toString(),
    };
  }

  async submit(prepared: PreparedTransaction, expected: PrepareInput): Promise<{ confirmedRound: string }> {
    this.assertPreparedIntegrity(prepared, expected);
    const existing = await this.reconcile(prepared, expected);
    if (existing.status === "CONFIRMED") return { confirmedRound: existing.confirmedRound };
    if (existing.status === "EXPIRED") throw new PreparedTransactionExpiredError(existing.observedRound);
    const signed = prepared.signedTransactionsBase64.map((item) => Buffer.from(item, "base64"));
    try {
      await this.#algod.sendRawTransaction(signed).do();
    } catch {
      const reconciled = await this.reconcile(prepared, expected);
      if (reconciled.status === "CONFIRMED") return { confirmedRound: reconciled.confirmedRound };
      if (reconciled.status === "EXPIRED") throw new PreparedTransactionExpiredError(reconciled.observedRound);
      throw unavailable("Algorand submission was ambiguous; the same prepared command must be reconciled.");
    }
    let confirmation: Awaited<ReturnType<typeof algosdk.waitForConfirmation>>;
    try {
      confirmation = await algosdk.waitForConfirmation(
        this.#algod,
        prepared.transactionId,
        this.config.ALGORAND_CONFIRMATION_ROUNDS + this.config.ALGORAND_MAX_VALIDITY_ROUNDS,
      );
    } catch {
      const reconciled = await this.reconcile(prepared, expected);
      if (reconciled.status === "CONFIRMED") return { confirmedRound: reconciled.confirmedRound };
      if (reconciled.status === "EXPIRED") throw new PreparedTransactionExpiredError(reconciled.observedRound);
      throw unavailable("Algorand confirmation was ambiguous; the same prepared command must be reconciled.");
    }
    if (!confirmation.confirmedRound || confirmation.confirmedRound <= 0n) throw unavailable("Algorand did not confirm the transaction.");
    return this.waitDepth(confirmation.confirmedRound);
  }

  async reconcile(prepared: PreparedTransaction, expected: PrepareInput): Promise<PreparedTransactionReconciliation> {
    this.assertPreparedIntegrity(prepared, expected);
    let observedRound: bigint;
    try {
      const [status, params] = await Promise.all([
        this.#algod.status().do(),
        this.#algod.getTransactionParams().do(),
      ]);
      this.assertAlgodGenesis(params.genesisHash);
      observedRound = status.lastRound;
    } catch {
      throw unavailable("Algorand round evidence is unavailable; the prepared command remains active.");
    }
    // Query transaction evidence after the status snapshot. If the node has
    // already committed lastValidRound and still has no confirmation, the
    // signed transaction can no longer enter a later block.
    let confirmedRound = await this.pendingStrict(prepared.transactionId);
    let validityWindowScanned = false;
    if (confirmedRound === null && observedRound >= BigInt(prepared.lastValidRound)) {
      // Algod may forget sufficiently old committed transactions. Absence from
      // pendingTransactionInformation is therefore not terminal evidence. Scan
      // every block in the signed validity window before releasing the payment
      // fence; any unavailable block keeps the command active.
      confirmedRound = await this.confirmedRoundFromValidityWindow(prepared);
      validityWindowScanned = true;
    }
    const classified = classifyPreparedTransaction(
      prepared.lastValidRound,
      observedRound,
      confirmedRound,
      validityWindowScanned,
    );
    if (classified.status !== "CONFIRMED") return classified;
    const confirmed = await this.waitDepth(BigInt(classified.confirmedRound));
    return { ...classified, confirmedRound: confirmed.confirmedRound };
  }

  private assertPreparedIntegrity(prepared: PreparedTransaction, expected: PrepareInput): void {
    try {
      assertExpectedInput(expected, this.config);
      const expectedCount = expected.action === "fund" ? 2 : 1;
      if (prepared.schemaVersion !== "2.0"
        || prepared.commandHash !== expected.commandHash
        || prepared.commandBindingHash !== preparedCommandBinding(expected)
        || prepared.signedTransactionsBase64.length !== expectedCount
        || prepared.transactionIds.length !== expectedCount
        || prepared.signedTransactionsBase64.some((item) => Buffer.from(item, "base64").toString("base64") !== item)) {
        throw new Error("prepared envelope mismatch");
      }

      const signed = prepared.signedTransactionsBase64
        .map((item) => algosdk.decodeSignedTransaction(Buffer.from(item, "base64")));
      const transactions = signed.map(({ txn }) => txn);
      const appCall = transactions.at(-1);
      const application = appCall?.applicationCall;
      const funding = expected.action === "fund" ? transactions[0] : undefined;
      const fundingFields = funding?.assetTransfer;
      if (!appCall || !application
        || appCall.type !== algosdk.TransactionType.appl
        || appCall.sender.toString() !== this.config.ALGORAND_SIGNER_ADDRESS
        || !verifyTransactionSignature(signed.at(-1)!, this.config.ALGORAND_SIGNER_ADDRESS)
        || (funding !== undefined && !verifyTransactionSignature(signed[0]!, this.config.ALGORAND_ORIGIN_PROVIDER_TREASURY_ADDRESS))) {
        throw new Error("transaction signer or type mismatch");
      }

      const transactionIds = transactions.map((transaction) => transaction.txID());
      if (transactionIds.some((id, index) => prepared.transactionIds[index] !== id)
        || new Set(transactionIds).size !== transactionIds.length
        || transactionIds.at(-1) !== prepared.transactionId
        || appCall.lastValid.toString() !== prepared.lastValidRound) {
        throw new Error("transaction identity mismatch");
      }

      const configuredGenesis = Buffer.from(this.config.ALGORAND_GENESIS_HASH, "base64");
      const firstValid = appCall.firstValid;
      const lastValid = appCall.lastValid;
      const commonFieldsMatch = firstValid <= lastValid
        && lastValid - firstValid <= BigInt(this.config.ALGORAND_MAX_VALIDITY_ROUNDS)
        && transactions.every((transaction) => transaction.firstValid === firstValid
          && transaction.lastValid === lastValid
          && transaction.genesisHash !== undefined
          && Buffer.from(transaction.genesisHash).equals(configuredGenesis)
          && transaction.genesisID === appCall.genesisID
          && transaction.note.length === 0
          && transaction.rekeyTo === undefined
          && transaction.fee > 0n
          && transaction.fee <= BigInt(this.config.ALGORAND_MAX_TRANSACTION_FEE_MICROALGOS));
      if (!commonFieldsMatch) throw new Error("common transaction field mismatch");

      const expectedInnerTransactions = expected.action === "release" || expected.action === "refund" ? 1n : 0n;
      const feeDivisor = 1n + expectedInnerTransactions;
      const baseFee = appCall.fee / feeDivisor;
      const groupFee = transactions.reduce((total, transaction) => total + transaction.fee, 0n);
      if (baseFee <= 0n || appCall.fee % feeDivisor !== 0n
        || appCall.fee !== baseFee * feeDivisor
        || (funding !== undefined && funding.fee !== baseFee)
        || groupFee > BigInt(this.config.ALGORAND_MAX_GROUP_FEE_MICROALGOS)) {
        throw new Error("transaction fee mismatch");
      }

      const expectedLease = digestBytes(`anchor-executor:${expected.idempotencyKey}`);
      const expectedAccounts = expected.action === "release"
        ? [expected.binding.destinationProviderAddress]
        : expected.action === "refund" ? [expected.binding.originProviderAddress] : [];
      const expectedBoxes = expectedBoxNames(expected);
      const appFieldsMatch = application.appIndex === this.config.ALGORAND_APPLICATION_ID
        && application.appIndex.toString() === expected.binding.applicationId
        && application.onComplete === algosdk.OnApplicationComplete.NoOpOC
        && application.approvalProgram.length === 0
        && application.clearProgram.length === 0
        && application.numLocalInts === 0
        && application.numLocalByteSlices === 0
        && application.numGlobalInts === 0
        && application.numGlobalByteSlices === 0
        && application.extraPages === 0
        && application.rejectVersion === 0
        && application.access.length === 0
        && application.foreignApps.length === 0
        && application.foreignAssets.length === 1
        && application.foreignAssets[0] === this.config.ALGORAND_ASSET_ID
        && application.accounts.length === expectedAccounts.length
        && application.accounts.every((address, index) => address.toString() === expectedAccounts[index])
        && application.boxes.length === expectedBoxes.length
        && application.boxes.every((box, index) => box.appIndex === 0n && sameBytes(box.name, expectedBoxes[index]))
        && sameByteArrays(application.appArgs, expectedApplicationArguments(expected))
        && sameBytes(appCall.lease, expectedLease);
      if (!appFieldsMatch) throw new Error("application call mismatch");

      if (expected.action === "fund") {
        if (!funding || !fundingFields
          || funding.type !== algosdk.TransactionType.axfer
          || funding.sender.toString() !== this.config.ALGORAND_ORIGIN_PROVIDER_TREASURY_ADDRESS
          || fundingFields.assetIndex !== this.config.ALGORAND_ASSET_ID
          || fundingFields.amount !== BigInt(expected.binding.amount.amountMinor)
          || fundingFields.receiver.toString() !== algosdk.getApplicationAddress(this.config.ALGORAND_APPLICATION_ID).toString()
          || fundingFields.assetSender !== undefined
          || fundingFields.closeRemainderTo !== undefined
          || funding.lease !== undefined) {
          throw new Error("funding transfer mismatch");
        }
        const ungrouped = transactions.map((transaction) => {
          const encoding = transaction.toEncodingData();
          encoding.delete("grp");
          return algosdk.Transaction.fromEncodingData(encoding);
        });
        const expectedGroup = algosdk.computeGroupID(ungrouped);
        if (transactions.some((transaction) => !sameBytes(transaction.group, expectedGroup))) {
          throw new Error("atomic group mismatch");
        }
      } else if (transactions.some((transaction) => transaction.group !== undefined)) {
        throw new Error("single transaction unexpectedly grouped");
      }
    } catch {
      throw conflict("Persisted Algorand transaction evidence is not bound to the expected authorized command.");
    }
  }

  private assertAlgodGenesis(genesisHash: Uint8Array | undefined): void {
    const configuredGenesis = Buffer.from(this.config.ALGORAND_GENESIS_HASH, "base64");
    if (!genesisHash || !Buffer.from(genesisHash).equals(configuredGenesis)) {
      throw conflict("Algod is connected to a different genesis hash.");
    }
  }

  async assertProjection(escrow: Escrow): Promise<void> {
    const dealKey = digestBytes(escrow.dealId);
    let response: Awaited<ReturnType<ReturnType<algosdk.Algodv2["getApplicationBoxByName"]>["do"]>>;
    try {
      response = await this.#algod.getApplicationBoxByName(
        this.config.ALGORAND_APPLICATION_ID,
        boxName("e", dealKey),
      ).do();
    } catch {
      throw unavailable("The on-chain escrow box is unavailable.");
    }
    const raw = RECORD_TYPE.decode(response.value);
    if (!Array.isArray(raw) || raw.length !== 12) throw unavailable("The on-chain escrow record is malformed.");
    const [agreement, buyer, seller, asset, total, locked, released, refunded, currency, scale, state] = raw;
    const agreementBytes = abiByteArray(agreement);
    const stateName = typeof state === "bigint" ? STATE[Number(state)] : undefined;
    const originProviderAddress = typeof buyer === "string"
      ? buyer
      : buyer instanceof algosdk.Address ? buyer.toString() : undefined;
    const destinationProviderAddress = typeof seller === "string"
      ? seller
      : seller instanceof algosdk.Address ? seller.toString() : undefined;
    const mismatches = [
      !agreementBytes
        || Buffer.from(agreementBytes).toString("hex") !== escrow.agreementHash.slice(7) ? "agreement" : null,
      originProviderAddress !== escrow.originProviderAddress ? "buyer" : null,
      destinationProviderAddress !== escrow.destinationProviderAddress ? "seller" : null,
      asset !== BigInt(escrow.assetId) ? "asset" : null,
      total !== BigInt(escrow.amount.amountMinor) ? "total" : null,
      locked !== BigInt(escrow.lockedMinor) ? "locked" : null,
      released !== BigInt(escrow.releasedMinor) ? "released" : null,
      refunded !== BigInt(escrow.refundedMinor) ? "refunded" : null,
      currency !== escrow.amount.currency ? "currency" : null,
      scale !== BigInt(escrow.amount.scale) ? "scale" : null,
      stateName !== escrow.state ? "state" : null,
    ].filter((value): value is string => value !== null);
    if (mismatches.length > 0) {
      throw conflict(`The durable escrow projection does not match on-chain state (${mismatches.join(",")}).`);
    }
  }

  async getReleaseEvidence(
    escrow: Escrow,
    milestoneId: string,
  ): Promise<Omit<ReleaseEvidence, "dealId" | "milestoneId" | "transactionId" | "confirmedRound">> {
    const dealKey = digestBytes(escrow.dealId);
    const milestoneKey = digestBytes(milestoneId);
    let response: Awaited<ReturnType<ReturnType<algosdk.Algodv2["getApplicationBoxByName"]>["do"]>>;
    try {
      response = await this.#algod.getApplicationBoxByName(
        this.config.ALGORAND_APPLICATION_ID,
        boxName("r", releaseBoxKey(dealKey, milestoneKey)),
      ).do();
    } catch {
      throw unavailable("The on-chain milestone release evidence is unavailable.");
    }
    const raw = RELEASE_RECORD_TYPE.decode(response.value);
    if (!Array.isArray(raw) || raw.length !== 5) throw unavailable("The on-chain milestone release evidence is malformed.");
    const [amount, binding, commitment, fabricTransaction, generation] = raw;
    const bindingBytes = abiByteArray(binding);
    const commitmentBytes = abiByteArray(commitment);
    const fabricTransactionBytes = abiByteArray(fabricTransaction);
    if (typeof amount !== "bigint" || !bindingBytes || !commitmentBytes
      || !fabricTransactionBytes || typeof generation !== "bigint"
      || generation < 1n || generation > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw unavailable("The on-chain milestone release evidence is malformed.");
    }
    return {
      amountMinor: amount.toString(),
      bindingHash: `sha256:${Buffer.from(bindingBytes).toString("hex")}`,
      fenceGeneration: Number(generation),
      authorizationCommitment: `sha256:${Buffer.from(commitmentBytes).toString("hex")}`,
      fabricClaimTransactionHash: `sha256:${Buffer.from(fabricTransactionBytes).toString("hex")}`,
    };
  }

  async readiness(): Promise<boolean> {
    try {
      const [params, app, asset, signer, buyer, holding, buyerHolding] = await Promise.all([
        this.#algod.getTransactionParams().do(),
        this.#algod.getApplicationByID(this.config.ALGORAND_APPLICATION_ID).do(),
        this.#algod.getAssetByID(this.config.ALGORAND_ASSET_ID).do(),
        this.#algod.accountInformation(this.config.ALGORAND_SIGNER_ADDRESS).do(),
        this.#algod.accountInformation(this.config.ALGORAND_ORIGIN_PROVIDER_TREASURY_ADDRESS).do(),
        this.#algod.accountAssetInformation(algosdk.getApplicationAddress(this.config.ALGORAND_APPLICATION_ID), this.config.ALGORAND_ASSET_ID).do(),
        this.#algod.accountAssetInformation(this.config.ALGORAND_ORIGIN_PROVIDER_TREASURY_ADDRESS, this.config.ALGORAND_ASSET_ID).do(),
      ]);
      return Buffer.from(params.genesisHash ?? []).toString("base64") === this.config.ALGORAND_GENESIS_HASH
        && app.id === this.config.ALGORAND_APPLICATION_ID
        && asset.index === this.config.ALGORAND_ASSET_ID
        && signer.address.toString() === this.config.ALGORAND_SIGNER_ADDRESS
        && buyer.address.toString() === this.config.ALGORAND_ORIGIN_PROVIDER_TREASURY_ADDRESS
        && holding.assetHolding?.assetId === this.config.ALGORAND_ASSET_ID
        && buyerHolding.assetHolding?.assetId === this.config.ALGORAND_ASSET_ID;
    } catch {
      return false;
    }
  }

  private async pendingStrict(transactionId: string): Promise<bigint | null> {
    try {
      const response = await this.#algod.pendingTransactionInformation(transactionId).do();
      return response.confirmedRound && response.confirmedRound > 0n ? response.confirmedRound : null;
    } catch (error) {
      if (error instanceof BoundedHttpError && error.response.status === 404) return null;
      throw unavailable("Algorand transaction evidence is unavailable; the prepared command remains active.");
    }
  }

  private async confirmedRoundFromValidityWindow(prepared: PreparedTransaction): Promise<bigint | null> {
    const decoded = prepared.signedTransactionsBase64
      .map((item) => algosdk.decodeSignedTransaction(Buffer.from(item, "base64")).txn);
    const firstValid = decoded.reduce(
      (maximum, transaction) => transaction.firstValid > maximum ? transaction.firstValid : maximum,
      decoded[0]!.firstValid,
    );
    const lastValid = BigInt(prepared.lastValidRound);
    if (firstValid > lastValid || lastValid - firstValid > BigInt(this.config.ALGORAND_MAX_VALIDITY_ROUNDS)) {
      throw conflict("Persisted Algorand transaction validity evidence failed integrity checks.");
    }
    try {
      for (let round = firstValid; round <= lastValid; round += 1n) {
        const block = await this.#algod.getBlockTxids(round).do();
        if (block.blocktxids.includes(prepared.transactionId)) return round;
      }
    } catch {
      throw unavailable("Algorand validity-window block evidence is unavailable; the prepared command remains active.");
    }
    return null;
  }

  private async waitDepth(confirmedRound: bigint): Promise<{ confirmedRound: string }> {
    const target = confirmedRound + BigInt(this.config.ALGORAND_CONFIRMATION_ROUNDS - 1);
    // Public algod gateways commonly terminate a single long-poll before a
    // large confirmation-depth target is reached (for example with HTTP 504).
    // Advance through bounded checkpoints instead. Each successful checkpoint
    // proves monotonic progress and the loop has an exact finite upper bound.
    const checkpointSize = 4n;
    for (let checkpoint = confirmedRound + checkpointSize; checkpoint < target; checkpoint += checkpointSize) {
      await this.waitCheckpoint(checkpoint);
    }
    if (target > confirmedRound) await this.waitCheckpoint(target);
    return { confirmedRound: confirmedRound.toString() };
  }

  private async waitCheckpoint(round: bigint): Promise<void> {
    const transientStatuses = new Set([408, 425, 429, 500, 502, 503, 504]);
    const attempts = 3;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await this.#algod.statusAfterBlock(round).do();
        return;
      } catch (error) {
        const retryable = error instanceof BoundedHttpError && transientStatuses.has(error.response.status);
        if (!retryable || attempt === attempts) {
          throw unavailable("Algorand confirmation-depth evidence is temporarily unavailable; settlement remains pending.");
        }
      }
    }
  }
}

export function classifyPreparedTransaction(
  lastValidRound: string,
  observedRound: bigint,
  confirmedRound: bigint | null,
  validityWindowScanned = false,
): PreparedTransactionReconciliation {
  if (confirmedRound !== null && confirmedRound > 0n) {
    return {
      status: "CONFIRMED",
      observedRound: observedRound.toString(),
      confirmedRound: confirmedRound.toString(),
    };
  }
  return observedRound >= BigInt(lastValidRound) && validityWindowScanned
    ? { status: "EXPIRED", observedRound: observedRound.toString() }
    : { status: "PENDING", observedRound: observedRound.toString() };
}

export function nextProjection(
  action: ExecutorAction,
  binding: EscrowBinding,
  prior: Escrow | null,
  transactionId: string,
  release?: ReleaseInput,
): Escrow {
  if (action === "create") {
    if (prior) throw conflict("The escrow already exists.");
    return escrowSchema.parse({
      ...binding,
      lockedMinor: "0",
      releasedMinor: "0",
      refundedMinor: "0",
      state: "CREATED",
      createTxId: transactionId,
      fundTxId: null,
      refundTxId: null,
      releases: {},
    });
  }
  if (!prior) throw conflict("The escrow does not exist.");
  const result = structuredClone(prior);
  switch (action) {
    case "fund":
      if (result.state !== "CREATED") throw conflict("Only a created escrow can be funded.");
      result.lockedMinor = result.amount.amountMinor;
      result.fundTxId = transactionId;
      result.state = "FUNDED";
      break;
    case "pause":
      if (result.state !== "FUNDED" && result.state !== "PARTIALLY_RELEASED") throw conflict("The escrow cannot be paused.");
      result.state = "PAUSED";
      break;
    case "resume":
      if (result.state !== "PAUSED") throw conflict("The escrow cannot be resumed.");
      result.state = BigInt(result.releasedMinor) > 0n ? "PARTIALLY_RELEASED" : "FUNDED";
      break;
    case "release": {
      if (!release || (result.state !== "FUNDED" && result.state !== "PARTIALLY_RELEASED")) throw conflict("The escrow cannot be released.");
      if (result.releases[release.milestoneId]) throw conflict("The milestone was already released.");
      const amount = BigInt(release.amountMinor);
      if (amount <= 0n || amount > BigInt(result.lockedMinor)) throw conflict("The release amount exceeds locked funds.");
      result.lockedMinor = (BigInt(result.lockedMinor) - amount).toString();
      result.releasedMinor = (BigInt(result.releasedMinor) + amount).toString();
      result.releases[release.milestoneId] = { amountMinor: release.amountMinor, transactionId };
      result.state = result.lockedMinor === "0" ? "COMPLETED" : "PARTIALLY_RELEASED";
      break;
    }
    case "refund":
      if (!["FUNDED", "PARTIALLY_RELEASED", "PAUSED"].includes(result.state)) throw conflict("The escrow cannot be refunded.");
      result.refundedMinor = result.lockedMinor;
      result.lockedMinor = "0";
      result.refundTxId = transactionId;
      result.state = "REFUNDED";
      break;
    case "complete":
      if (result.lockedMinor !== "0" || !["COMPLETED", "REFUNDED"].includes(result.state)) throw conflict("The escrow is not terminal.");
      break;
  }
  return escrowSchema.parse(result);
}
