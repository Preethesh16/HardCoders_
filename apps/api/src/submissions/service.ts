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
import { conflict, forbidden, notFound, unprocessable } from '../errors.js';
import { contractMilestones, documentHashes, uploadedObjects, workContracts, workSubmissions } from '../db/schema.js';
import { requireOwnership, requireReadAccess, requireRole, type Principal } from '../auth/authorization.js';
import { ALLOWED_CONTENT_TYPES, MAX_OBJECT_BYTES, objectKeyFor } from '../storage/object-store.js';
import { buyerOrganizationRef, workEvidenceHash } from '../fabric/evidence-reader.js';
import type { Select } from '../db/store.js';
import { sha256Text } from '../runtime.js';
import { canonicalHash } from '../canonical.js';

export type Submission = Select<typeof workSubmissions>;

export interface SubmitWorkInput {
  readonly milestoneId?: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly contentBase64: string;
  readonly note: string;
}

export interface DecideInput {
  readonly decision: 'APPROVED' | 'REVISION_REQUIRED' | 'DISPUTED';
  readonly comment: string;
}

function decodeBase64(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(value) || value.length % 4 === 1) {
    throw unprocessable('The deliverable is not valid base64.');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64').replace(/=+$/u, '') !== value.replace(/=+$/u, '')) {
    throw unprocessable('The deliverable is not canonical base64.');
  }
  return bytes;
}

function assertSafeContentType(value: string): void {
  if (!value.includes('/') || /[\r\n\0]/u.test(value)) {
    throw unprocessable('The deliverable content type is invalid.');
  }
}

export class SubmissionService {
  constructor(private readonly context: AppContext) {}

  private actor(principal: Principal) {
    return { subject: principal.subject, role: principal.roles[0] ?? 'unknown' };
  }

  private fabricActor(principal: Principal) {
    const role = principal.roles.find((candidate) =>
      candidate === 'company_member' || candidate === 'freelancer' || candidate === 'supplier');
    if (role === undefined) throw unprocessable('This actor has no Fabric evidence role.');
    return { subject: principal.subject, organizationId: principal.organizationId, role };
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
    const milestones = await this.context.store.findMany(contractMilestones, { contractId }, { orderBy: 'ordinal' });
    const milestone = input.milestoneId
      ? milestones.find((candidate) => candidate.id === input.milestoneId)
      : milestones.length === 1 ? milestones[0] : undefined;
    if (!milestone) throw unprocessable('A valid funded milestone is required for this delivery.');
    const legacySingleMilestoneFunded = milestones.length === 1
      && milestone.state === 'PENDING'
      && ['ESCROW_FUNDED', 'IN_PROGRESS', 'REVISION_REQUIRED'].includes(contract.state);
    if (!legacySingleMilestoneFunded && !['FUNDED', 'REVISION_REQUIRED'].includes(milestone.state)) {
      throw conflict(`Milestone ${milestone.id} is not accepting a delivery in state ${milestone.state}.`);
    }
    // Deliverables may be source archives, design files, media, binaries or
    // another client-declared type. We constrain control characters and size,
    // but intentionally do not maintain a brittle MIME allowlist.
    assertSafeContentType(input.contentType);
    const bytes = decodeBase64(input.contentBase64);
    if (bytes.byteLength === 0) throw unprocessable('The deliverable is empty.');
    if (bytes.byteLength > MAX_OBJECT_BYTES) {
      throw unprocessable(`The deliverable exceeds ${MAX_OBJECT_BYTES} bytes.`);
    }

    const previous = await this.context.store.findMany(
      workSubmissions,
      { contractId, milestoneId: milestone.id },
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
    // Revisions are new immutable versions of the same Fabric aggregate. The
    // evidence identifier is allocated before the first write and persisted in
    // PostgreSQL so decisions and releases can always address it directly.
    const evidenceId = latest?.evidenceId ?? this.context.ids.next('EV');
    const record = await this.context.fabric.recordSubmission(this.fabricActor(principal), {
      dealId: contract.id,
      milestoneId: milestone.id,
      evidenceId,
      contractHash: contract.contractHash,
      milestoneHash: canonicalHash({
        milestoneId: milestone.id,
        contractHash: contract.contractHash,
        ordinal: milestone.ordinal,
        title: milestone.title,
        deliverable: milestone.deliverable,
        acceptanceCriteria: milestone.acceptanceCriteria,
        amountMinor: milestone.amountMinor,
        amountCurrency: milestone.amountCurrency,
        amountScale: milestone.amountScale,
      }),
      fileHash: stored.sha256,
      subjectRef,
      buyerOrganizationRef: buyerOrganizationRef(contract.buyerOrganizationId),
      version,
      submittedAt: now,
    });

    const submission = await this.context.store.insert(workSubmissions, {
      id: this.context.ids.next('SUB'),
      contractId,
      milestoneId: milestone.id,
      evidenceId,
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
    await this.context.store.update(contractMilestones, { id: milestone.id }, {
      state: 'SUBMITTED',
      updatedAt: now,
    });
    await this.context.timeline.append({
      kind: 'WORK_SUBMITTED',
      actor: this.actor(principal),
      contractId,
      detail: {
        contractId,
        submissionId: submission.id,
        milestoneId: milestone.id,
        milestoneOrdinal: milestone.ordinal,
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
    if (![contract.buyerOrganizationId, contract.providerOrganizationId].includes(principal.organizationId)) {
      throw forbidden('The deliverable is available only to its two contract parties.');
    }

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
   * Runs the advisory work-validation agent as its own visible stage. The
   * result is persisted in the contract timeline so a human decision can
   * never be confused with an AI recommendation.
   */
  async evaluate(principal: Principal, submissionId: string) {
    requireRole(principal, 'company_member', 'platform_admin');
    const submission = await this.requireSubmission(submissionId);
    const contract = await this.requireContract(submission.contractId);
    requireOwnership(principal, contract.buyerOrganizationId);
    if (submission.buyerDecision !== 'PENDING') {
      throw conflict(`Version ${submission.version} already has decision ${submission.buyerDecision}.`);
    }

    const existing = (await this.context.timeline.forContract(contract.id))
      .filter((event) => event.kind === 'WORK_EVALUATED'
        && (event.detail as Record<string, unknown>)['submissionId'] === submissionId)
      .at(-1);
    if (existing) return { advisory: existing.detail, replay: true };

    const result = await this.context.ai.evaluate({
      purpose: 'WORK_VALIDATION',
      instruction: 'Assess whether the submitted deliverable looks complete. You are advisory only.',
      facts: {
        version: submission.version,
        fileHashPrefix: submission.fileHash.slice(7, 15),
        contractHashPrefix: contract.contractHash.slice(7, 15),
      },
    });
    const advisory = {
      submissionId,
      version: submission.version,
      score: result.score,
      summary: result.summary,
      source: result.source,
      model: result.model,
      promptHash: result.promptHash,
      advisoryOnly: true,
    };
    await this.context.timeline.append({
      kind: 'WORK_EVALUATED',
      actor: this.actor(principal),
      contractId: contract.id,
      detail: advisory,
    });
    return { advisory, replay: false };
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

    let validation = (await this.context.timeline.forContract(contract.id))
      .filter((event) => event.kind === 'WORK_EVALUATED'
        && (event.detail as Record<string, unknown>)['submissionId'] === submissionId)
      .at(-1);
    if (!validation) {
      // Backwards-compatible safety net for API clients created before the
      // explicit validation endpoint existed. The product UI always calls the
      // visible validation stage first.
      await this.evaluate(principal, submissionId);
      validation = (await this.context.timeline.forContract(contract.id))
        .filter((event) => event.kind === 'WORK_EVALUATED'
          && (event.detail as Record<string, unknown>)['submissionId'] === submissionId)
        .at(-1);
    }
    if (!validation) throw conflict('The advisory work validation could not be recorded.');
    const advisory = validation.detail as Record<string, unknown>;

    const now = this.context.clock.now().toISOString();
    const record = await this.context.fabric.recordDecision(this.fabricActor(principal), {
      evidenceId: submission.evidenceId,
      decision: input.decision,
      expectedFileHash: submission.fileHash,
      expectedVersion: submission.version,
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
    await this.context.store.update(contractMilestones, { id: submission.milestoneId }, {
      state: input.decision === 'APPROVED' ? 'APPROVED' : input.decision === 'REVISION_REQUIRED' ? 'REVISION_REQUIRED' : 'DISPUTED',
      updatedAt: now,
    });

    await this.context.timeline.append({
      kind: input.decision === 'APPROVED' ? 'WORK_APPROVED' : 'WORK_REVISION_REQUESTED',
      actor: this.actor(principal),
      contractId: contract.id,
      detail: {
        contractId: contract.id,
        submissionId,
        milestoneId: submission.milestoneId,
        version: submission.version,
        decision: input.decision,
        fabricTxId: record.fabricTxId,
        evidenceHash: workEvidenceHash(record.evidence),
        advisoryScore: advisory['score'],
        advisoryOnly: true,
        comment: input.comment.slice(0, 240),
      },
    });
    return { submission: updated ?? submission, fabricTxId: record.fabricTxId, advisory };
  }

  async latestApproved(contractId: string, milestoneId?: string): Promise<Submission | null> {
    const rows = await this.context.store.findMany(
      workSubmissions,
      { contractId, ...(milestoneId ? { milestoneId } : {}), buyerDecision: 'APPROVED' },
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
