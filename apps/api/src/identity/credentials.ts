/**
 * `did:key` prototype credentials.
 *
 * A credential proves a claim about a party — country, subject type, assurance
 * level — without publishing who they are. The subject is carried only as a
 * salted commitment, so nothing personal can be recovered from the credential,
 * and nothing personal ever reaches a ledger.
 *
 * This is a prototype identity scheme for a demonstration, not an accredited
 * identity or KYC service.
 */

import { createPublicKey } from 'node:crypto';
import type { VerifiableCredential } from '@optiwork/contracts';
import { createDemoIssuer, signCredential, subjectCommitment, verifyCredential } from '@optiwork/domain';
import { unprocessable } from '../errors.js';

export { createDemoIssuer, signCredential, subjectCommitment };

export interface VerificationRequest {
  readonly credential: VerifiableCredential;
  readonly issuerPublicKeyPem: string;
  readonly expectedAudienceDid?: string;
  readonly expectedCountry?: string;
  readonly expectedSubjectType?: VerifiableCredential['subjectType'];
  readonly expectedSubjectDid?: string;
  readonly currentStatus: VerifiableCredential['status'];
  readonly at: Date;
}

export interface VerificationResult {
  readonly valid: boolean;
  readonly checks: Readonly<Record<string, boolean>>;
  readonly failures: readonly string[];
}

function ed25519PublicKey(pem: string): boolean {
  try {
    const key = createPublicKey(pem);
    return key.asymmetricKeyType === 'ed25519';
  } catch {
    return false;
  }
}

/**
 * Verifies every dimension the corridor rules depend on. A failure in any one
 * of them makes the credential unusable; there is no partial acceptance.
 */
export function verify(request: VerificationRequest): VerificationResult {
  const { credential } = request;
  const checks: Record<string, boolean> = {};

  checks['issuerKeyIsEd25519'] = ed25519PublicKey(request.issuerPublicKeyPem);
  checks['issuerDidPresent'] = credential.issuerDid.startsWith('did:key:');
  checks['subjectDidPresent'] = credential.subjectDid.startsWith('did:key:');
  checks['subjectCommitmentPresent'] = /^sha256:[a-f0-9]{64}$/u.test(credential.subjectCommitment);
  checks['statusActive'] = request.currentStatus === 'ACTIVE' && credential.status === 'ACTIVE';
  checks['notExpired'] = Date.parse(credential.expiresAt) > request.at.getTime();
  checks['issuedBeforeNow'] = Date.parse(credential.issuedAt) <= request.at.getTime();
  checks['audienceMatches'] = request.expectedAudienceDid === undefined
    || request.expectedAudienceDid === credential.issuerDid;
  checks['countryMatches'] = request.expectedCountry === undefined
    || request.expectedCountry === credential.country;
  checks['subjectTypeMatches'] = request.expectedSubjectType === undefined
    || request.expectedSubjectType === credential.subjectType;
  checks['subjectMatches'] = request.expectedSubjectDid === undefined
    || request.expectedSubjectDid === credential.subjectDid;
  checks['signatureValid'] = checks['issuerKeyIsEd25519']
    ? signatureIsValid(credential, request.issuerPublicKeyPem, request.at)
    : false;

  const failures = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  return { valid: failures.length === 0, checks, failures };
}

/**
 * The shared verifier refuses expired or non-active credentials outright, so
 * signature validity is checked against the issuance instant to keep the
 * cryptographic result separable from the lifecycle result.
 */
function signatureIsValid(credential: VerifiableCredential, publicKeyPem: string, at: Date): boolean {
  const liveCheck = verifyCredential(credential, publicKeyPem, at);
  if (liveCheck) return true;
  const asIssued: VerifiableCredential = { ...credential, status: 'ACTIVE' };
  return verifyCredential(asIssued, publicKeyPem, new Date(Date.parse(credential.issuedAt)));
}

export function assertUsable(result: VerificationResult, credentialId: string): void {
  if (!result.valid) {
    throw unprocessable(`Credential ${credentialId} failed verification.`, { failures: result.failures });
  }
}
