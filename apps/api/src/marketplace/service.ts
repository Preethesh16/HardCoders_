/**
 * Marketplace workflow.
 *
 * Posting work, applying for it, advisory shortlisting, and the bilateral
 * contract approval that must complete before any money or any ledger is
 * involved. PostgreSQL is authoritative for all of it.
 */

import { assertTransition } from '@optiwork/domain';
import type { WorkContractState } from '@optiwork/contracts';
import { canonicalHash } from '../canonical.js';
import type { AppContext } from '../context.js';
import { conflict, forbidden, notFound, unprocessable } from '../errors.js';
import {
  aiEvaluationCitations,
  aiEvaluations,
  applications,
  contractApprovals,
  jobs,
  memberships,
  organizations,
  uploadedObjects,
  users,
  workContracts,
} from '../db/schema.js';
import { money, type Money } from '../money.js';
import { requireOwnership, requireReadAccess, requireRole, type Principal } from '../auth/authorization.js';
import type { Select } from '../db/store.js';
import { objectKeyFor } from '../storage/object-store.js';

export type Job = Select<typeof jobs>;
export type Application = Select<typeof applications>;
export type WorkContract = Select<typeof workContracts>;

export interface CreateJobInput {
  readonly title: string;
  readonly description: string;
  readonly skills: readonly string[];
  readonly acceptanceCriteria?: readonly string[];
  readonly targetDeliveryDate?: string;
  readonly destinationCountry: string;
  readonly budget: Money;
}

export interface ApplyInput {
  readonly coverLetter: string;
  readonly approach?: string;
  readonly proposedSkills?: readonly string[];
  readonly proposedPrice?: Money;
  readonly deliveryDays?: number;
  readonly deliveryDate?: string;
  readonly availability?: string;
  readonly resumeObjectId?: string;
}

export interface AgreementTermsInput {
  readonly policies: readonly string[];
  readonly legalClauses: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly commercialTerms: readonly string[];
}

export interface ApproveContractInput {
  readonly party: 'BUYER' | 'PROVIDER';
  readonly acceptedTermsHash: string;
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export class MarketplaceService {
  constructor(private readonly context: AppContext) {}

  private actor(principal: Principal) {
    return { subject: principal.subject, role: principal.roles[0] ?? 'unknown' };
  }

  async createJob(principal: Principal, input: CreateJobInput): Promise<Job> {
    requireRole(principal, 'company_member', 'platform_admin');
    if (input.skills.length === 0) throw unprocessable('A job needs at least one skill.');
    if (BigInt(input.budget.amountMinor) <= 0n) throw unprocessable('A job needs a positive budget.');
    if (input.targetDeliveryDate !== undefined && !isIsoDate(input.targetDeliveryDate)) {
      throw unprocessable('The target delivery date is invalid.');
    }

    const organization = await this.context.store.findOne(organizations, { id: principal.organizationId });
    if (!organization) throw notFound(`Unknown organization ${principal.organizationId}.`);

    const job = await this.context.store.insert(jobs, {
      id: this.context.ids.next('JOB'),
      organizationId: principal.organizationId,
      createdByUserId: principal.subject,
      title: input.title,
      description: input.description,
      skills: [...input.skills],
      acceptanceCriteria: input.acceptanceCriteria === undefined ? null : [...input.acceptanceCriteria],
      targetDeliveryDate: input.targetDeliveryDate ?? null,
      destinationCountry: input.destinationCountry,
      budgetAmountMinor: input.budget.amountMinor,
      budgetCurrency: input.budget.currency,
      budgetScale: input.budget.scale,
      status: 'OPEN',
      createdAt: this.context.clock.now().toISOString(),
    });
    await this.context.timeline.append({
      kind: 'JOB_POSTED',
      actor: this.actor(principal),
      detail: {
        jobId: job.id,
        organizationId: job.organizationId,
        destinationCountry: job.destinationCountry,
        budgetMinor: job.budgetAmountMinor,
        budgetCurrency: job.budgetCurrency,
      },
    });
    return job;
  }

  async listJobs(principal: Principal): Promise<Job[]> {
    requireRole(principal, 'company_member', 'freelancer', 'supplier', 'platform_admin', 'audit_service', 'provider_operator');
    const all = await this.context.store.findMany(jobs, {}, { orderBy: 'createdAt', direction: 'desc' });
    // Companies see only their own postings; talent sees every open posting.
    if (principal.roles.includes('company_member')) {
      return all.filter((job) => job.organizationId === principal.organizationId);
    }
    if (principal.roles.includes('freelancer') || principal.roles.includes('supplier')) {
      return all.filter((job) => job.status === 'OPEN');
    }
    return all;
  }

  async apply(principal: Principal, jobId: string, input: ApplyInput): Promise<Application> {
    requireRole(principal, 'freelancer', 'supplier');
    const job = await this.requireJob(jobId);
    if (job.status !== 'OPEN') throw conflict(`Job ${jobId} is not accepting applications.`);
    if (job.organizationId === principal.organizationId) {
      throw unprocessable('An organization cannot apply to its own posting.');
    }
    const existing = await this.context.store.findOne(applications, { jobId, applicantUserId: principal.subject });
    if (existing) throw conflict('You have already applied to this job.');
    const proposedPrice = input.proposedPrice ?? money(
      job.budgetAmountMinor,
      job.budgetCurrency,
      job.budgetScale,
    );
    if (BigInt(proposedPrice.amountMinor) <= 0n) throw unprocessable('A proposal needs a positive price.');
    if (proposedPrice.currency !== job.budgetCurrency || proposedPrice.scale !== job.budgetScale) {
      throw unprocessable(`Proposal prices must use the job denomination ${job.budgetCurrency}/${job.budgetScale}.`);
    }
    const deliveryDays = input.deliveryDays ?? 30;
    if (!Number.isInteger(deliveryDays) || deliveryDays < 1 || deliveryDays > 730) {
      throw unprocessable('Delivery days must be an integer between 1 and 730.');
    }
    if (input.deliveryDate !== undefined && !isIsoDate(input.deliveryDate)) {
      throw unprocessable('The proposed delivery date is invalid.');
    }
    const proposedSkills = input.proposedSkills ?? job.skills;
    if (proposedSkills.length === 0) throw unprocessable('A proposal needs at least one relevant skill.');

    const application = await this.context.store.insert(applications, {
      id: this.context.ids.next('APP'),
      jobId,
      applicantUserId: principal.subject,
      applicantOrganizationId: principal.organizationId,
      coverLetter: input.coverLetter,
      approach: input.approach ?? input.coverLetter,
      proposedSkills: [...proposedSkills],
      proposedAmountMinor: proposedPrice.amountMinor,
      proposedCurrency: proposedPrice.currency,
      proposedScale: proposedPrice.scale,
      deliveryDays,
      deliveryDate: input.deliveryDate ?? null,
      availability: input.availability ?? 'Available after selection.',
      resumeObjectId: input.resumeObjectId ?? null,
      status: 'SUBMITTED',
      createdAt: this.context.clock.now().toISOString(),
    });
    await this.context.timeline.append({
      kind: 'APPLICATION_SUBMITTED',
      actor: this.actor(principal),
      detail: { jobId, applicationId: application.id, applicantOrganizationId: principal.organizationId },
    });
    return application;
  }

  async listApplications(principal: Principal, jobId: string): Promise<Application[]> {
    const job = await this.requireJob(jobId);
    requireReadAccess(principal, job.organizationId);
    return this.context.store.findMany(applications, { jobId }, { orderBy: 'createdAt' });
  }

  /** Buyer-only enriched proposal view used by the hiring workspace. */
  async applicationViews(principal: Principal, jobId: string) {
    const rows = await this.listApplications(principal, jobId);
    return Promise.all(rows.map(async (application) => {
      const applicant = await this.context.store.findOne(users, { id: application.applicantUserId });
      const evaluations = await this.context.store.findMany(
        aiEvaluations,
        { applicationId: application.id, purpose: 'APPLICATION_SCORING' },
        { orderBy: 'createdAt', direction: 'desc', limit: 1 },
      );
      return {
        ...application,
        applicant: {
          label: applicant?.displayName ?? 'Verified professional',
          country: applicant?.country ?? 'ZZ',
        },
        evaluation: evaluations[0] ?? null,
      };
    }));
  }

  /** A freelancer sees only their own proposals, paired with the public job. */
  async myApplications(principal: Principal) {
    requireRole(principal, 'freelancer', 'supplier');
    const rows = await this.context.store.findMany(
      applications,
      { applicantUserId: principal.subject },
      { orderBy: 'createdAt', direction: 'desc' },
    );
    return Promise.all(rows.map(async (application) => ({
      application,
      job: await this.requireJob(application.jobId),
    })));
  }

  /** Rank every proposal for one job. This never performs human selection. */
  async rankApplications(principal: Principal, jobId: string) {
    const rows = await this.listApplications(principal, jobId);
    if (rows.length === 0) throw conflict(`Job ${jobId} has no applications to rank.`);
    const ranked = [];
    for (const application of rows) {
      const result = await this.evaluateApplication(principal, application.id);
      const applicant = await this.context.store.findOne(users, { id: application.applicantUserId });
      ranked.push({
        applicationId: application.id,
        score: result.evaluation.score,
        summary: result.evaluation.summary,
        source: result.evaluation.source,
        advisoryOnly: true,
        applicant: {
          label: applicant?.displayName ?? 'Verified professional',
          country: applicant?.country ?? 'ZZ',
        },
        proposal: {
          price: money(application.proposedAmountMinor, application.proposedCurrency, application.proposedScale),
          deliveryDays: application.deliveryDays,
          deliveryDate: application.deliveryDate,
          availability: application.availability,
          approach: application.approach,
          skills: application.proposedSkills,
        },
      });
    }
    return ranked.sort((left, right) =>
      right.score - left.score
      || left.proposal.deliveryDays - right.proposal.deliveryDays
      || left.applicationId.localeCompare(right.applicationId));
  }

  /**
   * Advisory shortlisting. The result is stored with its citations, model and
   * prompt hash, and is explicitly marked advisory: selecting an applicant is
   * always a human action performed by `selectApplicant`.
   */
  async evaluateApplication(principal: Principal, applicationId: string) {
    requireRole(principal, 'company_member', 'platform_admin');
    const application = await this.requireApplication(applicationId);
    const job = await this.requireJob(application.jobId);
    requireOwnership(principal, job.organizationId);

    const applicantUser = await this.context.store.findOne(users, { id: application.applicantUserId });
    const priorContracts = (await this.context.store.findMany(workContracts, {
      providerUserId: application.applicantUserId,
      state: 'COMPLETED' satisfies WorkContractState,
    })).length;
    const declaredSkills = new Set(application.proposedSkills.map((skill) => skill.toLowerCase()));
    const proposalText = `${application.coverLetter} ${application.approach}`.toLowerCase();
    const skillMatches = job.skills.filter((skill) =>
      declaredSkills.has(skill.toLowerCase()) || proposalText.includes(skill.toLowerCase())).length;

    const result = await this.context.ai.evaluate({
      purpose: 'APPLICATION_SCORING',
      instruction: 'Score how well this application matches the posted work. You are advisory only.',
      facts: {
        // Opaque, non-identifying facts only.
        jobSkillCount: job.skills.length,
        skillMatches,
        proposedSkillCount: application.proposedSkills.length,
        priorContracts,
        coverLetterLength: application.coverLetter.length,
        approachLength: application.approach.length,
        proposedAmountMinor: application.proposedAmountMinor,
        proposedCurrency: application.proposedCurrency,
        deliveryDays: application.deliveryDays,
        availabilityLength: application.availability.length,
        availableImmediately: /immediate|now|within [0-3] (?:day|business day)/iu.test(application.availability),
        jobBudgetAmountMinor: job.budgetAmountMinor,
        destinationCountry: job.destinationCountry,
        applicantCountry: applicantUser?.country ?? 'ZZ',
      },
    });

    const evaluation = await this.context.store.insert(aiEvaluations, {
      id: this.context.ids.next('AIE'),
      applicationId,
      purpose: result.purpose,
      score: result.score,
      summary: result.summary,
      advisoryOnly: true,
      source: result.source,
      model: result.model,
      fixtureId: result.fixtureId ?? null,
      promptHash: result.promptHash,
      createdAt: this.context.clock.now().toISOString(),
    });
    const citations = [];
    for (const [index, citation] of result.citations.entries()) {
      citations.push(await this.context.store.insert(aiEvaluationCitations, {
        id: this.context.ids.next('AIC'),
        evaluationId: evaluation.id,
        ordinal: index + 1,
        sourceUri: citation.sourceUri,
        sourceVersion: citation.sourceVersion,
        quote: citation.quote,
      }));
    }
    await this.context.store.update(applications, { id: applicationId }, { status: 'EVALUATED' });
    await this.context.timeline.append({
      kind: 'APPLICATION_EVALUATED',
      actor: this.actor(principal),
      detail: {
        applicationId,
        evaluationId: evaluation.id,
        score: evaluation.score,
        source: evaluation.source,
        advisoryOnly: true,
      },
    });
    return { evaluation, citations };
  }

  /**
   * Selecting an applicant drafts the contract. Drafting text may be AI
   * assisted; the terms only bind once both parties approve.
   */
  async selectApplicant(principal: Principal, applicationId: string, amount: Money): Promise<WorkContract> {
    requireRole(principal, 'company_member', 'platform_admin');
    const application = await this.requireApplication(applicationId);
    const job = await this.requireJob(application.jobId);
    requireOwnership(principal, job.organizationId);
    if (BigInt(amount.amountMinor) <= 0n) throw unprocessable('The agreed amount must be positive.');
    if (amount.currency !== job.budgetCurrency || amount.scale !== job.budgetScale) {
      throw unprocessable(`The agreed amount must use the job denomination ${job.budgetCurrency}/${job.budgetScale}.`);
    }

    const existingForJob = await this.context.store.findOne(workContracts, { jobId: job.id });
    if (existingForJob) {
      if (existingForJob.applicationId === applicationId) return existingForJob;
      throw conflict(`Job ${job.id} already has a selected provider.`);
    }

    const drafted = await this.context.ai.evaluate({
      purpose: 'CONTRACT_DRAFTING',
      instruction: 'Draft neutral milestone terms for this engagement. You are advisory only.',
      facts: {
        skills: [...job.skills],
        currency: amount.currency,
        destinationCountry: job.destinationCountry,
        milestoneCount: 1,
      },
    });

    const now = this.context.clock.now().toISOString();
    const contractId = this.context.ids.next('WC');
    const milestoneId = this.context.ids.next('MS');
    const baselineTerms: AgreementTermsInput = {
      policies: ['Work and payment records remain private to the selected parties.'],
      legalClauses: ['This prototype agreement is for demonstration and is not legal advice.'],
      acceptanceCriteria: job.acceptanceCriteria?.length
        ? job.acceptanceCriteria
        : ['The buyer reviews the submitted milestone and records a decision.'],
      commercialTerms: [`Agreed amount: ${amount.amountMinor} ${amount.currency} minor units at scale ${amount.scale}.`],
    };
    const agreement = await this.storeAgreement({
      contractId,
      version: 1,
      job,
      application,
      amount,
      input: baselineTerms,
      draftingSummary: drafted.summary,
    });
    const contract = await this.context.store.insert(workContracts, {
      id: contractId,
      jobId: job.id,
      applicationId,
      buyerOrganizationId: job.organizationId,
      providerOrganizationId: application.applicantOrganizationId,
      providerUserId: application.applicantUserId,
      state: 'CANDIDATE_SELECTED' satisfies WorkContractState,
      terms: agreement.text,
      contractHash: agreement.contractHash,
      agreementObjectId: agreement.objectId,
      agreementArtifactHash: agreement.artifactHash,
      agreementVersion: agreement.version,
      agreementTerms: agreement.terms,
      milestoneId,
      milestoneHash: canonicalHash({ milestoneId, contractHash: agreement.contractHash, ordinal: 1 }),
      amountMinor: amount.amountMinor,
      amountCurrency: amount.currency,
      amountScale: amount.scale,
      createdAt: now,
      updatedAt: now,
    });
    const jobApplications = await this.context.store.findMany(applications, { jobId: job.id });
    for (const candidate of jobApplications) {
      await this.context.store.update(applications, { id: candidate.id }, {
        status: candidate.id === applicationId ? 'SELECTED' : 'NOT_SELECTED',
      });
    }
    await this.context.store.update(jobs, { id: job.id }, { status: 'CANDIDATE_SELECTED' });
    await this.context.timeline.append({
      kind: 'CONTRACT_DRAFTED',
      actor: this.actor(principal),
      contractId: contract.id,
      detail: {
        contractId: contract.id,
        applicationId,
        contractHash: agreement.contractHash,
        agreementArtifactHash: agreement.artifactHash,
        agreementVersion: agreement.version,
        milestoneId,
        amountMinor: contract.amountMinor,
        amountCurrency: contract.amountCurrency,
        draftingSource: drafted.source,
      },
    });
    return contract;
  }

  /**
   * Replaces the baseline agreement with company-supplied terms. Previous
   * artifact bytes remain immutable in object storage, while the contract can
   * only move to the new hash before either party has approved it.
   */
  async prepareAgreement(principal: Principal, contractId: string, input: AgreementTermsInput) {
    requireRole(principal, 'company_member', 'platform_admin');
    const contract = await this.requireContract(contractId);
    requireOwnership(principal, contract.buyerOrganizationId);
    if (contract.state !== 'CANDIDATE_SELECTED') {
      throw conflict(`Agreement terms cannot change in state ${contract.state}.`);
    }
    if ((await this.approvals(contractId)).length > 0) {
      throw conflict('Agreement terms cannot change after either party has approved them.');
    }
    const job = await this.requireJob(contract.jobId);
    const application = await this.requireApplication(contract.applicationId);
    const drafted = await this.context.ai.evaluate({
      purpose: 'CONTRACT_DRAFTING',
      instruction: 'Formalize the supplied agreement headings without changing their meaning. You are advisory only.',
      facts: {
        policyCount: input.policies.length,
        legalClauseCount: input.legalClauses.length,
        acceptanceCriterionCount: input.acceptanceCriteria.length,
        commercialTermCount: input.commercialTerms.length,
        destinationCountry: job.destinationCountry,
      },
    });
    const agreement = await this.storeAgreement({
      contractId,
      version: contract.agreementVersion + 1,
      job,
      application,
      amount: this.contractAmount(contract),
      input,
      draftingSummary: drafted.summary,
    });
    const [updated] = await this.context.store.update(workContracts, { id: contractId }, {
      terms: agreement.text,
      contractHash: agreement.contractHash,
      milestoneHash: canonicalHash({
        milestoneId: contract.milestoneId,
        contractHash: agreement.contractHash,
        ordinal: 1,
      }),
      agreementObjectId: agreement.objectId,
      agreementArtifactHash: agreement.artifactHash,
      agreementVersion: agreement.version,
      agreementTerms: agreement.terms,
      updatedAt: this.context.clock.now().toISOString(),
    });
    await this.context.timeline.append({
      kind: 'AGREEMENT_PREPARED',
      actor: this.actor(principal),
      contractId,
      detail: {
        contractId,
        agreementVersion: agreement.version,
        agreementArtifactHash: agreement.artifactHash,
        contractHash: agreement.contractHash,
        draftingSource: drafted.source,
      },
    });
    return { contract: updated ?? contract, agreement: this.agreementMetadata(updated ?? contract) };
  }

  /** Only the buyer and selected provider can receive the signed document URL. */
  async agreementAccess(principal: Principal, contractId: string) {
    const contract = await this.requireContract(contractId);
    if (![contract.buyerOrganizationId, contract.providerOrganizationId].includes(principal.organizationId)) {
      throw forbidden('The private agreement is available only to its two contract parties.');
    }
    if (!contract.agreementObjectId || !contract.agreementArtifactHash) {
      throw notFound(`Contract ${contractId} has no agreement artifact.`);
    }
    const object = await this.context.store.findOne(uploadedObjects, { id: contract.agreementObjectId });
    if (!object || object.classification !== 'LEGAL_AGREEMENT') {
      throw notFound('The private agreement artifact is missing.');
    }
    const signed = await this.context.objects.signedDownloadUrl(
      object.objectKey,
      this.context.config.storage.signedUrlTtlSeconds,
      this.context.clock.now(),
    );
    await this.context.timeline.append({
      kind: 'AGREEMENT_ACCESS_GRANTED',
      actor: this.actor(principal),
      contractId,
      detail: {
        contractId,
        agreementVersion: contract.agreementVersion,
        agreementArtifactHash: contract.agreementArtifactHash,
        ttlSeconds: signed.ttlSeconds,
      },
    });
    return {
      url: signed.url,
      expiresAt: signed.expiresAt,
      ttlSeconds: signed.ttlSeconds,
      fileName: `anchor-agreement-v${contract.agreementVersion}.md`,
      contentType: object.contentType,
      byteLength: object.byteLength,
      artifactHash: contract.agreementArtifactHash,
      contractHash: contract.contractHash,
      version: contract.agreementVersion,
    };
  }

  agreementMetadata(contract: WorkContract) {
    return {
      version: contract.agreementVersion,
      artifactHash: contract.agreementArtifactHash,
      contractHash: contract.contractHash,
      contentType: 'text/markdown',
      fileName: `anchor-agreement-v${contract.agreementVersion}.md`,
      available: Boolean(contract.agreementObjectId && contract.agreementArtifactHash),
    };
  }

  private async storeAgreement(args: {
    contractId: string;
    version: number;
    job: Job;
    application: Application;
    amount: Money;
    input: AgreementTermsInput;
    draftingSummary: string;
  }) {
    const clean = (values: readonly string[]) => values.map((value) => value.trim()).filter(Boolean);
    const terms = {
      policies: clean(args.input.policies),
      legalClauses: clean(args.input.legalClauses),
      acceptanceCriteria: clean(args.input.acceptanceCriteria),
      commercialTerms: clean(args.input.commercialTerms),
    };
    if (terms.legalClauses.length === 0 || terms.acceptanceCriteria.length === 0) {
      throw unprocessable('An agreement needs at least one legal clause and one acceptance criterion.');
    }
    const section = (title: string, values: readonly string[]) => [
      `## ${title}`,
      '',
      ...(values.length === 0 ? ['- None supplied.'] : values.map((value) => `- ${value}`)),
      '',
    ];
    const lines = [
      '# Anchor private work agreement',
      '',
      `Agreement version: ${args.version}`,
      `Job reference: ${args.job.id}`,
      `Application reference: ${args.application.id}`,
      `Buyer organization reference: ${args.job.organizationId}`,
      `Provider organization reference: ${args.application.applicantOrganizationId}`,
      `Scope: ${args.job.title}`,
      `Target delivery date: ${args.job.targetDeliveryDate ?? 'Not specified'}`,
      `Agreed price: ${args.amount.amountMinor} ${args.amount.currency} minor units (scale ${args.amount.scale})`,
      `Proposal delivery estimate: ${args.application.deliveryDays} days`,
      `Proposal availability: ${args.application.availability}`,
      '',
      ...section('Company policies', terms.policies),
      ...section('Legal clauses', terms.legalClauses),
      ...section('Acceptance criteria', terms.acceptanceCriteria),
      ...section('Commercial terms', terms.commercialTerms),
      '## Advisory drafting note',
      '',
      args.draftingSummary.trim(),
      '',
      'This demonstration document is not legal, tax, KYC, banking, or regulatory advice.',
      '',
    ];
    const text = lines.join('\n');
    const bytes = Buffer.from(text, 'utf8');
    const objectId = this.context.ids.next('OBJ');
    const objectKey = objectKeyFor('agreement', args.job.organizationId, objectId);
    const stored = await this.context.objects.put(objectKey, bytes, 'text/markdown');
    await this.context.store.insert(uploadedObjects, {
      id: objectId,
      bucket: stored.bucket,
      objectKey: stored.objectKey,
      contentType: stored.contentType,
      byteLength: String(stored.byteLength),
      sha256: stored.sha256,
      ownerOrganizationId: args.job.organizationId,
      classification: 'LEGAL_AGREEMENT',
      createdAt: this.context.clock.now().toISOString(),
    });
    const contractHash = canonicalHash({
      contractId: args.contractId,
      agreementVersion: args.version,
      artifactHash: stored.sha256,
      jobId: args.job.id,
      applicationId: args.application.id,
      buyerOrganizationId: args.job.organizationId,
      providerOrganizationId: args.application.applicantOrganizationId,
      proposal: {
        amountMinor: args.application.proposedAmountMinor,
        currency: args.application.proposedCurrency,
        scale: args.application.proposedScale,
        deliveryDays: args.application.deliveryDays,
        deliveryDate: args.application.deliveryDate,
        availability: args.application.availability,
        approach: args.application.approach,
        skills: args.application.proposedSkills,
      },
      agreedAmount: args.amount,
      companyTerms: terms,
    });
    return {
      objectId,
      artifactHash: stored.sha256,
      contractHash,
      version: args.version,
      terms,
      text,
    };
  }

  /**
   * Bilateral approval. The contract only advances to `RULES_VERIFIED` once
   * both the buying organization and the provider have approved the exact same
   * terms hash.
   */
  async approveContract(principal: Principal, contractId: string, input: ApproveContractInput) {
    const contract = await this.requireContract(contractId);
    if (input.acceptedTermsHash !== contract.contractHash) {
      throw conflict('The approved terms hash does not match the current contract.');
    }
    const organizationId = input.party === 'BUYER' ? contract.buyerOrganizationId : contract.providerOrganizationId;
    if (input.party === 'BUYER') requireRole(principal, 'company_member', 'platform_admin');
    else requireRole(principal, 'freelancer', 'supplier', 'platform_admin');
    requireOwnership(principal, organizationId);

    const existing = await this.context.store.findOne(contractApprovals, { contractId, party: input.party });
    if (existing) return { contract, approvals: await this.approvals(contractId), replay: true };

    if (contract.state !== 'CANDIDATE_SELECTED' && contract.state !== 'PARTY_APPROVAL_PENDING') {
      throw conflict(`Contract ${contractId} is not awaiting party approval.`);
    }
    await this.context.store.insert(contractApprovals, {
      id: this.context.ids.next('CA'),
      contractId,
      organizationId,
      userId: principal.subject,
      party: input.party,
      approvalHash: canonicalHash({ contractId, party: input.party, contractHash: contract.contractHash }),
      approvedAt: this.context.clock.now().toISOString(),
    });

    const approvals = await this.approvals(contractId);
    const complete = approvals.some((a) => a.party === 'BUYER') && approvals.some((a) => a.party === 'PROVIDER');
    const nextState: WorkContractState = complete ? 'RULES_VERIFIED' : 'PARTY_APPROVAL_PENDING';
    assertTransition(contract.state as WorkContractState, nextState);
    const [updated] = await this.context.store.update(workContracts, { id: contractId }, {
      state: nextState,
      updatedAt: this.context.clock.now().toISOString(),
    });
    await this.context.timeline.append({
      kind: 'CONTRACT_APPROVED',
      actor: this.actor(principal),
      contractId,
      detail: { contractId, party: input.party, bothPartiesApproved: complete, state: nextState },
    });
    return { contract: updated ?? contract, approvals, replay: false };
  }

  async approvals(contractId: string) {
    return this.context.store.findMany(contractApprovals, { contractId }, { orderBy: 'approvedAt' });
  }

  async requireJob(jobId: string): Promise<Job> {
    const job = await this.context.store.findOne(jobs, { id: jobId });
    if (!job) throw notFound(`Unknown job ${jobId}.`);
    return job;
  }

  async requireApplication(applicationId: string): Promise<Application> {
    const application = await this.context.store.findOne(applications, { id: applicationId });
    if (!application) throw notFound(`Unknown application ${applicationId}.`);
    return application;
  }

  async requireContract(contractId: string): Promise<WorkContract> {
    const contract = await this.context.store.findOne(workContracts, { id: contractId });
    if (!contract) throw notFound(`Unknown contract ${contractId}.`);
    return contract;
  }

  contractAmount(contract: WorkContract): Money {
    return money(contract.amountMinor, contract.amountCurrency, contract.amountScale);
  }

  /** Ensures a principal's membership matches the organization it claims. */
  async assertMembership(principal: Principal): Promise<void> {
    const membership = await this.context.store.findOne(memberships, {
      userId: principal.subject,
      organizationId: principal.organizationId,
    });
    if (!membership) throw conflict('The principal is not a member of the organization it claims.');
  }
}
