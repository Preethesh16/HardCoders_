/**
 * Credential registration and verification.
 *
 * The API stores the credential, its issuer public key and an append-only
 * status history. Verification always re-reads the current status rather than
 * trusting the status embedded in the credential, so a revocation takes effect
 * immediately even for a credential that has not yet expired.
 */

import type { VerifiableCredential } from '@optiwork/contracts';
import type { AppContext } from '../context.js';
import { conflict, notFound } from '../errors.js';
import { credentialStatus, credentials, organizations } from '../db/schema.js';
import { requireReadAccess, requireRole, type Principal } from '../auth/authorization.js';
import { verify, type VerificationResult } from './credentials.js';
import type { Select } from '../db/store.js';
import type { CredentialSnapshot } from '../compliance/engine.js';

export type CredentialRow = Select<typeof credentials>;

export interface RegisterCredentialInput {
  readonly credential: VerifiableCredential;
  readonly issuerPublicKeyPem: string;
}

export interface VerifyCredentialInput {
  readonly credentialId: string;
  readonly expectedCountry?: string;
  readonly expectedSubjectType?: VerifiableCredential['subjectType'];
  readonly expectedAudienceDid?: string;
}

export class IdentityService {
  constructor(private readonly context: AppContext) {}

  async register(principal: Principal, input: RegisterCredentialInput): Promise<CredentialRow> {
    requireRole(principal, 'company_member', 'freelancer', 'supplier', 'platform_admin', 'compliance_service');
    const organization = await this.context.store.findOne(organizations, { id: principal.organizationId });
    if (!organization) throw notFound(`Unknown organization ${principal.organizationId}.`);

    const existing = await this.context.store.findOne(credentials, { id: input.credential.id });
    if (existing) {
      if (existing.organizationId !== principal.organizationId) {
        throw conflict('That credential identifier belongs to another organization.');
      }
      return existing;
    }
    const now = this.context.clock.now().toISOString();
    const row = await this.context.store.insert(credentials, {
      id: input.credential.id,
      organizationId: principal.organizationId,
      subjectDid: input.credential.subjectDid,
      issuerDid: input.credential.issuerDid,
      subjectCommitment: input.credential.subjectCommitment,
      subjectType: input.credential.subjectType,
      country: input.credential.country,
      assuranceLevel: input.credential.assuranceLevel,
      issuedAt: input.credential.issuedAt,
      expiresAt: input.credential.expiresAt,
      signature: input.credential.signature,
      issuerPublicKeyPem: input.issuerPublicKeyPem,
      createdAt: now,
    });
    await this.context.store.insert(credentialStatus, {
      id: this.context.ids.next('CS'),
      credentialId: row.id,
      status: input.credential.status,
      reason: 'Credential registered.',
      recordedAt: now,
    });
    return row;
  }

  async setStatus(
    principal: Principal,
    credentialId: string,
    status: VerifiableCredential['status'],
    reason: string,
  ): Promise<void> {
    requireRole(principal, 'compliance_service', 'platform_admin');
    await this.requireCredential(credentialId);
    await this.context.store.insert(credentialStatus, {
      id: this.context.ids.next('CS'),
      credentialId,
      status,
      reason,
      recordedAt: this.context.clock.now().toISOString(),
    });
  }

  async currentStatus(credentialId: string): Promise<VerifiableCredential['status']> {
    const history = await this.context.store.findMany(
      credentialStatus,
      { credentialId },
      { orderBy: 'recordedAt', direction: 'desc', limit: 1 },
    );
    return (history[0]?.status ?? 'SUSPENDED') as VerifiableCredential['status'];
  }

  async verifyCredential(principal: Principal, input: VerifyCredentialInput) {
    const row = await this.requireCredential(input.credentialId);
    requireReadAccess(principal, row.organizationId);
    const status = await this.currentStatus(row.id);
    const result = verify({
      credential: this.toCredential(row, status),
      issuerPublicKeyPem: row.issuerPublicKeyPem,
      currentStatus: status,
      at: this.context.clock.now(),
      ...(input.expectedCountry === undefined ? {} : { expectedCountry: input.expectedCountry }),
      ...(input.expectedSubjectType === undefined ? {} : { expectedSubjectType: input.expectedSubjectType }),
      ...(input.expectedAudienceDid === undefined ? {} : { expectedAudienceDid: input.expectedAudienceDid }),
    });
    await this.context.timeline.append({
      kind: 'CREDENTIAL_VERIFIED',
      actor: { subject: principal.subject, role: principal.roles[0] ?? 'unknown' },
      detail: {
        credentialId: row.id,
        organizationId: row.organizationId,
        country: row.country,
        subjectType: row.subjectType,
        valid: result.valid,
        failures: result.failures,
      },
    });
    return { credential: this.toCredential(row, status), status, result };
  }

  /** The compliance engine's view: lifecycle facts plus one signature verdict. */
  async snapshot(credentialId: string): Promise<CredentialSnapshot> {
    const row = await this.requireCredential(credentialId);
    const status = await this.currentStatus(row.id);
    const result: VerificationResult = verify({
      credential: this.toCredential(row, status),
      issuerPublicKeyPem: row.issuerPublicKeyPem,
      currentStatus: status,
      at: this.context.clock.now(),
    });
    return {
      id: row.id,
      country: row.country,
      assuranceLevel: row.assuranceLevel as VerifiableCredential['assuranceLevel'],
      status,
      expiresAt: row.expiresAt,
      signatureValid: result.checks['signatureValid'] === true,
    };
  }

  async forOrganization(organizationId: string): Promise<CredentialRow | null> {
    const rows = await this.context.store.findMany(
      credentials,
      { organizationId },
      { orderBy: 'issuedAt', direction: 'desc', limit: 1 },
    );
    return rows[0] ?? null;
  }

  async requireCredential(credentialId: string): Promise<CredentialRow> {
    const row = await this.context.store.findOne(credentials, { id: credentialId });
    if (!row) throw notFound(`Unknown credential ${credentialId}.`);
    return row;
  }

  private toCredential(row: CredentialRow, status: VerifiableCredential['status']): VerifiableCredential {
    return {
      id: row.id,
      issuerDid: row.issuerDid,
      subjectDid: row.subjectDid,
      subjectCommitment: row.subjectCommitment as `sha256:${string}`,
      subjectType: row.subjectType as VerifiableCredential['subjectType'],
      country: row.country,
      assuranceLevel: row.assuranceLevel as VerifiableCredential['assuranceLevel'],
      issuedAt: row.issuedAt,
      expiresAt: row.expiresAt,
      status,
      signature: row.signature,
    };
  }
}
