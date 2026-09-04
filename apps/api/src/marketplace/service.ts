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
  companyPolicyProfiles,
  contractMilestones,
  contractApprovals,
  jobs,
  memberships,
  organizations,
  uploadedObjects,
  users,
  workContracts,
} from '../db/schema.js';
import { money, sameDenomination, type Money } from '../money.js';
import { requireOwnership, requireReadAccess, requireRole, type Principal } from '../auth/authorization.js';
import type { Select } from '../db/store.js';
import { objectKeyFor } from '../storage/object-store.js';
import { inspect } from '../corridor/service.js';

export type Job = Select<typeof jobs>;
export type Application = Select<typeof applications>;
export type WorkContract = Select<typeof workContracts>;
export type CompanyPolicyProfile = Select<typeof companyPolicyProfiles>;

export interface CreateJobInput {
  readonly title: string;
  readonly description: string;
  readonly skills: readonly string[];
  readonly acceptanceCriteria?: readonly string[];
  readonly targetDeliveryDate?: string;
  readonly payerCountry: string;
  readonly fundingCurrency: string;
  readonly destinationCountry: string;
  readonly budget: Money;
  readonly milestones?: readonly JobMilestoneInput[];
}

export interface JobMilestoneInput {
  readonly title: string;
  readonly description: string;
  readonly deliverable: string;
  readonly acceptanceCriteria: readonly string[];
  readonly amount: Money;
  readonly dueDate?: string;
}

export interface ApplyInput {
  readonly residenceCountry: string;
  readonly payoutCountry: string;
  readonly payoutCurrency: string;
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
  readonly policies?: readonly string[];
  readonly legalClauses?: readonly string[];
  readonly acceptanceCriteria?: readonly string[];
  readonly commercialTerms?: readonly string[];
}

export interface CompanyPolicyProfileInput {
  readonly companyCountry: string;
  readonly fundingCurrency: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly contentBase64: string;
  readonly policies: readonly string[];
  readonly legalClauses: readonly string[];
  readonly commercialStandards: readonly string[];
  readonly authorizedApprovers: readonly string[];
  readonly extractionSource: 'OPENAI' | 'FIXTURE';
  readonly extractionModel: string;
}

interface AgreementClauseSource {
  readonly section: 'POLICIES' | 'LEGAL_CLAUSES' | 'ACCEPTANCE_CRITERIA' | 'COMMERCIAL_TERMS';
  readonly text: string;
  readonly sourceType: 'COMPANY_POLICY' | 'JOB_BRIEF' | 'FREELANCER_PROPOSAL' | 'DEAL_OVERRIDE';
  readonly sourceRef: string;
  readonly sourceHash: string;
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

  async latestCompanyPolicyProfile(principal: Principal): Promise<CompanyPolicyProfile | null> {
    requireRole(principal, 'company_member', 'platform_admin');
    const [latest] = await this.context.store.findMany(
      companyPolicyProfiles,
      { organizationId: principal.organizationId },
      { orderBy: 'version', direction: 'desc', limit: 1 },
    );
    return latest ?? null;
  }

  async saveCompanyPolicyProfile(
    principal: Principal,
    input: CompanyPolicyProfileInput,
  ): Promise<CompanyPolicyProfile> {
    requireRole(principal, 'company_member', 'platform_admin');
    const organization = await this.context.store.findOne(organizations, { id: principal.organizationId });
    if (!organization) throw notFound(`Unknown organization ${principal.organizationId}.`);
    if (input.companyCountry !== organization.country) {
      throw unprocessable('The onboarding country must match the verified company organization country.');
    }
    const required = [input.policies, input.legalClauses, input.commercialStandards, input.authorizedApprovers];
    if (required.some((values) => values.map((value) => value.trim()).filter(Boolean).length === 0)) {
      throw unprocessable('The approved company profile requires policy, legal, commercial, and approver entries.');
    }
    if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(input.contentBase64) || input.contentBase64.length % 4 !== 0) {
      throw unprocessable('The company policy document is not valid base64.');
    }
    const bytes = Buffer.from(input.contentBase64, 'base64');
    if (bytes.length === 0 || bytes.length > 8 * 1024 * 1024) {
      throw unprocessable('The company policy document must be between 1 byte and 8 MB.');
    }
    const existing = await this.context.store.findMany(companyPolicyProfiles, {
      organizationId: principal.organizationId,
    }, { orderBy: 'version', direction: 'desc', limit: 1 });
    const version = (existing[0]?.version ?? 0) + 1;
    const objectId = this.context.ids.next('OBJ');
    const stored = await this.context.objects.put(
      objectKeyFor('company-policy', principal.organizationId, objectId),
      bytes,
      input.contentType,
    );
    await this.context.store.insert(uploadedObjects, {
      id: objectId,
      bucket: stored.bucket,
      objectKey: stored.objectKey,
      contentType: stored.contentType,
      byteLength: String(stored.byteLength),
      sha256: stored.sha256,
      ownerOrganizationId: principal.organizationId,
      classification: 'COMPANY_POLICY',
      createdAt: this.context.clock.now().toISOString(),
    });
    const normalized = {
      policies: input.policies.map((value) => value.trim()).filter(Boolean),
      legalClauses: input.legalClauses.map((value) => value.trim()).filter(Boolean),
      commercialStandards: input.commercialStandards.map((value) => value.trim()).filter(Boolean),
      authorizedApprovers: input.authorizedApprovers.map((value) => value.trim()).filter(Boolean),
    };
    const approvedAt = this.context.clock.now().toISOString();
    const profileHash = canonicalHash({
      organizationId: principal.organizationId,
      version,
      country: organization.country,
      fundingCurrency: input.fundingCurrency,
      sourceArtifactHash: stored.sha256,
      ...normalized,
    });
    const profile = await this.context.store.insert(companyPolicyProfiles, {
      id: this.context.ids.next('CPP'),
      organizationId: principal.organizationId,
      version,
      country: organization.country,
      fundingCurrency: input.fundingCurrency,
      sourceObjectId: objectId,
      sourceFileName: input.fileName,
      sourceArtifactHash: stored.sha256,
      ...normalized,
      extractionSource: input.extractionSource,
      extractionModel: input.extractionModel,
      profileHash,
      approvedByUserId: principal.subject,
      approvedAt,
      createdAt: approvedAt,
    });
    await this.context.timeline.append({
      kind: 'COMPANY_POLICY_APPROVED',
      actor: this.actor(principal),
      detail: {
        profileId: profile.id,
        organizationId: profile.organizationId,
        version: profile.version,
        profileHash: profile.profileHash,
        sourceArtifactHash: profile.sourceArtifactHash,
      },
    });
    return profile;
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
    if (input.payerCountry !== organization.country) {
      throw unprocessable('The payer country must match the verified company organization country.');
    }
    if (input.fundingCurrency !== input.budget.currency) {
      throw unprocessable('The job funding currency must match the budget denomination.');
    }
    const suppliedMilestones = input.milestones?.length ? input.milestones : [{
      title: input.title,
      description: input.description,
      deliverable: 'The complete project deliverable described in the job brief.',
      acceptanceCriteria: input.acceptanceCriteria?.length
        ? input.acceptanceCriteria
        : ['The buyer reviews the submitted milestone and records a decision.'],
      amount: input.budget,
      ...(input.targetDeliveryDate ? { dueDate: input.targetDeliveryDate } : {}),
    }];
    if (suppliedMilestones.length > 5) throw unprocessable('A job supports between one and five milestones.');
    let milestoneTotal = 0n;
    const milestones = suppliedMilestones.map((milestone, index) => {
      const title = milestone.title.trim();
      const description = milestone.description.trim();
      const deliverable = milestone.deliverable.trim();
      const acceptanceCriteria = [...new Set(milestone.acceptanceCriteria.map((value) => value.trim()).filter(Boolean))];
      if (!title || !description || !deliverable || acceptanceCriteria.length === 0) {
        throw unprocessable(`Milestone ${index + 1} needs a title, description, deliverable and acceptance criteria.`);
      }
      if (!sameDenomination(milestone.amount, input.budget) || BigInt(milestone.amount.amountMinor) <= 0n) {
        throw unprocessable(`Milestone ${index + 1} must use a positive ${input.budget.currency}/${input.budget.scale} amount.`);
      }
      if (milestone.dueDate !== undefined && !isIsoDate(milestone.dueDate)) {
        throw unprocessable(`Milestone ${index + 1} has an invalid due date.`);
      }
      milestoneTotal += BigInt(milestone.amount.amountMinor);
      return {
        ordinal: index + 1,
        title: title.slice(0, 200),
        description: description.slice(0, 4_000),
        deliverable: deliverable.slice(0, 2_000),
        acceptanceCriteria: acceptanceCriteria.slice(0, 16),
        amountMinor: milestone.amount.amountMinor,
        currency: milestone.amount.currency,
        scale: milestone.amount.scale,
        dueDate: milestone.dueDate ?? null,
      };
    });
    if (milestoneTotal !== BigInt(input.budget.amountMinor)) {
      throw unprocessable('The milestone allocations must add up exactly to the total job budget.');
    }

    const job = await this.context.store.insert(jobs, {
      id: this.context.ids.next('JOB'),
      organizationId: principal.organizationId,
      createdByUserId: principal.subject,
      title: input.title,
      description: input.description,
      skills: [...input.skills],
      acceptanceCriteria: input.acceptanceCriteria === undefined ? null : [...input.acceptanceCriteria],
      targetDeliveryDate: input.targetDeliveryDate ?? null,
      payerCountry: input.payerCountry,
      fundingCurrency: input.fundingCurrency,
      destinationCountry: input.destinationCountry,
      budgetAmountMinor: input.budget.amountMinor,
      budgetCurrency: input.budget.currency,
      budgetScale: input.budget.scale,
      milestones,
      status: 'OPEN',
      createdAt: this.context.clock.now().toISOString(),
    });
    await this.context.timeline.append({
      kind: 'JOB_POSTED',
      actor: this.actor(principal),
      detail: {
        jobId: job.id,
        organizationId: job.organizationId,
        payerCountry: job.payerCountry,
        fundingCurrency: job.fundingCurrency,
        destinationCountry: job.destinationCountry,
        budgetMinor: job.budgetAmountMinor,
        budgetCurrency: job.budgetCurrency,
        milestoneCount: job.milestones.length,
        milestoneScheduleHash: canonicalHash(job.milestones),
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
    const applicantOrganization = await this.context.store.findOne(organizations, { id: principal.organizationId });
    if (!applicantOrganization) throw notFound(`Unknown organization ${principal.organizationId}.`);
    if (input.residenceCountry !== applicantOrganization.country) {
      throw unprocessable('The proposal residence country must match the verified applicant organization country.');
    }
    if (input.payoutCountry !== input.residenceCountry) {
      throw unprocessable('The current payment rails require the verified provider and payout country to match.');
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
      residenceCountry: input.residenceCountry,
      payoutCountry: input.payoutCountry,
      payoutCurrency: input.payoutCurrency,
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
      detail: {
        jobId,
        applicationId: application.id,
        applicantOrganizationId: principal.organizationId,
        residenceCountry: application.residenceCountry,
        payoutCountry: application.payoutCountry,
        payoutCurrency: application.payoutCurrency,
      },
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
          residenceCountry: application.residenceCountry,
          payoutCountry: application.payoutCountry,
          payoutCurrency: application.payoutCurrency,
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
    if (job.fundingCurrency !== amount.currency) {
      throw unprocessable(`The agreed amount must use the persisted funding currency ${job.fundingCurrency}.`);
    }

    // The route is ordered and becomes immutable only after the human chooses
    // a provider. It can never be reversed by a later payment request.
    // Selection binds even a review/blocked route so both parties can inspect
    // and approve the private agreement. Only payment creation uses `resolve`
    // and therefore refuses a blocked policy before any FX or chain action.
    const corridor = inspect(job.payerCountry, application.payoutCountry);
    if (corridor.policy.fundingCurrency !== job.fundingCurrency) {
      throw unprocessable(`Corridor ${corridor.bookId} requires ${corridor.policy.fundingCurrency} funding.`);
    }
    if (corridor.policy.payoutCurrency !== application.payoutCurrency) {
      throw unprocessable(`Corridor ${corridor.bookId} requires ${corridor.policy.payoutCurrency} payout.`);
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
        payerCountry: job.payerCountry,
        payoutCountry: application.payoutCountry,
        corridorBookId: corridor.bookId,
        milestoneCount: job.milestones.length || 1,
      },
    });

    const now = this.context.clock.now().toISOString();
    const contractId = this.context.ids.next('WC');
    const jobMilestones = job.milestones.length ? job.milestones : [{
      ordinal: 1,
      title: job.title,
      description: job.description,
      deliverable: 'The complete project deliverable described in the job brief.',
      acceptanceCriteria: job.acceptanceCriteria ?? ['The buyer reviews the submitted milestone and records a decision.'],
      amountMinor: job.budgetAmountMinor,
      currency: job.budgetCurrency,
      scale: job.budgetScale,
      dueDate: job.targetDeliveryDate,
    }];
    const originalTotal = jobMilestones.reduce((total, milestone) => total + BigInt(milestone.amountMinor), 0n);
    let allocated = 0n;
    const scheduledMilestones = jobMilestones.map((milestone, index) => {
      const amountMinor = index === jobMilestones.length - 1
        ? BigInt(amount.amountMinor) - allocated
        : BigInt(milestone.amountMinor) * BigInt(amount.amountMinor) / originalTotal;
      allocated += amountMinor;
      if (amountMinor <= 0n) throw unprocessable('The agreed price is too small to allocate a positive escrow to every milestone.');
      return { ...milestone, id: this.context.ids.next('MS'), amountMinor: amountMinor.toString(), currency: amount.currency, scale: amount.scale };
    });
    const milestoneId = scheduledMilestones[0]!.id;
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
      milestones: scheduledMilestones,
      draftingSummary: drafted.summary,
    });
    const contract = await this.context.store.insert(workContracts, {
      id: contractId,
      jobId: job.id,
      applicationId,
      buyerOrganizationId: job.organizationId,
      providerOrganizationId: application.applicantOrganizationId,
      providerUserId: application.applicantUserId,
      payerCountry: job.payerCountry,
      fundingCurrency: job.fundingCurrency,
      providerResidenceCountry: application.residenceCountry,
      payoutCountry: application.payoutCountry,
      payoutCurrency: application.payoutCurrency,
      corridorId: corridor.policy.id,
      corridorDirection: corridor.policy.direction,
      corridorBookId: corridor.bookId,
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
    for (const milestone of scheduledMilestones) {
      await this.context.store.insert(contractMilestones, {
        id: milestone.id,
        contractId: contract.id,
        ordinal: milestone.ordinal,
        title: milestone.title,
        description: milestone.description,
        deliverable: milestone.deliverable,
        acceptanceCriteria: [...milestone.acceptanceCriteria],
        amountMinor: milestone.amountMinor,
        amountCurrency: milestone.currency,
        amountScale: milestone.scale,
        dueDate: milestone.dueDate,
        state: 'PENDING',
        createdAt: now,
        updatedAt: now,
      });
    }
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
        milestoneCount: scheduledMilestones.length,
        milestoneScheduleHash: canonicalHash(scheduledMilestones.map(({ id, ...milestone }) => ({ id, ...milestone }))),
        amountMinor: contract.amountMinor,
        amountCurrency: contract.amountCurrency,
        payerCountry: contract.payerCountry,
        payoutCountry: contract.payoutCountry,
        payoutCurrency: contract.payoutCurrency,
        corridorId: contract.corridorId,
        corridorDirection: contract.corridorDirection,
        corridorBookId: contract.corridorBookId,
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
    const milestones = await this.context.store.findMany(contractMilestones, { contractId }, { orderBy: 'ordinal' });
    const [profile] = await this.context.store.findMany(companyPolicyProfiles, {
      organizationId: contract.buyerOrganizationId,
    }, { orderBy: 'version', direction: 'desc', limit: 1 });
    const overrides = {
      policies: input.policies ?? [],
      legalClauses: input.legalClauses ?? [],
      acceptanceCriteria: input.acceptanceCriteria ?? [],
      commercialTerms: input.commercialTerms ?? [],
    };
    if (!profile && Object.values(overrides).every((values) => values.length === 0)) {
      throw unprocessable('Complete and approve the company policy onboarding profile before generating an agreement.');
    }
    const unique = (values: readonly string[]) => [...new Set(values.map((value) => value.trim()).filter(Boolean))];
    const jobHash = canonicalHash({
      jobId: job.id,
      title: job.title,
      description: job.description,
      acceptanceCriteria: job.acceptanceCriteria,
      targetDeliveryDate: job.targetDeliveryDate,
    });
    const proposalHash = canonicalHash({
      applicationId: application.id,
      proposedAmountMinor: application.proposedAmountMinor,
      proposedCurrency: application.proposedCurrency,
      proposedScale: application.proposedScale,
      deliveryDays: application.deliveryDays,
      availability: application.availability,
      approach: application.approach,
    });
    const agreementInput: AgreementTermsInput = {
      policies: unique([...(profile?.policies ?? []), ...overrides.policies]),
      legalClauses: unique([...(profile?.legalClauses ?? []), ...overrides.legalClauses]),
      acceptanceCriteria: unique([...(job.acceptanceCriteria ?? []), ...overrides.acceptanceCriteria]),
      commercialTerms: unique([
        `The agreed fixed price is ${contract.amountMinor} ${contract.amountCurrency} minor units at scale ${contract.amountScale}.`,
        `The selected proposal commits to delivery within ${application.deliveryDays} days.`,
        `The selected freelancer stated: ${application.availability}`,
        ...(profile?.commercialStandards ?? []),
        ...overrides.commercialTerms,
      ]),
    };
    const policySources: AgreementClauseSource[] = profile ? [
      ...profile.policies.map((text) => ({ section: 'POLICIES' as const, text, sourceType: 'COMPANY_POLICY' as const, sourceRef: profile.id, sourceHash: profile.profileHash })),
      ...profile.legalClauses.map((text) => ({ section: 'LEGAL_CLAUSES' as const, text, sourceType: 'COMPANY_POLICY' as const, sourceRef: profile.id, sourceHash: profile.profileHash })),
      ...profile.commercialStandards.map((text) => ({ section: 'COMMERCIAL_TERMS' as const, text, sourceType: 'COMPANY_POLICY' as const, sourceRef: profile.id, sourceHash: profile.profileHash })),
    ] : [];
    const sources: AgreementClauseSource[] = [
      ...policySources,
      ...(job.acceptanceCriteria ?? []).map((text) => ({ section: 'ACCEPTANCE_CRITERIA' as const, text, sourceType: 'JOB_BRIEF' as const, sourceRef: job.id, sourceHash: jobHash })),
      { section: 'COMMERCIAL_TERMS', text: `The agreed fixed price is ${contract.amountMinor} ${contract.amountCurrency} minor units at scale ${contract.amountScale}.`, sourceType: 'FREELANCER_PROPOSAL', sourceRef: application.id, sourceHash: proposalHash },
      { section: 'COMMERCIAL_TERMS', text: `The selected proposal commits to delivery within ${application.deliveryDays} days.`, sourceType: 'FREELANCER_PROPOSAL', sourceRef: application.id, sourceHash: proposalHash },
      { section: 'COMMERCIAL_TERMS', text: `The selected freelancer stated: ${application.availability}`, sourceType: 'FREELANCER_PROPOSAL', sourceRef: application.id, sourceHash: proposalHash },
      ...Object.entries(overrides).flatMap(([section, values]) => values.map((text) => ({
        section: ({ policies: 'POLICIES', legalClauses: 'LEGAL_CLAUSES', acceptanceCriteria: 'ACCEPTANCE_CRITERIA', commercialTerms: 'COMMERCIAL_TERMS' } as const)[section as keyof typeof overrides],
        text,
        sourceType: 'DEAL_OVERRIDE' as const,
        sourceRef: contractId,
        sourceHash: canonicalHash({ contractId, section, text }),
      }))),
    ];
    const drafted = await this.context.ai.evaluate({
      purpose: 'CONTRACT_DRAFTING',
      instruction: 'Formalize the approved company policy, job brief and selected proposal without changing their meaning. Preserve source attribution. You are advisory only.',
      facts: {
        companyPolicyProfileHash: profile?.profileHash ?? 'LEGACY_EXPLICIT_INPUT',
        policyCount: agreementInput.policies?.length ?? 0,
        legalClauseCount: agreementInput.legalClauses?.length ?? 0,
        acceptanceCriterionCount: agreementInput.acceptanceCriteria?.length ?? 0,
        commercialTermCount: agreementInput.commercialTerms?.length ?? 0,
        orderedDestinationCountry: application.payoutCountry,
      },
    });
    const agreement = await this.storeAgreement({
      contractId,
      version: contract.agreementVersion + 1,
      job,
      application,
      amount: this.contractAmount(contract),
      input: agreementInput,
      milestones: milestones.map((milestone) => ({
        id: milestone.id,
        ordinal: milestone.ordinal,
        title: milestone.title,
        description: milestone.description,
        deliverable: milestone.deliverable,
        acceptanceCriteria: milestone.acceptanceCriteria,
        amountMinor: milestone.amountMinor,
        currency: milestone.amountCurrency,
        scale: milestone.amountScale,
        dueDate: milestone.dueDate,
      })),
      sources,
      ...(profile ? { profile } : {}),
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
    milestones: readonly {
      id: string; ordinal: number; title: string; description: string; deliverable: string;
      acceptanceCriteria: readonly string[]; amountMinor: string; currency: string; scale: number; dueDate: string | null;
    }[];
    input: AgreementTermsInput;
    sources?: readonly AgreementClauseSource[];
    profile?: CompanyPolicyProfile;
    draftingSummary: string;
  }) {
    const clean = (values: readonly string[]) => values.map((value) => value.trim()).filter(Boolean);
    const terms = {
      policies: clean(args.input.policies ?? []),
      legalClauses: clean(args.input.legalClauses ?? []),
      acceptanceCriteria: clean(args.input.acceptanceCriteria ?? []),
      commercialTerms: clean(args.input.commercialTerms ?? []),
      sources: [...(args.sources ?? [])],
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
      `Ordered payment corridor: ${args.job.payerCountry} -> ${args.application.payoutCountry}`,
      `Funding currency: ${args.job.fundingCurrency}`,
      `Provider residence country: ${args.application.residenceCountry}`,
      `Payout currency: ${args.application.payoutCurrency}`,
      `Scope: ${args.job.title}`,
      `Target delivery date: ${args.job.targetDeliveryDate ?? 'Not specified'}`,
      `Agreed price: ${args.amount.amountMinor} ${args.amount.currency} minor units (scale ${args.amount.scale})`,
      `Proposal delivery estimate: ${args.application.deliveryDays} days`,
      `Proposal availability: ${args.application.availability}`,
      `Company policy profile: ${args.profile?.id ?? 'Explicit deal input'}`,
      `Company policy profile hash: ${args.profile?.profileHash ?? 'Not available'}`,
      '',
      '## Milestone escrow schedule',
      '',
      ...args.milestones.flatMap((milestone) => [
        `### Milestone ${milestone.ordinal}: ${milestone.title}`,
        '',
        `Milestone reference: ${milestone.id}`,
        `Description: ${milestone.description}`,
        `Required deliverable: ${milestone.deliverable}`,
        `Escrow allocation: ${milestone.amountMinor} ${milestone.currency} minor units (scale ${milestone.scale})`,
        `Due date: ${milestone.dueDate ?? 'Not specified'}`,
        `Acceptance checks: ${milestone.acceptanceCriteria.join(' | ')}`,
        '',
      ]),
      ...section('Company policies', terms.policies),
      ...section('Legal clauses', terms.legalClauses),
      ...section('Acceptance criteria', terms.acceptanceCriteria),
      ...section('Commercial terms', terms.commercialTerms),
      ...section('Clause source provenance', terms.sources.map((source) => `${source.section} | ${source.sourceType} | ${source.sourceRef} | ${source.sourceHash} | ${source.text}`)),
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
      payerCountry: args.job.payerCountry,
      fundingCurrency: args.job.fundingCurrency,
      providerResidenceCountry: args.application.residenceCountry,
      payoutCountry: args.application.payoutCountry,
      payoutCurrency: args.application.payoutCurrency,
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
      milestones: args.milestones,
      companyTerms: terms,
      companyPolicyProfile: args.profile ? {
        id: args.profile.id,
        version: args.profile.version,
        profileHash: args.profile.profileHash,
        sourceArtifactHash: args.profile.sourceArtifactHash,
        authorizedApprovers: args.profile.authorizedApprovers,
      } : null,
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

  async milestones(principal: Principal, contractId: string) {
    const contract = await this.requireContract(contractId);
    requireReadAccess(principal, contract.buyerOrganizationId, contract.providerOrganizationId);
    return this.context.store.findMany(contractMilestones, { contractId }, { orderBy: 'ordinal' });
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
