import { randomUUID } from 'node:crypto';
import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  importJWK,
  type CryptoKey,
  type JWK,
} from 'jose';
import { canonicalHash, sha256 } from './canonical.js';
import { AppError } from './errors.js';
import type {
  LedgerWorkEvidence,
  ReleasePermitClaims,
  ReleasePermitEnvelope,
  ReleasePermitRequest,
} from './types.js';

export const RELEASE_PERMIT_TYPE = 'optiwork-fabric-permit+jwt';

export interface ReleasePermitIssuerOptions {
  readonly issuer: string;
  readonly audience: string;
  readonly keyId: string;
  readonly privateKey: CryptoKey | Uint8Array;
  readonly publicJwk: JWK;
  readonly ttlSeconds?: number;
  readonly now?: () => Date;
}

export class ReleasePermitIssuer {
  readonly #issuer: string;
  readonly #audience: string;
  readonly #keyId: string;
  readonly #privateKey: CryptoKey | Uint8Array;
  readonly #publicJwk: JWK;
  readonly #ttlSeconds: number;
  readonly #now: () => Date;

  public constructor(options: ReleasePermitIssuerOptions) {
    this.#issuer = options.issuer;
    this.#audience = options.audience;
    this.#keyId = options.keyId;
    this.#privateKey = options.privateKey;
    this.#publicJwk = { ...options.publicJwk, kid: options.keyId, alg: 'EdDSA', use: 'sig' };
    this.#ttlSeconds = options.ttlSeconds ?? 60;
    this.#now = options.now ?? (() => new Date());
    if (!Number.isSafeInteger(this.#ttlSeconds) || this.#ttlSeconds < 5 || this.#ttlSeconds > 120) {
      throw new Error('Release permit TTL must be between 5 and 120 seconds.');
    }
  }

  public static async ephemeral(
    options: Omit<ReleasePermitIssuerOptions, 'privateKey' | 'publicJwk'>,
  ): Promise<ReleasePermitIssuer> {
    const pair = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
    return new ReleasePermitIssuer({
      ...options,
      privateKey: pair.privateKey,
      publicJwk: await exportJWK(pair.publicKey),
    });
  }

  public static async fromPrivateJwk(
    privateJwk: JWK,
    options: Omit<ReleasePermitIssuerOptions, 'privateKey' | 'publicJwk'>,
  ): Promise<ReleasePermitIssuer> {
    if (privateJwk.kty !== 'OKP' || privateJwk.crv !== 'Ed25519' || typeof privateJwk.d !== 'string') {
      throw new Error('An Ed25519 private JWK is required.');
    }
    const privateKey = await importJWK(privateJwk, 'EdDSA');
    const { d: _private, ...publicJwk } = privateJwk;
    return new ReleasePermitIssuer({ ...options, privateKey, publicJwk });
  }

  public publicJwks(): { readonly keys: readonly JWK[] } {
    return { keys: [{ ...this.#publicJwk }] };
  }

  public async issue(
    evidence: LedgerWorkEvidence,
    request: ReleasePermitRequest,
  ): Promise<ReleasePermitEnvelope> {
    if (evidence.buyerDecision !== 'APPROVED'
      || evidence.buyerDecisionHash === undefined
      || evidence.version !== request.expectedVersion
      || evidence.fileHash !== request.expectedFileHash) {
      throw new AppError('STATE_CONFLICT');
    }
    const now = this.#now();
    const issuedAt = Math.floor(now.getTime() / 1_000);
    const expiresAtSeconds = issuedAt + this.#ttlSeconds;
    const evidenceHash = canonicalHash(evidence);
    const claims: ReleasePermitClaims = {
      iss: this.#issuer,
      aud: this.#audience,
      sub: `evidence:${evidence.evidenceId}`,
      jti: randomUUID(),
      iat: issuedAt,
      exp: expiresAtSeconds,
      action: 'release',
      method: request.command.method,
      path: request.command.path,
      idempotencyKey: request.command.idempotencyKey,
      commandHash: canonicalHash(request.command),
      evidenceId: evidence.evidenceId,
      evidenceVersion: evidence.version,
      evidenceFileHash: evidence.fileHash,
      fabricTransactionId: evidence.fabricTxId,
      releaseAuthorization: {
        escrowBindingHash: request.escrowBindingHash,
        workEvidenceHash: evidenceHash,
        fabricTxHash: sha256(evidence.fabricTxId),
        complianceResultHash: request.complianceResultHash,
        fxQuoteHash: request.fxQuoteHash,
        generation: request.generation,
        idempotencyKey: request.command.idempotencyKey,
        expiresAt: new Date(expiresAtSeconds * 1_000).toISOString(),
      },
      authoritativeReads: [{
        path: `/v1/evidence/${encodeURIComponent(evidence.evidenceId)}`,
        dataHash: evidenceHash,
      }],
    };
    const permit = await new SignJWT({
      action: claims.action,
      method: claims.method,
      path: claims.path,
      idempotencyKey: claims.idempotencyKey,
      commandHash: claims.commandHash,
      evidenceId: claims.evidenceId,
      evidenceVersion: claims.evidenceVersion,
      evidenceFileHash: claims.evidenceFileHash,
      fabricTransactionId: claims.fabricTransactionId,
      releaseAuthorization: claims.releaseAuthorization,
      authoritativeReads: claims.authoritativeReads,
    })
      .setProtectedHeader({ alg: 'EdDSA', typ: RELEASE_PERMIT_TYPE, kid: this.#keyId })
      .setIssuer(claims.iss)
      .setAudience(claims.aud)
      .setSubject(claims.sub)
      .setJti(claims.jti)
      .setIssuedAt(claims.iat)
      .setExpirationTime(claims.exp)
      .sign(this.#privateKey);
    return {
      permit,
      expiresAt: claims.releaseAuthorization.expiresAt,
      claims,
    };
  }
}
