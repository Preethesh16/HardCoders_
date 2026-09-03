import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { commandHash, type CommandContext, type PermitClaims, type ReleaseInput } from "../src/types.js";
import { Ed25519FabricPermitVerifier, FABRIC_PERMIT_TYPE } from "../src/security/permit.js";
import { releaseInput, testConfig } from "./helpers.js";

const now = Date.parse("2026-08-28T00:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
});
afterEach(() => vi.useRealTimers());

async function signer() {
  const pair = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  const publicJwk = { ...(await exportJWK(pair.publicKey)), kid: "permit-key-1", alg: "EdDSA" };
  const config = { ...testConfig(), permitPublicJwk: publicJwk as JsonWebKey & { kid: string } };
  const sign = async (claims: PermitClaims) => new SignJWT(JSON.parse(JSON.stringify(claims)) as JWTPayload)
    .setProtectedHeader({ alg: "EdDSA", typ: FABRIC_PERMIT_TYPE, kid: "permit-key-1" })
    .sign(pair.privateKey);
  return { config, verifier: new Ed25519FabricPermitVerifier(config), sign };
}

function createCommand(config: ReturnType<typeof testConfig>): CommandContext {
  return {
    action: "create", method: "POST", path: "/escrows", idempotencyKey: "CREATE-001",
    body: {
      dealId: "DEAL-001", agreementHash: `sha256:${"a".repeat(64)}`,
      originProviderAddress: config.ALGORAND_ORIGIN_PROVIDER_TREASURY_ADDRESS,
      destinationProviderAddress: config.ALGORAND_SIGNER_ADDRESS,
      assetId: Number(config.ALGORAND_ASSET_ID),
      amount: { amountMinor: "100", currency: "USD", scale: 2 },
    },
  };
}

function release(config: ReturnType<typeof testConfig>, leaseSeconds: number): { command: CommandContext; claims: PermitClaims } {
  const body: ReleaseInput = releaseInput({
    escrowBinding: {
      ...(createCommand(config).body as Record<string, unknown>),
      network: "localnet",
      genesisHash: config.ALGORAND_GENESIS_HASH,
      applicationId: config.ALGORAND_APPLICATION_ID.toString(),
    } as ReleaseInput["escrowBinding"],
    milestoneId: "MS-001", amountMinor: "100", intentId: "INTENT-001",
    bindingHash: `sha256:${"b".repeat(64)}`, fenceGeneration: 1,
    leaseExpiresAt: new Date(now + leaseSeconds * 1_000).toISOString(),
    fabricClaimTransactionId: "FABRIC-CLAIM-001",
    idempotencyKey: `RELEASE-${leaseSeconds}`,
  });
  const command: CommandContext = {
    action: "release", method: "POST", path: "/escrows/DEAL-001/releases", idempotencyKey: `RELEASE-${leaseSeconds}`, body,
  };
  const nowSeconds = Math.floor(now / 1_000);
  const base = "/ledger/deals/DEAL-001/milestones/MS-001/payment-intents/INTENT-001";
  const claims: PermitClaims = {
    iss: config.FABRIC_PERMIT_ISSUER, aud: config.FABRIC_PERMIT_AUDIENCE, sub: "optiwork-payments",
    jti: `permit-release-${leaseSeconds}`, iat: nowSeconds, exp: nowSeconds + 20,
    schemaVersion: "1.0", action: "release", method: "POST", path: command.path,
    idempotencyKey: command.idempotencyKey, commandHash: commandHash(command),
    fabricTransactionId: "FABRIC-CLAIM-001",
    authoritativeReads: [base, `${base}/binding`, `${base}/fence`].map((path, index) => ({
      path, dataHash: `sha256:${String(index + 1).repeat(64)}`,
    })),
    releaseAuthorization: {
      ...body,
    },
  };
  return { command, claims };
}

describe("signed Fabric action permits", () => {
  it("accepts an exact short-lived Ed25519 command and rejects command substitution", async () => {
    const { config, verifier, sign } = await signer();
    const command = createCommand(config);
    const seconds = Math.floor(now / 1_000);
    const claims: PermitClaims = {
      iss: config.FABRIC_PERMIT_ISSUER, aud: config.FABRIC_PERMIT_AUDIENCE, sub: "optiwork-payments",
      jti: "permit-create-1", iat: seconds, exp: seconds + 20, schemaVersion: "1.0",
      action: "create", method: "POST", path: command.path, idempotencyKey: command.idempotencyKey,
      commandHash: commandHash(command), fabricTransactionId: "FABRIC-CREATE-001",
      authoritativeReads: [{ path: "/ledger/deals/DEAL-001/algorand-authorization", dataHash: `sha256:${"d".repeat(64)}` }],
    };
    const compact = await sign(claims);
    await expect(verifier.verify(compact, command)).resolves.toMatchObject({ action: "create" });
    await expect(verifier.verify(compact, { ...command, idempotencyKey: "CREATE-ATTACK" })).rejects.toMatchObject({ statusCode: 403 });
  });

  it("rejects an expired Fabric release lease and a substituted release binding", async () => {
    const { config, verifier, sign } = await signer();
    const expired = release(config, -1);
    await expect(verifier.verify(await sign(expired.claims), expired.command)).rejects.toThrow(/lease has expired/u);

    // A coherent authorization for a *different* compliance decision must not
    // authorize the command body the caller actually submitted.
    const valid = release(config, 120);
    const submitted = valid.command.body as ReleaseInput;
    const substituted = {
      ...valid.claims,
      releaseAuthorization: releaseInput({
        escrowBinding: submitted.escrowBinding,
        milestoneId: submitted.milestoneId,
        amountMinor: submitted.amountMinor,
        intentId: submitted.intentId,
        bindingHash: submitted.bindingHash,
        fenceGeneration: submitted.fenceGeneration,
        leaseExpiresAt: submitted.leaseExpiresAt,
        fabricClaimTransactionId: submitted.fabricClaimTransactionId,
        idempotencyKey: valid.command.idempotencyKey,
        complianceResultHash: `sha256:${"9".repeat(64)}`,
      }),
    } as PermitClaims;
    await expect(verifier.verify(await sign(substituted), valid.command))
      .rejects.toThrow(/complete release authorization/u);
  });

  it("enforces permit expiry strictly before the Fabric lease safety margin", async () => {
    const { config, verifier, sign } = await signer();
    const boundary = release(config, 50);
    await expect(verifier.verify(await sign(boundary.claims), boundary.command)).rejects.toThrow(/safety margin/u);

    const safe = release(config, 51);
    await expect(verifier.verify(await sign(safe.claims), safe.command)).resolves.toMatchObject({ action: "release" });
  });
});
