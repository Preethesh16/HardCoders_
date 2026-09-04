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
].join('\n');

const proposalText = [
  'Proposed price PLN: 10800',
  'Delivery days: 18',
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

    expect(job).toMatchObject({
      source: 'FIXTURE', reviewRequired: true,
      fields: { title: 'Build an auditable settlement monitor', budgetPln: 12000, destinationCountry: 'IN' },
    });
    expect(proposal).toMatchObject({
      source: 'FIXTURE', reviewRequired: true,
      fields: { proposedPricePln: 10800, deliveryDays: 18 },
    });
    expect(agreement).toMatchObject({
      source: 'FIXTURE', reviewRequired: true,
      fields: {
        commercialTerms: ['Fixed price of PLN 11800', 'one evidence-backed revision is included', 'invoice after acceptance'],
        legalClauses: expect.arrayContaining(['Pre-existing IP remains with its owner']),
      },
    });
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
          deliveryDate: '2026-10-20', destinationCountry: 'IN',
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

    const companyJob = await call(harness, 'POST', '/v1/ai/extract-form', { token: harness.seed.polishCompany.token, body: jobBody });
    const freelancerProposal = await call(harness, 'POST', '/v1/ai/extract-form', { token: harness.seed.indianFreelancer.token, body: proposalBody });
    const freelancerJob = await call(harness, 'POST', '/v1/ai/extract-form', { token: harness.seed.indianFreelancer.token, body: jobBody });
    const companyProposal = await call(harness, 'POST', '/v1/ai/extract-form', { token: harness.seed.polishCompany.token, body: proposalBody });
    const companyAgreement = await call(harness, 'POST', '/v1/ai/extract-form', { token: harness.seed.polishCompany.token, body: agreementBody });
    const freelancerAgreement = await call(harness, 'POST', '/v1/ai/extract-form', { token: harness.seed.indianFreelancer.token, body: agreementBody });

    expect(companyJob.status).toBe(200);
    expect(freelancerProposal.status).toBe(200);
    expect(freelancerJob.status).toBe(403);
    expect(companyProposal.status).toBe(403);
    expect(companyAgreement.status).toBe(200);
    expect(freelancerAgreement.status).toBe(403);
  });
});
