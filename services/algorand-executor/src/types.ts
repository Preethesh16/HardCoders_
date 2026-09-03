import algosdk from "algosdk";
import { z } from "zod";

import { sha256 } from "./canonical.js";

const UINT64_MAX = (1n << 64n) - 1n;
export const actionSchema = z.enum(["create", "fund", "release", "pause", "resume", "refund", "complete"]);
export type ExecutorAction = z.infer<typeof actionSchema>;

export const canonicalIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
export const idempotencyKeySchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/u);
export const hashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
export const uint64StringSchema = z.string().regex(/^(?:0|[1-9][0-9]{0,19})$/u)
  .refine((value) => BigInt(value) <= UINT64_MAX, "Value exceeds uint64.");
export const positiveUint64StringSchema = uint64StringSchema.refine((value) => value !== "0", "Value must be positive.");
export const algorandAddressSchema = z.string().refine((value) => algosdk.isValidAddress(value), "Invalid Algorand address.");
export const transactionIdSchema = z.string().regex(/^[A-Z2-7]{52}$/u);

export const moneySchema = z.object({
  amountMinor: positiveUint64StringSchema,
  currency: z.string().min(3).max(12).regex(/^[A-Z][A-Z0-9-]*$/u),
  scale: z.number().int().min(0).max(8),
}).strict();

export const escrowExpectationSchema = z.object({
  dealId: canonicalIdSchema,
  agreementHash: hashSchema,
  originProviderAddress: algorandAddressSchema,
  destinationProviderAddress: algorandAddressSchema,
  assetId: z.number().int().positive().safe(),
  amount: moneySchema,
}).strict().superRefine((value, context) => {
  if (value.originProviderAddress === value.destinationProviderAddress) {
    context.addIssue({ code: "custom", message: "Origin and destination provider addresses must differ." });
  }
});
export type EscrowExpectation = z.infer<typeof escrowExpectationSchema>;

export const escrowBindingSchema = escrowExpectationSchema.and(z.object({
  network: z.enum(["localnet", "testnet"]),
  genesisHash: z.string().min(16).max(256),
  applicationId: positiveUint64StringSchema,
}).strict());
export type EscrowBinding = z.infer<typeof escrowBindingSchema>;

const releaseEntrySchema = z.object({
  amountMinor: positiveUint64StringSchema,
  transactionId: transactionIdSchema,
}).strict();

export const escrowSchema = escrowBindingSchema.and(z.object({
  lockedMinor: uint64StringSchema,
  releasedMinor: uint64StringSchema,
  refundedMinor: uint64StringSchema,
  state: z.enum(["CREATED", "FUNDED", "PAUSED", "PARTIALLY_RELEASED", "REFUNDED", "COMPLETED"]),
  createTxId: transactionIdSchema,
  fundTxId: transactionIdSchema.nullable(),
  refundTxId: transactionIdSchema.nullable(),
  releases: z.record(canonicalIdSchema, releaseEntrySchema),
}).strict()).superRefine((escrow, context) => {
  const total = BigInt(escrow.amount.amountMinor);
  const locked = BigInt(escrow.lockedMinor);
  const released = BigInt(escrow.releasedMinor);
  const refunded = BigInt(escrow.refundedMinor);
  const entries = Object.values(escrow.releases).reduce((sum, item) => sum + BigInt(item.amountMinor), 0n);
  const issue = (message: string) => context.addIssue({ code: "custom", message });
  if (entries !== released) issue("Release entries do not equal releasedMinor.");
  if (escrow.state === "CREATED") {
    if (locked !== 0n || released !== 0n || refunded !== 0n || escrow.fundTxId !== null) issue("Created accounting is invalid.");
    return;
  }
  if (locked + released + refunded !== total || escrow.fundTxId === null) issue("Funded accounting is not conserved.");
  if (escrow.state === "FUNDED" && (locked !== total || released !== 0n || refunded !== 0n)) issue("Funded accounting is invalid.");
  if (escrow.state === "PARTIALLY_RELEASED" && (locked <= 0n || released <= 0n || refunded !== 0n)) issue("Partial accounting is invalid.");
  if (escrow.state === "PAUSED" && locked <= 0n) issue("Paused escrow has no locked value.");
  if (escrow.state === "COMPLETED" && (locked !== 0n || released !== total || refunded !== 0n)) issue("Completed accounting is invalid.");
  if (escrow.state === "REFUNDED" && (locked !== 0n || refunded <= 0n || escrow.refundTxId === null)) issue("Refund accounting is invalid.");
});
export type Escrow = z.infer<typeof escrowSchema>;

export const releaseInputSchema = z.object({
  escrowBinding: escrowBindingSchema,
  milestoneId: canonicalIdSchema,
  amountMinor: positiveUint64StringSchema,
  intentId: canonicalIdSchema,
  bindingHash: hashSchema,
  fenceGeneration: z.number().int().positive().safe(),
  leaseExpiresAt: z.string().datetime({ offset: true }),
  authorizationCommitment: hashSchema,
  fabricClaimTransactionId: canonicalIdSchema,
}).strict();
export type ReleaseInput = z.infer<typeof releaseInputSchema>;

export const releaseResultSchema = z.object({
  escrow: escrowSchema,
  transactionId: transactionIdSchema,
  replay: z.boolean(),
}).strict();
export type ReleaseResult = z.infer<typeof releaseResultSchema>;

export const commandReadSchema = z.object({
  path: z.string().min(1).max(512).regex(/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/u),
  dataHash: hashSchema,
}).strict();

const permitBase = z.object({
  iss: z.string().min(1).max(256),
  aud: z.union([z.string().min(1).max(256), z.array(z.string().min(1).max(256)).min(1).max(4)]),
  sub: z.literal("optiwork-payments"),
  jti: canonicalIdSchema,
  iat: z.number().int().positive(),
  nbf: z.number().int().positive().optional(),
  exp: z.number().int().positive(),
  schemaVersion: z.literal("1.0"),
  action: actionSchema,
  method: z.literal("POST"),
  path: z.string().min(1).max(512),
  idempotencyKey: idempotencyKeySchema,
  commandHash: hashSchema,
  fabricTransactionId: canonicalIdSchema,
  authoritativeReads: z.array(commandReadSchema).min(1).max(4),
});

const releaseAuthorizationSchema = z.object({
  escrowBinding: escrowBindingSchema,
  milestoneId: canonicalIdSchema,
  amountMinor: positiveUint64StringSchema,
  intentId: canonicalIdSchema,
  bindingHash: hashSchema,
  fenceGeneration: z.number().int().positive().safe(),
  leaseExpiresAt: z.string().datetime({ offset: true }),
  authorizationCommitment: hashSchema,
  fabricClaimTransactionId: canonicalIdSchema,
}).strict();

export const permitClaimsSchema = z.discriminatedUnion("action", [
  permitBase.extend({ action: z.literal("release"), releaseAuthorization: releaseAuthorizationSchema }).strict(),
  permitBase.extend({ action: z.enum(["create", "fund", "pause", "resume", "refund", "complete"]), releaseAuthorization: z.never().optional() }).strict(),
]);
export type PermitClaims = z.infer<typeof permitClaimsSchema>;

export type CommandContext = {
  action: ExecutorAction;
  method: "POST";
  path: string;
  idempotencyKey: string;
  body: unknown;
};

export const commandReconciliationSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("NOT_FOUND"),
    idempotencyKey: idempotencyKeySchema,
  }).strict(),
  z.object({
    status: z.literal("PENDING"),
    idempotencyKey: idempotencyKeySchema,
    action: actionSchema,
  }).strict(),
  z.object({
    status: z.literal("CANCELLED"),
    idempotencyKey: idempotencyKeySchema,
    action: z.literal("release"),
    leaseExpiresAt: z.string().datetime({ offset: true }),
    cancelledAt: z.string().datetime({ offset: true }),
  }).strict(),
  z.object({
    status: z.literal("PREPARED"),
    idempotencyKey: idempotencyKeySchema,
    action: actionSchema,
    transactionId: transactionIdSchema,
    lastValidRound: positiveUint64StringSchema,
    observedRound: uint64StringSchema,
  }).strict(),
  z.object({
    status: z.literal("EXPIRED"),
    idempotencyKey: idempotencyKeySchema,
    action: actionSchema,
    transactionId: transactionIdSchema,
    lastValidRound: positiveUint64StringSchema,
    observedRound: positiveUint64StringSchema,
  }).strict(),
  z.object({
    status: z.literal("CONFIRMED"),
    idempotencyKey: idempotencyKeySchema,
    action: actionSchema,
    transactionId: transactionIdSchema,
    confirmedRound: positiveUint64StringSchema,
  }).strict(),
]);
export type CommandReconciliation = z.infer<typeof commandReconciliationSchema>;

export type CommandEvidence = {
  idempotencyKey: string;
  action: ExecutorAction;
  transactionId: string;
  confirmedRound: string;
  replay: boolean;
};

export const releaseEvidenceSchema = z.object({
  dealId: canonicalIdSchema,
  milestoneId: canonicalIdSchema,
  amountMinor: positiveUint64StringSchema,
  transactionId: transactionIdSchema,
  confirmedRound: positiveUint64StringSchema,
  bindingHash: hashSchema,
  fenceGeneration: z.number().int().positive().safe(),
  authorizationCommitment: hashSchema,
  fabricClaimTransactionHash: hashSchema,
}).strict();
export type ReleaseEvidence = z.infer<typeof releaseEvidenceSchema>;

export const readinessSchema = z.object({
  status: z.literal("ready"),
  network: z.enum(["localnet", "testnet"]),
  genesisHash: z.string().min(16).max(256),
  applicationId: z.number().int().positive().safe(),
  assetId: z.number().int().positive().safe(),
  signerAddress: algorandAddressSchema,
  originProviderTreasuryAddress: algorandAddressSchema,
  confirmationRounds: z.number().int().positive().max(1_000),
  capabilities: z.object({
    create: z.literal(true),
    fund: z.literal(true),
    release: z.literal(true),
    pause: z.literal(true),
    resume: z.literal(true),
    refund: z.literal(true),
    complete: z.literal(true),
    confirmedTransactions: z.literal(true),
    durableIdempotency: z.literal(true),
    signedFabricPermits: z.literal(true),
    authoritativeFabricReread: z.literal(true),
  }).strict(),
}).strict();

export function commandHash(context: CommandContext): `sha256:${string}` {
  return sha256({
    schemaVersion: "1.0",
    action: context.action,
    method: context.method,
    path: context.path,
    idempotencyKey: context.idempotencyKey,
    body: context.body ?? null,
  });
}

export const ALGORAND_UINT64_MAX = UINT64_MAX;
