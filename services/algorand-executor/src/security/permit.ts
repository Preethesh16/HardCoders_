import { createLocalJWKSet, jwtVerify } from "jose";

import type { ExecutorConfig } from "../config.js";
import { forbidden } from "../errors.js";
import {
  commandHash,
  permitClaimsSchema,
  releaseInputSchema,
  type CommandContext,
  type PermitClaims,
} from "../types.js";

const PERMIT_TYPE = "anchor-fabric-permit+jwt";

export interface FabricPermitVerifier {
  verify(compactPermit: string, command: CommandContext): Promise<PermitClaims>;
}

export class Ed25519FabricPermitVerifier implements FabricPermitVerifier {
  readonly #keySet: ReturnType<typeof createLocalJWKSet>;

  constructor(private readonly config: ExecutorConfig) {
    this.#keySet = createLocalJWKSet({ keys: [config.permitPublicJwk] });
  }

  async verify(compactPermit: string, command: CommandContext): Promise<PermitClaims> {
    if (compactPermit.length < 64 || compactPermit.length > 16_384 || /\s/u.test(compactPermit)) {
      throw forbidden("The Fabric authorization permit is invalid.");
    }
    let verified: Awaited<ReturnType<typeof jwtVerify>>;
    try {
      verified = await jwtVerify(compactPermit, this.#keySet, {
        algorithms: ["EdDSA"],
        issuer: this.config.FABRIC_PERMIT_ISSUER,
        audience: this.config.FABRIC_PERMIT_AUDIENCE,
        clockTolerance: 2,
        maxTokenAge: `${this.config.FABRIC_PERMIT_MAX_AGE_SECONDS}s`,
        requiredClaims: ["iss", "aud", "sub", "jti", "iat", "exp"],
      });
    } catch {
      throw forbidden("The Fabric authorization permit is invalid or expired.");
    }
    if (verified.protectedHeader.alg !== "EdDSA"
      || verified.protectedHeader.typ !== PERMIT_TYPE
      || verified.protectedHeader.kid !== this.config.permitPublicJwk.kid) {
      throw forbidden("The Fabric authorization permit header is invalid.");
    }
    const parsed = permitClaimsSchema.safeParse(verified.payload);
    if (!parsed.success) throw forbidden("The Fabric authorization permit claims are invalid.");
    const claims = parsed.data;
    if (claims.action !== command.action
      || claims.method !== command.method
      || claims.path !== command.path
      || claims.idempotencyKey !== command.idempotencyKey
      || claims.commandHash !== commandHash(command)) {
      throw forbidden("The Fabric authorization permit does not bind this command.");
    }
    if (claims.exp - claims.iat > this.config.FABRIC_PERMIT_MAX_AGE_SECONDS) {
      throw forbidden("The Fabric authorization permit lifetime is too long.");
    }
    if (claims.action === "release") {
      const body = releaseInputSchema.safeParse(command.body);
      if (!body.success || JSON.stringify(claims.releaseAuthorization.escrowBinding) !== JSON.stringify(body.data.escrowBinding)) {
        throw forbidden("The release permit does not bind the complete escrow beneficiary target.");
      }
      const expected = claims.releaseAuthorization;
      if (expected.milestoneId !== body.data.milestoneId
        || expected.amountMinor !== body.data.amountMinor
        || expected.intentId !== body.data.intentId
        || expected.bindingHash !== body.data.bindingHash
        || expected.fenceGeneration !== body.data.fenceGeneration
        || expected.leaseExpiresAt !== body.data.leaseExpiresAt
        || expected.authorizationCommitment !== body.data.authorizationCommitment
        || expected.fabricClaimTransactionId !== body.data.fabricClaimTransactionId
        || expected.fabricClaimTransactionId !== claims.fabricTransactionId) {
        throw forbidden("The release permit does not bind the current Fabric claim.");
      }
      if (Date.parse(expected.leaseExpiresAt) <= Date.now()) {
        throw forbidden("The Fabric release lease has expired.");
      }
      const leaseExpirySeconds = Math.floor(Date.parse(expected.leaseExpiresAt) / 1_000);
      if (claims.exp + this.config.ALGORAND_RELEASE_SAFETY_MARGIN_SECONDS >= leaseExpirySeconds) {
        throw forbidden("The signed permit must expire before the Fabric lease safety margin begins.");
      }
    }
    return claims;
  }
}

export const FABRIC_PERMIT_TYPE = PERMIT_TYPE;
