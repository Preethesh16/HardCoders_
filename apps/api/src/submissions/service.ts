/**
 * Work submission, buyer decision and authorized file access.
 *
 * Bytes go to object storage. Only the canonical SHA-256 commitment, the
 * version and the buyer's decision reach Fabric. The buying company can read
 * the exact bytes it is deciding on, through a short-lived signed URL that is
 * issued only after authorization - never as a raw storage key.
 */

import { assertTransition } from '@optiwork/domain';
import type { WorkContractState } from '@optiwork/contracts';
import type { AppContext } from '../context.js';
import { conflict, notFound, unprocessable } from '../errors.js';
import { documentHashes, uploadedObjects, workContracts, workSubmissions } from '../db/schema.js';
import { requireOwnership, requireReadAccess, requireRole, type Principal } from '../auth/authorization.js';
import { ALLOWED_CONTENT_TYPES, MAX_OBJECT_BYTES, objectKeyFor } from '../storage/object-store.js';
import { buyerOrganizationRef, workEvidenceHash } from '../fabric/evidence-reader.js';
import type { Select } from '../db/store.js';
import { sha256Text } from '../runtime.js';

export type Submission = Select<typeof workSubmissions>;

export interface SubmitWorkInput {
  readonly fileName: string;
  readonly contentType: string;
  readonly contentBase64: string;
  readonly note: string;
}

export interface DecideInput {
  readonly decision: 'APPROVED' | 'REVISION_REQUIRED' | 'DISPUTED';
  readonly comment: string;
}

export class SubmissionService {
  constructor(private readonly context: AppContext) {}

  private actor(principal: Principal) {
    return { subject: principal.subject, role: principal.roles[0] ?? 'unknown' };
  }

  /**
   * Stores the deliverable and records its commitment on Fabric.
   *
   * The provider is the only party that can submit, and each submission is a
   * new immutable version: a revision never overwrites the bytes the buyer
   * previously decided on.
   */
  async submit(principal: Principal, contractId: string, input: SubmitWorkInput) {
    requireRole(principal, 'freelancer', 'supplier');
    const contract = await this.requireContract(contractId);
    requireOwnership(principal, contract.providerOrganizationId);
    if (!['ESCROW_FUNDED', 'IN_PROGRESS', 'REVISION_REQUIRED'].includes(contract.state)) {
      throw conflict(`Contract ${contractId} is not accepting a submission in state ${contract.state}.`);
    }
    if (!ALLOWED_CONTENT_TYPES.includes(input.contentType)) {
      throw unprocessable(`Content type ${input.contentType} is not accepted.`, { allowed: ALLOWED_CONTENT_TYPES });
    }
    const bytes = Buffer.from(input.contentBase64, 'base64');
    if (bytes.byteLength === 0) throw unprocessable('The deliverable is empty.');
    if (bytes.byteLength > MAX_OBJECT_BYTES) {
      throw unprocessable(`The deliverable exceeds ${MAX_OBJECT_BYTES} bytes.`);
    }

    const previous = await this.context.store.findMany(
      workSubmissions,
      { contractId },
      { orderBy: 'version', direction: 'desc', limit: 1 },
    );
    const latest = previous[0];
    if (latest && latest.buyerDecision === 'PENDING') {
      throw conflict(`Version ${latest.version} is still awaiting a buyer decision.`);
    }
    if (latest && latest.buyerDecision === 'APPROVED') {
      throw conflict('This milestone has already been approved.');
    }
    const version = (latest?.version ?? 0) + 1;

    const objectId = this.context.ids.next('OBJ');
    const objectKey = objectKeyFor('deliverable', contract.providerOrganizationId, objectId);
    const stored = await this.context.objects.put(objectKey, bytes, input.contentType);
    const now = this.context.clock.now().toISOString();
    await this.context.store.insert(uploadedObjects, {
      id: objectId,
      bucket: stored.bucket,
      objectKey: stored.objectKey,
      contentType: stored.contentType,
      byteLength: String(stored.byteLength),
      sha256: stored.sha256,
      ownerOrganizationId: contract.providerOrganizationId,
      classification: 'DELIVERABLE',
      createdAt: now,
    });

    // The subject reference is an opaque commitment, never a user identifier.
    const subjectRef = sha256Text(`optiwork-subject:${contract.providerOrganizationId}`).slice(7, 39);
    const record = await this.context.fabric.recordSubmission({
      dealId: contract.id,
      milestoneId: contract.milestoneId,
      evidenceId: this.context.ids.next('EV'),
      contractHash: contract.contractHash,
      milestoneHash: contract.milestoneHash,
      fileHash: stored.sha256,
      subjectRef,
      buyerOrganizationRef: buyerOrganizationRef(contract.buyerOrganizationId),
      version,
      submittedAt: now,
    });

    const submission = await this.context.store.insert(workSubmissions, {
      id: this.context.ids.next('SUB'),
      contractId,
      version,
      objectId,
      fileHash: stored.sha256,
      evidenceHash: workEvidenceHash(record.evidence),
      fabricTxId: record.fabricTxId,
      buyerDecision: 'PENDING',
      buyerDecisionHash: null,
      decidedAt: null,
      submittedAt: now,
    });

    // The domain state machine routes every submission through IN_PROGRESS,
    // including the first one after funding and every later revision.
    await this.advance(contract.state as WorkContractState, contractId, 'IN_PROGRESS');
    await this.advance('IN_PROGRESS', contractId, 'WORK_SUBMITTED');
    await this.context.timeline.append({
      kind: 'WORK_SUBMITTED',
      actor: this.actor(principal),
      contractId,
      detail: {
        contractId,
        submissionId: submission.id,
        version,
        fileHash: stored.sha256,
        byteLength: stored.byteLength,
        contentType: stored.contentType,
        fabricTxId: record.fabricTxId,
        note: input.note.slice(0, 240),
      },
    });
    return { submission, fabricTxId: record.fabricTxId };
  }

  /**
   * A short-lived signed URL, issued only to a party entitled to the bytes.
   * The raw storage key never leaves the API.
   */
  async access(principal: Principal, submissionId: string) {
    const submission = await this.requireSubmission(submissionId);
    const contract = await this.requireContract(submission.contractId);
    requireReadAccess(principal, contract.buyerOrganizationId, contract.providerOrganizationId);

    const object = await this.context.store.findOne(uploadedObjects, { id: submission.objectId });
    if (!object) throw notFound('The stored deliverable is missing.');
    const signed = await this.context.objects.signedDownloadUrl(
      object.objectKey,
      this.context.config.storage.signedUrlTtlSeconds,
      this.context.clock.now(),
    );
    await this.context.timeline.append({
      kind: 'WORK_ACCESS_GRANTED',
      actor: this.actor(principal),
      contractId: contract.id,
      detail: {
        contractId: contract.id,
        submissionId,
        version: submission.version,
        fileHash: submission.fileHash,
        ttlSeconds: signed.ttlSeconds,
      },
    });
    return {
      url: signed.url,
      expiresAt: signed.expiresAt,
      ttlSeconds: signed.ttlSeconds,
      fileHash: submission.fileHash,
      contentType: object.contentType,
      byteLength: object.byteLength,
    };
  }

  /**
   * The buyer's decision. AI may have produced an advisory validation signal,
   * but only this call records a decision, and only the buyer can make it.
   */
  async decide(principal: Principal, submissionId: string, input: DecideInput) {
    requireRole(principal, 'company_member', 'platform_admin');
    const submission = await this.requireSubmission(submissionId);
    const contract = await this.requireContract(submission.contractId);
    requireOwnership(principal, contract.buyerOrganizationId);
    if (submission.buyerDecision !== 'PENDING') {
      throw conflict(`Version ${submission.version} already has decision ${submission.buyerDecision}.`);
    }

    const advisory = await this.context.ai.evaluate({
      purpose: 'WORK_VALIDATION',
      instruction: 'Assess whether the submitted deliverable looks complete. You are advisory only.',
      facts: { version: submission.version, fileHashPrefix: submission.fileHash.slice(7, 15) },
    });

    const now = this.context.clock.now().toISOString();
    const record = await this.context.fabric.recordDecision({
      dealId: contract.id,
      milestoneId: contract.milestoneId,
      decision: input.decision,
      buyerRef: sha256Text(`optiwork-buyer:${contract.buyerOrganizationId}`).slice(7, 39),
      decidedAt: now,
    });

    const [updated] = await this.context.store.update(workSubmissions, { id: submissionId }, {
      buyerDecision: input.decision,
      buyerDecisionHash: record.evidence.buyerDecisionHash ?? null,
      decidedAt: now,
      evidenceHash: workEvidenceHash(record.evidence),
      fabricTxId: record.fabricTxId,
    });

    const nextState: WorkContractState = input.decision === 'APPROVED'
      ? 'COMPANY_APPROVED'
      : input.decision === 'REVISION_REQUIRED' ? 'REVISION_REQUIRED' : 'DISPUTED';
    await this.advance(contract.state as WorkContractState, contract.id, 'VALIDATION_RECORDED');
    await this.advance('VALIDATION_RECORDED', contract.id, nextState);

    await this.context.timeline.append({
      kind: input.decision === 'APPROVED' ? 'WORK_APPROVED' : 'WORK_REVISION_REQUESTED',
      actor: this.actor(principal),
      contractId: contract.id,
      detail: {
        contractId: contract.id,
        submissionId,
        version: submission.version,
        decision: input.decision,
        fabricTxId: record.fabricTxId,
        evidenceHash: workEvidenceHash(record.evidence),
        advisoryScore: advisory.score,
        advisoryOnly: true,
        comment: input.comment.slice(0, 240),
      },
    });
    return { submission: updated ?? submission, fabricTxId: record.fabricTxId, advisory };
  }

  async latestApproved(contractId: string): Promise<Submission | null> {
    const rows = await this.context.store.findMany(
      workSubmissions,
      { contractId, buyerDecision: 'APPROVED' },
      { orderBy: 'version', direction: 'desc', limit: 1 },
    );
    return rows[0] ?? null;
  }

  async list(contractId: string): Promise<Submission[]> {
    return this.context.store.findMany(workSubmissions, { contractId }, { orderBy: 'version' });
  }

  /** Records a compliance document's commitment against a contract. */
  async recordDocument(
    principal: Principal,
    contractId: string,
    code: string,
    contentType: string,
    bytes: Buffer,
  ) {
    const contract = await this.requireContract(contractId);
    requireReadAccess(principal, contract.buyerOrganizationId, contract.providerOrganizationId);
    if (!ALLOWED_CONTENT_TYPES.includes(contentType)) {
      throw unprocessable(`Content type ${contentType} is not accepted.`);
    }
    const objectId = this.context.ids.next('OBJ');
    const objectKey = objectKeyFor('document', contract.buyerOrganizationId, objectId);
    const stored = await this.context.objects.put(objectKey, bytes, contentType);
    const now = this.context.clock.now().toISOString();
    await this.context.store.insert(uploadedObjects, {
      id: objectId,
      bucket: stored.bucket,
      objectKey: stored.objectKey,
      contentType,
      byteLength: String(stored.byteLength),
      sha256: stored.sha256,
      ownerOrganizationId: contract.buyerOrganizationId,
      classification: 'COMPLIANCE_DOCUMENT',
      createdAt: now,
    });
    const row = await this.context.store.insert(documentHashes, {
      id: this.context.ids.next('DOC'),
      contractId,
      code,
      objectId,
      sha256: stored.sha256,
      byteLength: String(stored.byteLength),
      createdAt: now,
    });
    await this.context.timeline.append({
      kind: 'DOCUMENT_RECORDED',
      actor: this.actor(principal),
      contractId,
      detail: { contractId, code, sha256: stored.sha256, byteLength: stored.byteLength },
    });
    return row;
  }

  async documentCodes(contractId: string): Promise<string[]> {
    const rows = await this.context.store.findMany(documentHashes, { contractId });
    return [...new Set(rows.map((row) => row.code))].sort();
  }

  private async advance(from: WorkContractState, contractId: string, to: WorkContractState): Promise<void> {
    if (from === to) return;
    assertTransition(from, to);
    await this.context.store.update(workContracts, { id: contractId }, {
      state: to,
      updatedAt: this.context.clock.now().toISOString(),
    });
  }

  async requireContract(contractId: string) {
    const contract = await this.context.store.findOne(workContracts, { id: contractId });
    if (!contract) throw notFound(`Unknown contract ${contractId}.`);
    return contract;
  }

  async requireSubmission(submissionId: string): Promise<Submission> {
    const submission = await this.context.store.findOne(workSubmissions, { id: submissionId });
    if (!submission) throw notFound(`Unknown submission ${submissionId}.`);
    return submission;
  }
}
