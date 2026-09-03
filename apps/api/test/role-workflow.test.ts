import { afterEach, describe, expect, it } from 'vitest';
import { call, createHarness, type Harness } from './harness.js';
import { uploadedObjects, workContracts } from '../src/db/schema.js';
import { sha256Bytes } from '../src/runtime.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function hiringScenario(current: Harness) {
  const job = await call(current, 'POST', '/v1/jobs', {
    token: current.seed.polishCompany.token,
    idempotencyKey: 'roles-job-1',
    body: {
      title: 'Cross-border product engineering',
      description: 'Build and document a production-quality workflow with verifiable delivery evidence.',
      skills: ['typescript', 'algorand', 'fabric'],
      acceptanceCriteria: ['All API and LocalNet acceptance tests pass.', 'A reviewer can trace both ledger proofs.'],
      targetDeliveryDate: '2026-10-31',
      destinationCountry: 'IN',
      budget: { amountMinor: '1500000', currency: 'PLN', scale: 2 },
    },
  });
  expect(job.status).toBe(201);

  const proposals = [
    {
      price: '1420000', days: 18, availability: 'Can begin within two business days.',
      skills: ['typescript', 'fabric'],
      approach: 'Deliver the API contract first, then ledger adapters, integration tests, and operating documentation.',
    },
    {
      price: '1350000', days: 24, availability: 'Available from next Monday.',
      skills: ['typescript', 'algorand'],
      approach: 'Build vertical slices through storage, Fabric evidence, Algorand escrow, then harden authorization.',
    },
    {
      price: '1490000', days: 14, availability: 'Available immediately for the full engagement.',
      skills: ['typescript', 'algorand', 'fabric'],
      approach: 'Start with acceptance tests, implement the deal lifecycle, then verify privacy and reconciliation.',
    },
  ];
  const applications = [];
  for (const [index, freelancer] of current.seed.indianFreelancers.entries()) {
    const proposal = proposals[index]!;
    const response = await call(current, 'POST', `/v1/jobs/${job.body.id}/applications`, {
      token: freelancer.token,
      idempotencyKey: `roles-apply-${index + 1}`,
      body: {
        coverLetter: `Proposal ${index + 1} demonstrates relevant TypeScript, Fabric, and Algorand delivery experience.`,
        approach: proposal.approach,
        proposedSkills: proposal.skills,
        proposedPrice: { amountMinor: proposal.price, currency: 'PLN', scale: 2 },
        deliveryDays: proposal.days,
        deliveryDate: `2026-10-${String(10 + index).padStart(2, '0')}`,
        availability: proposal.availability,
      },
    });
    expect(response.status).toBe(201);
    applications.push(response.body);
  }
  return { job: job.body, applications };
}

describe('role-specific hiring workflow', () => {
  it('exposes three distinct demo freelancer principals and each freelancer sees only their proposals', async () => {
    harness = await createHarness();
    const current = harness;
    const principals = await call(current, 'GET', '/v1/demo/principals', {
      token: current.seed.platformAdmin.token,
    });
    expect(principals.status).toBe(200);
    expect(principals.body.parties.filter((party: { key: string }) =>
      party.key.startsWith('indianFreelancer'))).toHaveLength(3);
    expect(new Set(current.seed.indianFreelancers.map((party) => party.organizationId)).size).toBe(3);

    await hiringScenario(current);
    for (const freelancer of current.seed.indianFreelancers) {
      const mine = await call(current, 'GET', '/v1/applications', { token: freelancer.token });
      expect(mine.status).toBe(200);
      expect(mine.body.applications).toHaveLength(1);
      expect(mine.body.applications[0].application.applicantUserId).toBe(freelancer.principal.subject);
    }
  });

  it('collects and ranks multiple rich proposals without selecting for the company', async () => {
    harness = await createHarness();
    const current = harness;
    const { job, applications } = await hiringScenario(current);

    const listed = await call(current, 'GET', `/v1/jobs/${job.id}/applications`, {
      token: current.seed.polishCompany.token,
    });
    expect(listed.status).toBe(200);
    expect(listed.body.applications).toHaveLength(3);
    expect(listed.body.applications[0]).toMatchObject({
      proposedCurrency: 'PLN',
      proposedScale: 2,
      applicant: { country: 'IN' },
      evaluation: null,
    });

    const ranked = await call(current, 'POST', `/v1/jobs/${job.id}/applications/rank`, {
      token: current.seed.polishCompany.token,
      idempotencyKey: 'roles-rank-1',
    });
    expect(ranked.status).toBe(200);
    expect(ranked.body.ranking).toHaveLength(3);
    expect(ranked.body.ranking.every((entry: { advisoryOnly: boolean }) => entry.advisoryOnly)).toBe(true);
    expect(new Set(ranked.body.ranking.map((entry: { applicationId: string }) => entry.applicationId))).toEqual(
      new Set(applications.map((application) => application.id)),
    );
    expect(ranked.body.ranking[0].proposal).toMatchObject({ price: { currency: 'PLN', scale: 2 } });

    const afterRank = await call(current, 'GET', `/v1/jobs/${job.id}/applications`, {
      token: current.seed.polishCompany.token,
    });
    expect(afterRank.body.applications.every((application: { status: string }) => application.status === 'EVALUATED')).toBe(true);
  });

  it('keeps the generated agreement private to the buyer and selected freelancer', async () => {
    harness = await createHarness();
    const current = harness;
    const { applications } = await hiringScenario(current);
    const selectedApplication = applications[1]!;
    const selected = await call(current, 'POST', `/v1/applications/${selectedApplication.id}/select`, {
      token: current.seed.polishCompany.token,
      idempotencyKey: 'roles-select-1',
      body: { amount: { amountMinor: '1350000', currency: 'PLN', scale: 2 } },
    });
    expect(selected.status).toBe(200);
    const baselineHash = selected.body.contractHash;
    const selectionStatuses = await call(current, 'GET', `/v1/jobs/${selected.body.jobId}/applications`, {
      token: current.seed.polishCompany.token,
    });
    expect(selectionStatuses.body.applications.filter((application: { status: string }) =>
      application.status === 'SELECTED')).toHaveLength(1);
    expect(selectionStatuses.body.applications.filter((application: { status: string }) =>
      application.status === 'NOT_SELECTED')).toHaveLength(2);

    const prepared = await call(current, 'POST', `/v1/contracts/${selected.body.id}/agreement`, {
      token: current.seed.polishCompany.token,
      idempotencyKey: 'roles-agreement-1',
      body: {
        policies: ['All repository access follows the buyer secure-development policy.'],
        legalClauses: ['Each party retains ownership of pre-existing intellectual property.'],
        acceptanceCriteria: ['Automated tests pass and the deployment runbook is delivered.'],
        commercialTerms: ['The accepted proposal price is the complete milestone consideration.'],
      },
    });
    expect(prepared.status).toBe(200);
    expect(prepared.body.contract.contractHash).not.toBe(baselineHash);
    expect(prepared.body.agreement).toMatchObject({ available: true, version: 2, contentType: 'text/markdown' });

    const buyerAccess = await call(current, 'GET', `/v1/contracts/${selected.body.id}/agreement/access`, {
      token: current.seed.polishCompany.token,
    });
    const providerAccess = await call(current, 'GET', `/v1/contracts/${selected.body.id}/agreement/access`, {
      token: current.seed.indianFreelancers[1]!.token,
    });
    expect(buyerAccess.status).toBe(200);
    expect(providerAccess.status).toBe(200);
    expect(providerAccess.body.artifactHash).toBe(buyerAccess.body.artifactHash);
    expect(providerAccess.body).not.toHaveProperty('objectKey');

    const rejectedApplicant = await call(current, 'GET', `/v1/contracts/${selected.body.id}/agreement/access`, {
      token: current.seed.indianFreelancers[0]!.token,
    });
    const unrelatedCompany = await call(current, 'GET', `/v1/contracts/${selected.body.id}/agreement/access`, {
      token: current.seed.indianCompany.token,
    });
    expect(rejectedApplicant.status).toBe(403);
    expect(unrelatedCompany.status).toBe(403);

    const contract = await current.context.store.findOne(workContracts, { id: selected.body.id });
    const stored = await current.context.store.findOne(uploadedObjects, { id: contract!.agreementObjectId! });
    const bytes = await current.context.objects.get(stored!.objectKey);
    expect(sha256Bytes(bytes)).toBe(contract!.agreementArtifactHash);

    const approved = await call(current, 'POST', `/v1/contracts/${selected.body.id}/approve`, {
      token: current.seed.polishCompany.token,
      idempotencyKey: 'roles-agreement-buyer-approval',
      body: { party: 'BUYER', acceptedTermsHash: prepared.body.contract.contractHash },
    });
    expect(approved.status).toBe(200);
    const lateReplacement = await call(current, 'POST', `/v1/contracts/${selected.body.id}/agreement`, {
      token: current.seed.polishCompany.token,
      idempotencyKey: 'roles-agreement-late-change',
      body: {
        policies: [], legalClauses: ['Changed after approval.'],
        acceptanceCriteria: ['Changed after approval.'], commercialTerms: [],
      },
    });
    expect(lateReplacement.status).toBe(409);
  });

  it('accepts an arbitrary deliverable MIME type but only from the selected provider', async () => {
    harness = await createHarness();
    const current = harness;
    const { applications } = await hiringScenario(current);
    const selected = await call(current, 'POST', `/v1/applications/${applications[2]!.id}/select`, {
      token: current.seed.polishCompany.token,
      idempotencyKey: 'roles-select-file',
      body: { amount: { amountMinor: '1490000', currency: 'PLN', scale: 2 } },
    });
    await current.context.store.update(workContracts, { id: selected.body.id }, { state: 'ESCROW_FUNDED' });
    const binary = Buffer.from([0, 1, 2, 250, 251, 252, 255]);

    const forbiddenUpload = await call(current, 'POST', `/v1/contracts/${selected.body.id}/submissions`, {
      token: current.seed.indianFreelancers[0]!.token,
      idempotencyKey: 'roles-file-wrong-provider',
      body: {
        fileName: 'model.blend', contentType: 'application/vnd.blender',
        contentBase64: binary.toString('base64'), note: 'A binary design artifact.',
      },
    });
    expect(forbiddenUpload.status).toBe(403);

    const uploaded = await call(current, 'POST', `/v1/contracts/${selected.body.id}/submissions`, {
      token: current.seed.indianFreelancers[2]!.token,
      idempotencyKey: 'roles-file-selected-provider',
      body: {
        fileName: 'model.blend', contentType: 'application/vnd.blender',
        contentBase64: binary.toString('base64'), note: 'A binary design artifact.',
      },
    });
    expect(uploaded.status).toBe(201);
    expect(uploaded.body.submission.fileHash).toBe(sha256Bytes(binary));

    const accessed = await call(current, 'GET', `/v1/submissions/${uploaded.body.submission.id}/access`, {
      token: current.seed.polishCompany.token,
    });
    expect(accessed.status).toBe(200);
    expect(accessed.body).toMatchObject({ contentType: 'application/vnd.blender', byteLength: '7' });
  });
});
