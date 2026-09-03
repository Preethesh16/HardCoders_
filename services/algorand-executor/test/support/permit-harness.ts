/**
 * Shared harness for real-network escrow lifecycle suites.
 *
 * The LocalNet regression suite predates this module and deliberately keeps its
 * own inline copies, so that preserved regression file is never perturbed by a
 * change made for TestNet. New suites use these helpers.
 */

import { exportJWK, generateKeyPair, SignJWT } from "jose";

import { sha256 } from "../../src/canonical.js";
import type { AlgorandChain, PreparedTransactionReconciliation } from "../../src/chain.js";
import type { AuthoritativeFabricReader } from "../../src/security/gateway-reader.js";
import { FABRIC_PERMIT_TYPE } from "../../src/security/permit.js";
import type { PreparedTransaction } from "../../src/store.js";
import {
  commandHash,
  type CommandContext,
  type Escrow,
  type PermitClaims,
  type ReleaseInput,
} from "../../src/types.js";

/**
 * Stands in for the Gateway's authoritative Fabric re-read. It records the
 * exact state each permit was issued against so a test can tamper with it and
 * prove the executor refuses a permit whose Fabric state has since moved.
 */
export class RecordingFabricReader implements AuthoritativeFabricReader {
  readonly values = new Map<string, unknown>();
  verifiedCommands = 0;

  set(path: string, value: unknown): void {
    this.values.set(path, structuredClone(value));
  }

  /** Simulates Fabric state changing after the permit was signed. */
  tamper(path: string): void {
    this.values.set(path, { state: "changed-after-permit" });
  }

  async verifyCurrent(claims: PermitClaims, command: CommandContext): Promise<void> {
    this.verifiedCommands += 1;
    if (claims.action !== command.action) throw new Error("Fabric action mismatch.");
    if (claims.action === "release" && claims.authoritativeReads.length !== 3) {
      throw new Error("Release did not perform all three authoritative Fabric reads.");
    }
    for (const read of claims.authoritativeReads) {
      if (!this.values.has(read.path) || sha256(this.values.get(read.path)) !== read.dataHash) {
        throw new Error("Fabric state changed after permit issuance.");
      }
    }
  }
}

/**
 * Strands the first submission after signing, reproducing an ambiguous
 * submission: the executor holds a signed transaction it never broadcast.
 */
export class StrandNextSubmissionChain implements AlgorandChain {
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
      throw new Error("Intentionally stranded the prepared transaction before broadcast.");
    }
    return this.delegate.submit(prepared, expected);
  }

  assertProjection(escrow: Escrow): Promise<void> {
    return this.delegate.assertProjection(escrow);
  }

  getReleaseEvidence(escrow: Escrow, milestoneId: string): ReturnType<AlgorandChain["getReleaseEvidence"]> {
    return this.delegate.getReleaseEvidence(escrow, milestoneId);
  }

  readiness(): Promise<boolean> {
    return this.delegate.readiness();
  }
}

export type PermitSigner = {
  privateKey: CryptoKey;
  publicJwk: Record<string, unknown>;
  kid: string;
  issuer: string;
  audience: string;
  sequence: number;
};

export async function createPermitSigner(kid: string, issuer: string, audience: string): Promise<PermitSigner> {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  return {
    privateKey,
    publicJwk: { ...await exportJWK(publicKey), kid, alg: "EdDSA", use: "sig" },
    kid,
    issuer,
    audience,
    sequence: 0,
  };
}

function commandDealId(command: CommandContext): string {
  if (command.action === "create") return (command.body as { dealId: string }).dealId;
  if (command.action === "release") return (command.body as ReleaseInput).escrowBinding.dealId;
  return decodeURIComponent(command.path.split("/")[2] ?? "");
}

/** Issues a signed Fabric permit and records the state it was issued against. */
export async function signedPermit(
  command: CommandContext,
  reader: RecordingFabricReader,
  signer: PermitSigner,
  options: { jti?: string } = {},
): Promise<{ compact: string; paths: string[] }> {
  signer.sequence += 1;
  const dealId = commandDealId(command);
  const release = command.action === "release" ? command.body as ReleaseInput : undefined;
  const base = `/ledger/deals/${encodeURIComponent(dealId)}`;
  const paths = release
    ? [
        `${base}/milestones/${encodeURIComponent(release.milestoneId)}/payment-intents/${encodeURIComponent(release.intentId)}`,
        `${base}/milestones/${encodeURIComponent(release.milestoneId)}/payment-intents/${encodeURIComponent(release.intentId)}/binding`,
        `${base}/milestones/${encodeURIComponent(release.milestoneId)}/payment-intents/${encodeURIComponent(release.intentId)}/fence`,
      ]
    : [`${base}/algorand-authorization`];
  const authoritativeReads = paths.map((path, index) => {
    const value = {
      schemaVersion: "1.0",
      dealId,
      action: command.action,
      permitSequence: signer.sequence,
      readIndex: index,
    };
    reader.set(path, value);
    return { path, dataHash: sha256(value) };
  });
  const now = Math.floor(Date.now() / 1_000);
  const fabricTransactionId = release?.fabricClaimTransactionId
    ?? `FABRIC-${command.action.toUpperCase()}-${signer.sequence}`;
  const common = {
    iss: signer.issuer,
    aud: signer.audience,
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
  const claims = release ? { ...common, action: "release" as const, releaseAuthorization: release } : common;
  const compact = await new SignJWT(claims)
    .setProtectedHeader({ alg: "EdDSA", typ: FABRIC_PERMIT_TYPE, kid: signer.kid })
    .sign(signer.privateKey);
  return { compact, paths };
}

/** Projects an escrow into the binding shape a release command must carry. */
export function binding(escrow: Escrow) {
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
