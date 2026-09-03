import type { ActorRole, BuyerDecision, ReleaseAuthorization, WorkEvidence } from '@optiwork/contracts';

export type FabricOperationRole = 'seller' | 'buyer' | 'reader';

export interface AuthenticatedActor {
  readonly subject: string;
  readonly organizationId: string;
  readonly role: ActorRole;
  readonly roles: readonly ActorRole[];
  readonly mspId: string;
  readonly fabricIdentityId: string;
}

export interface RequestMetadata {
  readonly idempotencyKey: string;
  readonly ledgerIdempotencyKey: string;
  readonly correlationId: string;
}

export interface SubmitEvidenceInput {
  readonly evidenceId: string;
  readonly contractHash: string;
  readonly milestoneHash: string;
  readonly fileHash: string;
  readonly version: number;
}

export interface DecideEvidenceInput {
  readonly evidenceId: string;
  readonly decision: Exclude<BuyerDecision, 'PENDING'>;
  readonly expectedFileHash: string;
  readonly expectedVersion: number;
}

export interface LedgerWorkEvidence extends WorkEvidence {
  readonly schemaVersion: '1.0';
  readonly fabricTxId: string;
  readonly aggregateVersion: number;
}

export interface WorkEvidenceHistoryEntry {
  readonly transactionId: string;
  readonly timestamp: string;
  readonly isDelete: boolean;
  readonly value?: LedgerWorkEvidence;
}

export interface LedgerReadiness {
  readonly ready: boolean;
  readonly mode: 'memory' | 'fabric';
  readonly channel: string;
  readonly chaincode: string;
}

export interface EvidenceLedger {
  submit(actor: AuthenticatedActor, metadata: RequestMetadata, input: SubmitEvidenceInput): Promise<LedgerWorkEvidence>;
  decide(actor: AuthenticatedActor, metadata: RequestMetadata, input: DecideEvidenceInput): Promise<LedgerWorkEvidence>;
  get(actor: AuthenticatedActor, evidenceId: string): Promise<LedgerWorkEvidence>;
  history(actor: AuthenticatedActor, evidenceId: string): Promise<readonly WorkEvidenceHistoryEntry[]>;
  readiness(): Promise<LedgerReadiness>;
  close(): Promise<void>;
}

export interface ExecutorReleaseCommand {
  readonly action: 'release';
  readonly method: 'POST';
  readonly path: string;
  readonly idempotencyKey: string;
  readonly body: unknown;
}

export interface ReleasePermitRequest {
  readonly expectedFileHash: string;
  readonly expectedVersion: number;
  readonly escrowBindingHash: string;
  readonly complianceResultHash: string;
  readonly fxQuoteHash: string;
  readonly generation: number;
  readonly command: ExecutorReleaseCommand;
}

export interface ReleasePermitClaims {
  readonly iss: string;
  readonly aud: string;
  readonly sub: string;
  readonly jti: string;
  readonly iat: number;
  readonly exp: number;
  readonly action: 'release';
  readonly method: 'POST';
  readonly path: string;
  readonly idempotencyKey: string;
  readonly commandHash: string;
  readonly evidenceId: string;
  readonly evidenceVersion: number;
  readonly evidenceFileHash: string;
  readonly fabricTransactionId: string;
  readonly releaseAuthorization: ReleaseAuthorization;
  readonly authoritativeReads: readonly [{ readonly path: string; readonly dataHash: string }];
}

export interface ReleasePermitEnvelope {
  readonly permit: string;
  readonly expiresAt: string;
  readonly claims: ReleasePermitClaims;
}
