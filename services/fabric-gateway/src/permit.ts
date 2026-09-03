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
  GenericPermitClaims,
  GenericPermitEnvelope,
  GenericPermitRequest,
  LedgerWorkEvidence,
  ReleasePermitClaims,
  ReleasePermitEnvelope,
  ReleasePermitRequest,
  WorkEvidenceProjection,
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

export function projectWorkEvidence(evidence: LedgerWorkEvidence): WorkEvidenceProjection {
  return {
    evidenceId: evidence.evidenceId,
    contractHash: evidence.contractHash,
    milestoneHash: evidence.milestoneHash,
    fileHash: evidence.fileHash,
    subjectRef: evidence.sellerIdentityRef,
    version: evidence.version,
    submittedAt: evidence.submittedAt,
    buyerDecision: evidence.buyerDecision,
    ...(evidence.buyerDecisionHash === undefined ? {} : { buyerDecisionHash: evidence.buyerDecisionHash }),
    ...(evidence.decidedAt === undefined ? {} : { decidedAt: evidence.decidedAt }),
    fabricTxId: evidence.fabricTxId,
  };
}

function executorCommandHash(command: GenericPermitRequest['command'] | ReleasePermitRequest['command']): string {
  return canonicalHash({
    schemaVersion: '1.0',
    action: command.action,
    method: command.method,
    path: command.path,
    idempotencyKey: command.idempotencyKey,
    body: command.body ?? null,
  });
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
    const release = request.command.body;
    const projection = projectWorkEvidence(evidence);
    const evidenceHash = canonicalHash(projection);
    if (evidence.buyerDecision !== 'APPROVED'
      || evidence.buyerDecisionHash === undefined
      || release.evidenceId !== evidence.evidenceId
      || release.fabricClaimTransactionId !== evidence.fabricTxId
      || release.releaseBinding.workEvidenceHash !== evidenceHash
      || release.releaseBinding.fabricTxHash !== sha256(evidence.fabricTxId)
      || release.releaseBinding.escrowBindingHash !== canonicalHash(release.escrowBinding)
      || release.releaseBinding.generation !== release.fenceGeneration
      || release.releaseBinding.idempotencyKey !== request.command.idempotencyKey
      || release.releaseBinding.expiresAt !== release.leaseExpiresAt
      || release.authorizationCommitment !== canonicalHash(release.releaseBinding)
      || release.bindingHash !== canonicalHash(release.escrowBinding)) {
      throw new AppError('STATE_CONFLICT');
    }
    const issuedAt = Math.floor(this.#now().getTime() / 1_000);
    const expiresAtSeconds = issuedAt + this.#ttlSeconds;
    if (Date.parse(release.leaseExpiresAt) <= expiresAtSeconds * 1_000) throw new AppError('STATE_CONFLICT');
    const claims: ReleasePermitClaims = {
      iss: this.#issuer,
      aud: this.#audience,
      sub: 'optiwork-payments',
      jti: randomUUID(),
      iat: issuedAt,
      exp: expiresAtSeconds,
      schemaVersion: '1.0',
      action: 'release',
      method: request.command.method,
      path: request.command.path,
      idempotencyKey: request.command.idempotencyKey,
      commandHash: executorCommandHash(request.command),
      fabricTransactionId: evidence.fabricTxId,
      releaseAuthorization: release,
      authoritativeReads: [{
        path: `/v1/evidence/${encodeURIComponent(evidence.evidenceId)}/projection`,
        dataHash: evidenceHash,
      }],
    };
    return {
      permit: await this.#sign(claims),
      expiresAt: new Date(expiresAtSeconds * 1_000).toISOString(),
      claims,
    };
  }

  public async issueCommand(request: GenericPermitRequest): Promise<GenericPermitEnvelope> {
    const issuedAt = Math.floor(this.#now().getTime() / 1_000);
    const expiresAtSeconds = issuedAt + this.#ttlSeconds;
    const claims: GenericPermitClaims = {
      iss: this.#issuer,
      aud: this.#audience,
      sub: 'optiwork-payments',
      jti: randomUUID(),
      iat: issuedAt,
      exp: expiresAtSeconds,
      schemaVersion: '1.0',
      action: request.command.action,
      method: request.command.method,
      path: request.command.path,
      idempotencyKey: request.command.idempotencyKey,
      commandHash: executorCommandHash(request.command),
      fabricTransactionId: 'FABRIC-NOT-APPLICABLE',
      authoritativeReads: [],
    };
    return {
      permit: await this.#sign(claims),
      expiresAt: new Date(expiresAtSeconds * 1_000).toISOString(),
      claims,
    };
  }

  async #sign(claims: ReleasePermitClaims | GenericPermitClaims): Promise<string> {
    const { iss, aud, sub, jti, iat, exp, ...payload } = claims;
    return new SignJWT(payload)
      .setProtectedHeader({ alg: 'EdDSA', typ: RELEASE_PERMIT_TYPE, kid: this.#keyId })
      .setIssuer(iss)
      .setAudience(aud)
      .setSubject(sub)
      .setJti(jti)
      .setIssuedAt(iat)
      .setExpirationTime(exp)
      .sign(this.#privateKey);
  }
}
