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
import { conflict, notFound, unprocessable } from '../errors.js';
import {
  aiEvaluationCitations,
  aiEvaluations,
  applications,
  contractApprovals,
  jobs,
  memberships,
  organizations,
  users,
  workContracts,
} from '../db/schema.js';
import { money, type Money } from '../money.js';
import { requireOwnership, requireReadAccess, requireRole, type Principal } from '../auth/authorization.js';
import type { Select } from '../db/store.js';

export type Job = Select<typeof jobs>;
export type Application = Select<typeof applications>;
export type WorkContract = Select<typeof workContracts>;

export interface CreateJobInput {
  readonly title: string;
  readonly description: string;
  readonly skills: readonly string[];
  readonly destinationCountry: string;
  readonly budget: Money;
}

export interface ApplyInput {
  readonly coverLetter: string;
  readonly resumeObjectId?: string;
}

export interface ApproveContractInput {
  readonly party: 'BUYER' | 'PROVIDER';
  readonly acceptedTermsHash: string;
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

    const organization = await this.context.store.findOne(organizations, { id: principal.organizationId });
    if (!organization) throw notFound(`Unknown organization ${principal.organizationId}.`);

    const job = await this.context.store.insert(jobs, {
      id: this.context.ids.next('JOB'),
      organizationId: principal.organizationId,
      createdByUserId: principal.subject,
      title: input.title,
      description: input.description,
      skills: [...input.skills],
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

    const application = await this.context.store.insert(applications, {
      id: this.context.ids.next('APP'),
      jobId,
      applicantUserId: principal.subject,
      applicantOrganizationId: principal.organizationId,
      coverLetter: input.coverLetter,
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
    const skillMatches = job.skills.filter((skill) =>
      application.coverLetter.toLowerCase().includes(skill.toLowerCase())).length;

    const result = await this.context.ai.evaluate({
      purpose: 'APPLICATION_SCORING',
      instruction: 'Score how well this application matches the posted work. You are advisory only.',
      facts: {
        // Opaque, non-identifying facts only.
        jobSkillCount: job.skills.length,
        skillMatches,
        priorContracts,
        coverLetterLength: application.coverLetter.length,
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

    const existing = await this.context.store.findOne(workContracts, { applicationId });
    if (existing) return existing;

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
    const milestoneId = this.context.ids.next('MS');
    const terms = [
      `Scope: ${job.title}.`,
      `Deliverable: one milestone accepted by the buying organization.`,
      `Amount: ${amount.amountMinor} minor units of ${amount.currency} at scale ${amount.scale}.`,
      `Acceptance: the buyer approves, requests a revision, or disputes the submitted version.`,
      `Advisory drafting note: ${drafted.summary}`,
    ].join('\n');

    const contractHash = canonicalHash({
      jobId: job.id,
      applicationId,
      buyerOrganizationId: job.organizationId,
      providerOrganizationId: application.applicantOrganizationId,
      terms,
      amount,
    });
    const contract = await this.context.store.insert(workContracts, {
      id: this.context.ids.next('WC'),
      jobId: job.id,
      applicationId,
      buyerOrganizationId: job.organizationId,
      providerOrganizationId: application.applicantOrganizationId,
      providerUserId: application.applicantUserId,
      state: 'CANDIDATE_SELECTED' satisfies WorkContractState,
      terms,
      contractHash,
      milestoneId,
      milestoneHash: canonicalHash({ milestoneId, contractHash, ordinal: 1 }),
      amountMinor: amount.amountMinor,
      amountCurrency: amount.currency,
      amountScale: amount.scale,
      createdAt: now,
      updatedAt: now,
    });
    await this.context.store.update(applications, { id: applicationId }, { status: 'SELECTED' });
    await this.context.store.update(jobs, { id: job.id }, { status: 'CANDIDATE_SELECTED' });
    await this.context.timeline.append({
      kind: 'CONTRACT_DRAFTED',
      actor: this.actor(principal),
      contractId: contract.id,
      detail: {
        contractId: contract.id,
        applicationId,
        contractHash,
        milestoneId,
        amountMinor: contract.amountMinor,
        amountCurrency: contract.amountCurrency,
        draftingSource: drafted.source,
      },
    });
    return contract;
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
