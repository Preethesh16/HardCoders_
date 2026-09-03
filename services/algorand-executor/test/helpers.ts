import algosdk from "algosdk";

import { sha256Text } from "../src/canonical.js";
import { loadConfig, type ExecutorConfig } from "../src/config.js";
import {
  workEvidenceHash as canonicalWorkEvidenceHash,
  type FabricEvidenceReader,
  type MockFabricEvidenceReader,
  type WorkEvidence,
} from "../src/security/fabric-evidence-reader.js";
import {
  escrowBindingCommitment,
  releaseBindingCommitment,
  releaseInputSchema,
  type CommandContext,
  type PermitClaims,
  type ReleaseInput,
} from "../src/types.js";

export function testConfig(overrides: NodeJS.ProcessEnv = {}): ExecutorConfig {
  const executor = algosdk.generateAccount();
  const originTreasury = algosdk.generateAccount();
  return loadConfig({
    NODE_ENV: "test",
    UNRELATED_PROCESS_VARIABLE: "must-be-ignored",
    HOST: "127.0.0.1",
    PORT: "4301",
    LOG_LEVEL: "silent",
    EXECUTOR_BEARER_TOKEN: "executor-transport-token-test-only-0000000001",
    DATABASE_URL: "postgresql://executor:executor@127.0.0.1:5432/executor",
    DATABASE_SSL_MODE: "disable",
    DATABASE_AUTO_MIGRATE: "false",
    FABRIC_GATEWAY_URL: "http://127.0.0.1:4200",
    FABRIC_GATEWAY_BEARER_TOKEN: "fabric-reader-token-test-only",
    FABRIC_GATEWAY_TIMEOUT_MS: "1000",
    FABRIC_PERMIT_ISSUER: "test-fabric-gateway",
    FABRIC_PERMIT_AUDIENCE: "test-algorand-executor",
    FABRIC_PERMIT_PUBLIC_JWK_JSON: JSON.stringify({
      kty: "OKP", crv: "Ed25519", x: "A".repeat(43), kid: "test-permit-key", alg: "EdDSA",
    }),
    FABRIC_PERMIT_MAX_AGE_SECONDS: "60",
    ALGORAND_RELEASE_SAFETY_MARGIN_SECONDS: "30",
    ALGORAND_NETWORK: "localnet",
    ALGORAND_ALGOD_URL: "http://127.0.0.1:4001",
    ALGORAND_ALGOD_TOKEN: "localnet-token",
    ALGORAND_REQUEST_TIMEOUT_MS: "1000",
    ALGORAND_CONFIRMATION_ROUNDS: "3",
    ALGORAND_GENESIS_HASH: Buffer.alloc(32, 7).toString("base64"),
    ALGORAND_APPLICATION_ID: "7001",
    ALGORAND_ASSET_ID: "1042",
    ALGORAND_SIGNER_ADDRESS: executor.addr.toString(),
    ALGORAND_SIGNER_PRIVATE_KEY_BASE64: Buffer.from(executor.sk).toString("base64"),
    ALGORAND_ORIGIN_PROVIDER_TREASURY_ADDRESS: originTreasury.addr.toString(),
    ALGORAND_ORIGIN_PROVIDER_TREASURY_PRIVATE_KEY_BASE64: Buffer.from(originTreasury.sk).toString("base64"),
    ALGORAND_MAX_VALIDITY_ROUNDS: "20",
    ...overrides,
  });
}

export function baseClaims(command: CommandContext, nowSeconds: number): PermitClaims {
  return {
    iss: "test-fabric-gateway",
    aud: "test-algorand-executor",
    sub: "optiwork-payments",
    jti: `permit-${command.idempotencyKey}`,
    iat: nowSeconds,
    exp: nowSeconds + 20,
    schemaVersion: "1.0",
    action: command.action as Exclude<typeof command.action, "release">,
    method: "POST",
    path: command.path,
    idempotencyKey: command.idempotencyKey,
    commandHash: "sha256:" + "0".repeat(64),
    fabricTransactionId: `FABRIC-${command.idempotencyKey}`,
    authoritativeReads: [],
  } as PermitClaims;
}

/**
 * Builds a coherent release command body.
 *
 * A release is only valid when its authorization commitment is the canonical
 * hash of the complete release binding, so tests must never hand-write that
 * commitment. Individual hashes can still be overridden to prove a mismatch is
 * rejected.
 */
export type ReleaseDraft = Omit<ReleaseInput, "authorizationCommitment" | "releaseBinding" | "evidenceId"> & {
  readonly evidenceId?: string;
  readonly idempotencyKey: string;
  readonly workEvidenceHash?: string;
  readonly complianceResultHash?: string;
  readonly fxQuoteHash?: string;
};

export function releaseInput(draft: ReleaseDraft): ReleaseInput {
  const { idempotencyKey, evidenceId, workEvidenceHash, complianceResultHash, fxQuoteHash, ...rest } = draft;
  const releaseBinding = {
    escrowBindingHash: escrowBindingCommitment(rest.escrowBinding),
    workEvidenceHash: workEvidenceHash ?? `sha256:${"1".repeat(64)}`,
    fabricTxHash: sha256Text(rest.fabricClaimTransactionId),
    complianceResultHash: complianceResultHash ?? `sha256:${"2".repeat(64)}`,
    fxQuoteHash: fxQuoteHash ?? `sha256:${"3".repeat(64)}`,
    generation: rest.fenceGeneration,
    idempotencyKey,
    expiresAt: rest.leaseExpiresAt,
  };
  return releaseInputSchema.parse({
    evidenceId: evidenceId ?? "EVIDENCE-TEST-001",
    ...rest,
    releaseBinding,
    authorizationCommitment: releaseBindingCommitment(releaseBinding),
  });
}

/** Approves every re-read; suites that test rejection use MockFabricEvidenceReader. */
export function approvingEvidenceReader(): FabricEvidenceReader {
  return {
    readApprovedEvidence: async () => ({
      evidenceId: "EVIDENCE-TEST-001",
      contractHash: `sha256:${"a".repeat(64)}`,
      milestoneHash: `sha256:${"b".repeat(64)}`,
      fileHash: `sha256:${"c".repeat(64)}`,
      subjectRef: "SUBJECT-TEST-001",
      version: 1,
      submittedAt: new Date(0).toISOString(),
      buyerDecision: "APPROVED" as const,
      buyerDecisionHash: `sha256:${"d".repeat(64)}`,
      decidedAt: new Date(0).toISOString(),
      fabricTxId: "FABRIC-TEST-APPROVAL",
    }),
    readiness: async () => true,
  };
}

/** A minimal approved Fabric work-evidence projection for a release test. */
export function approvedEvidence(fabricTxId: string, overrides: Partial<WorkEvidence> = {}): WorkEvidence {
  return {
    evidenceId: `EVIDENCE-${fabricTxId}`,
    contractHash: `sha256:${"a".repeat(64)}`,
    milestoneHash: `sha256:${"b".repeat(64)}`,
    fileHash: `sha256:${"c".repeat(64)}`,
    subjectRef: "SUBJECT-DEMO-001",
    version: 1,
    submittedAt: "2026-09-01T00:00:00.000Z",
    buyerDecision: "APPROVED",
    buyerDecisionHash: `sha256:${"d".repeat(64)}`,
    decidedAt: "2026-09-02T00:00:00.000Z",
    fabricTxId,
    ...overrides,
  };
}

/** Seeds a mock reader and returns the hash a release permit must commit to. */
export function seedApprovedEvidence(
  reader: MockFabricEvidenceReader,
  dealId: string,
  milestoneId: string,
  fabricTxId: string,
  overrides: Partial<WorkEvidence> = {},
): string {
  const evidence = approvedEvidence(fabricTxId, overrides);
  reader.set(dealId, milestoneId, evidence);
  return canonicalWorkEvidenceHash(evidence);
}
