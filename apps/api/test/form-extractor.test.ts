import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractFormDraft } from '../src/ai/form-extractor.js';
import { base64, call, createHarness, type Harness } from './harness.js';

let harness: Harness | undefined;

afterEach(async () => {
  vi.unstubAllGlobals();
  await harness?.close();
  harness = undefined;
});

const jobText = [
  'Title: Build an auditable settlement monitor',
  'Description: Implement a TypeScript reconciliation service with an operator exception queue and tests.',
  'Acceptance criteria: Reconcile every ledger entry; flag mismatches; pass the restart recovery test',
  'Skills: TypeScript, PostgreSQL, reconciliation',
  'Budget PLN: 12000',
  'Delivery date: 2026-10-15',
  'Payer country: Poland',
  'Funding currency: PLN',
  'Destination country: India',
].join('\n');

const proposalText = [
  'Proposed price PLN: 10800',
  'Delivery days: 18',
  'Tax residence: India',
  'Payout country: India',
  'Payout currency: INR',
  'Availability: Available immediately for 30 hours per week',
  'Approach: Model the settlement events, implement the exception queue, then prove recovery with integration tests.',
  'Cover letter: I have delivered TypeScript payment services and PostgreSQL reconciliation systems for regulated teams.',
].join('\n');

const agreementText = [
  'Commercial terms: Fixed price of PLN 11800; one evidence-backed revision is included; invoice after acceptance',
  'Acceptance criteria: All automated tests pass; Fabric and Algorand references reconcile; operating runbook is delivered',
  'Company policies: Repository access follows least privilege; confidential data remains private; no PII may be written to either ledger',
  'Legal clauses: Pre-existing IP remains with its owner; accepted deliverables transfer to the company; disputes follow the agreement procedure',
].join('\n');

const companyPolicyText = [
  'Company country: Poland',
  'Funding currency: PLN',
  'Company policies: Confidential data remains private; repository access follows least privilege',
  'Legal clauses: Polish law governs the agreement; disputes follow escalation then Warsaw arbitration',
  'Commercial standards: Invoices are issued after acceptance; one evidence-backed revision is included',
  'Authorized approvers: Procurement Director; Engineering Director',
].join('\n');

const companyIdentityText = [
  'Legal name: WISE PAYMENTS LIMITED',
  'Country: United Kingdom',
  'Registry authority: COMPANIES_HOUSE',
  'Registration number: 07209813',
  'LEI: 213800U4GNTXRFYZKG18',
  'Tax identifier: DEMO-PRIVATE-TAX-REF',
  'Registered address: 1st Floor, Worship Square, 65 Clifton Street, London, England, EC2A 4JE',
  'Director / officer sample: Jane Fahey',
  'PSC / beneficial owner: Wise Financial Holdings Ltd | PERSON_WITH_SIGNIFICANT_CONTROL',
  'Representative email: demo@anchor.dev',
  'Representative role: Anchor demo contracting representative',
  'Authority basis: Tenant administrator approved this representative for the local demonstration.',
  'Mandate reference: ANCHOR-DEMO-MANDATE-GB-001',
].join('\n');

describe('document-to-form extraction', () => {
  it('deterministically extracts labeled job and proposal drafts without publishing either', async () => {
    const config = { mode: 'fixture', baseUrl: 'https://api.openai.com/v1', model: 'fixture' } as const;
    const job = await extractFormDraft(config, {
      purpose: 'JOB_BRIEF', fileName: 'brief.txt', contentType: 'text/plain', contentBase64: base64(jobText),
    });
    const proposal = await extractFormDraft(config, {
      purpose: 'FREELANCER_PROPOSAL', fileName: 'proposal.txt', contentType: 'text/plain', contentBase64: base64(proposalText),
    });
    const agreement = await extractFormDraft(config, {
      purpose: 'AGREEMENT_TERMS', fileName: 'commercial-terms.txt', contentType: 'text/plain', contentBase64: base64(agreementText),
    });
    const companyPolicy = await extractFormDraft(config, {
      purpose: 'COMPANY_POLICY', fileName: 'company-policy.txt', contentType: 'text/plain', contentBase64: base64(companyPolicyText),
    });
    const companyIdentity = await extractFormDraft(config, {
      purpose: 'COMPANY_IDENTITY', fileName: 'company-onboarding.txt', contentType: 'text/plain', contentBase64: base64(companyIdentityText),
    });

    expect(job).toMatchObject({
      source: 'FIXTURE', reviewRequired: true,
      fields: {
        title: 'Build an auditable settlement monitor', budgetPln: 12000,
        payerCountry: 'PL', fundingCurrency: 'PLN', destinationCountry: 'IN',
      },
    });
    expect(proposal).toMatchObject({
      source: 'FIXTURE', reviewRequired: true,
      fields: {
        proposedPricePln: 10800, deliveryDays: 18,
        residenceCountry: 'IN', payoutCountry: 'IN', payoutCurrency: 'INR',
      },
    });
    expect(agreement).toMatchObject({
      source: 'FIXTURE', reviewRequired: true,
      fields: {
        commercialTerms: ['Fixed price of PLN 11800', 'one evidence-backed revision is included', 'invoice after acceptance'],
        legalClauses: expect.arrayContaining(['Pre-existing IP remains with its owner']),
      },
    });
    expect(companyPolicy).toMatchObject({
      source: 'FIXTURE', reviewRequired: true,
      fields: {
        companyCountry: 'PL', fundingCurrency: 'PLN',
        policies: ['Confidential data remains private', 'repository access follows least privilege'],
        authorizedApprovers: ['Procurement Director', 'Engineering Director'],
      },
    });
    expect(companyIdentity).toMatchObject({
      source: 'FIXTURE', reviewRequired: true,
      fields: {
        legalName: 'WISE PAYMENTS LIMITED', country: 'GB', registryAuthority: 'COMPANIES_HOUSE',
        registrationNumber: '07209813', lei: '213800U4GNTXRFYZKG18', directors: ['Jane Fahey'],
        beneficialOwners: ['Wise Financial Holdings Ltd | PERSON_WITH_SIGNIFICANT_CONTROL'],
        representativeEmail: 'demo@anchor.dev', mandateReference: 'ANCHOR-DEMO-MANDATE-GB-001',
      },
    });
  });

  it('extracts amounts labeled in the selected route currencies without assuming PLN', async () => {
    const config = { mode: 'fixture', baseUrl: 'https://api.openai.com/v1', model: 'fixture' } as const;
    const job = await extractFormDraft(config, {
      purpose: 'JOB_BRIEF', fileName: 'brief.txt', contentType: 'text/plain',
      contentBase64: base64('Title: UK delivery\nDescription: A sufficiently detailed delivery brief for testing.\nBudget INR: 250000'),
    });
    const proposal = await extractFormDraft(config, {
      purpose: 'FREELANCER_PROPOSAL', fileName: 'proposal.txt', contentType: 'text/plain',
      contentBase64: base64('Proposed price INR: 240000\nDelivery days: 15'),
    });

    expect(job.fields).toMatchObject({ budgetPln: 250000 });
    expect(proposal.fields).toMatchObject({ proposedPricePln: 240000 });
  });

  it('sends the document as a Responses API file input and requests strict structured output', async () => {
    let sent: Record<string, any> | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: URL, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(JSON.stringify({
        model: 'gpt-test',
        output_text: JSON.stringify({
          title: 'Extracted brief', description: 'A sufficiently detailed extracted work description.',
          acceptanceCriteria: ['Tests pass'], skills: ['TypeScript'], budgetPln: 9000,
          deliveryDate: '2026-10-20', payerCountry: 'GB', fundingCurrency: 'GBP', destinationCountry: 'IN',
        }),
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    const result = await extractFormDraft({
      mode: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-test', apiKey: 'test-key',
    }, { purpose: 'JOB_BRIEF', fileName: 'brief.txt', contentType: 'text/plain', contentBase64: base64(jobText) });

    expect(result.source).toBe('OPENAI');
    expect(sent?.['store']).toBe(false);
    expect(sent?.['input'][0].content[0]).toMatchObject({
      type: 'input_file', filename: 'brief.txt', file_data: `data:text/plain;base64,${base64(jobText)}`,
    });
    expect(sent?.['text'].format).toMatchObject({ type: 'json_schema', strict: true });
  });

  it('enforces company/freelancer purpose separation at the authenticated API boundary', async () => {
    harness = await createHarness();
    const jobBody = { purpose: 'JOB_BRIEF', fileName: 'brief.txt', contentType: 'text/plain', contentBase64: base64(jobText) };
    const proposalBody = { purpose: 'FREELANCER_PROPOSAL', fileName: 'proposal.txt', contentType: 'text/plain', contentBase64: base64(proposalText) };
    const agreementBody = { purpose: 'AGREEMENT_TERMS', fileName: 'commercial-terms.txt', contentType: 'text/plain', contentBase64: base64(agreementText) };
    const policyBody = { purpose: 'COMPANY_POLICY', fileName: 'company-policy.txt', contentType: 'text/plain', contentBase64: base64(companyPolicyText) };
    const identityBody = { purpose: 'COMPANY_IDENTITY', fileName: 'company-onboarding.txt', contentType: 'text/plain', contentBase64: base64(companyIdentityText) };

    const companyJob = await call(harness, 'POST', '/v1/ai/extract-form', { token: harness.seed.polishCompany.token, body: jobBody });
    const freelancerProposal = await call(harness, 'POST', '/v1/ai/extract-form', { token: harness.seed.indianFreelancer.token, body: proposalBody });
    const freelancerJob = await call(harness, 'POST', '/v1/ai/extract-form', { token: harness.seed.indianFreelancer.token, body: jobBody });
    const companyProposal = await call(harness, 'POST', '/v1/ai/extract-form', { token: harness.seed.polishCompany.token, body: proposalBody });
    const companyAgreement = await call(harness, 'POST', '/v1/ai/extract-form', { token: harness.seed.polishCompany.token, body: agreementBody });
    const freelancerAgreement = await call(harness, 'POST', '/v1/ai/extract-form', { token: harness.seed.indianFreelancer.token, body: agreementBody });
    const companyPolicy = await call(harness, 'POST', '/v1/ai/extract-form', { token: harness.seed.polishCompany.token, body: policyBody });
    const freelancerPolicy = await call(harness, 'POST', '/v1/ai/extract-form', { token: harness.seed.indianFreelancer.token, body: policyBody });
    const companyIdentity = await call(harness, 'POST', '/v1/ai/extract-form', { token: harness.seed.polishCompany.token, body: identityBody });
    const freelancerIdentity = await call(harness, 'POST', '/v1/ai/extract-form', { token: harness.seed.indianFreelancer.token, body: identityBody });

    expect(companyJob.status).toBe(200);
    expect(freelancerProposal.status).toBe(200);
    expect(freelancerJob.status).toBe(403);
    expect(companyProposal.status).toBe(403);
    expect(companyAgreement.status).toBe(200);
    expect(freelancerAgreement.status).toBe(403);
    expect(companyPolicy.status).toBe(200);
    expect(freelancerPolicy.status).toBe(403);
    expect(companyIdentity.status).toBe(200);
    expect(freelancerIdentity.status).toBe(403);
  });
});
