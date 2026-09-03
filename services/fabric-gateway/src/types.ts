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
  readonly buyerOrganizationRef: string;
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
  readonly buyerOrganizationRef: string;
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
  readonly body: ExecutorReleaseInput;
}

export interface ReleasePermitRequest {
  readonly command: ExecutorReleaseCommand;
}

export interface ExecutorEscrowBinding {
  readonly dealId: string;
  readonly agreementHash: string;
  readonly originProviderAddress: string;
  readonly destinationProviderAddress: string;
  readonly assetId: number;
  readonly amount: { readonly amountMinor: string; readonly currency: string; readonly scale: number };
  readonly network: 'localnet' | 'testnet';
  readonly genesisHash: string;
  readonly applicationId: string;
}

export interface ExecutorReleaseInput {
  readonly evidenceId: string;
  readonly escrowBinding: ExecutorEscrowBinding;
  readonly milestoneId: string;
  readonly amountMinor: string;
  readonly intentId: string;
  readonly bindingHash: string;
  readonly fenceGeneration: number;
  readonly leaseExpiresAt: string;
  readonly authorizationCommitment: string;
  readonly fabricClaimTransactionId: string;
  readonly releaseBinding: ReleaseAuthorization;
}

export interface GenericPermitRequest {
  readonly command: {
    readonly action: 'create' | 'fund' | 'pause' | 'resume' | 'refund' | 'complete';
    readonly method: 'POST';
    readonly path: string;
    readonly idempotencyKey: string;
    readonly body: unknown;
  };
}

export interface WorkEvidenceProjection {
  readonly evidenceId: string;
  readonly contractHash: string;
  readonly milestoneHash: string;
  readonly fileHash: string;
  readonly subjectRef: string;
  readonly version: number;
  readonly submittedAt: string;
  readonly buyerDecision: BuyerDecision;
  readonly buyerDecisionHash?: string;
  readonly decidedAt?: string;
  readonly fabricTxId: string;
}

export interface ReleasePermitClaims {
  readonly iss: string;
  readonly aud: string;
  readonly sub: 'optiwork-payments';
  readonly jti: string;
  readonly iat: number;
  readonly exp: number;
  readonly schemaVersion: '1.0';
  readonly action: 'release';
  readonly method: 'POST';
  readonly path: string;
  readonly idempotencyKey: string;
  readonly commandHash: string;
  readonly fabricTransactionId: string;
  readonly releaseAuthorization: ExecutorReleaseInput;
  readonly authoritativeReads: readonly [{ readonly path: string; readonly dataHash: string }];
}

export interface GenericPermitClaims extends Omit<ReleasePermitClaims,
  'action' | 'releaseAuthorization' | 'authoritativeReads'> {
  readonly action: GenericPermitRequest['command']['action'];
  readonly authoritativeReads: readonly [];
}

export interface ReleasePermitEnvelope {
  readonly permit: string;
  readonly expiresAt: string;
  readonly claims: ReleasePermitClaims;
}

export interface GenericPermitEnvelope {
  readonly permit: string;
  readonly expiresAt: string;
  readonly claims: GenericPermitClaims;
}
