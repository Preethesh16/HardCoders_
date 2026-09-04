import { afterEach, describe, expect, it } from 'vitest';
import { call, createHarness, type Harness } from './harness.js';
import { escrowBindings, fxQuotes, paymentInstructions, workContracts } from '../src/db/schema.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function postPolishJob(current: Harness, key: string) {
  return call(current, 'POST', '/v1/jobs', {
    token: current.seed.polishCompany.token,
    idempotencyKey: key,
    body: {
      title: 'Dynamic corridor engineering',
      description: 'Build a tested cross-border workflow whose payment route follows the selected parties.',
      skills: ['typescript'],
      payerCountry: 'PL',
      fundingCurrency: 'PLN',
      destinationCountry: 'IN',
      budget: { amountMinor: '1200000', currency: 'PLN', scale: 2 },
    },
  });
}

async function applyFromIndia(current: Harness, jobId: string, key: string, payoutCurrency = 'INR') {
  return call(current, 'POST', `/v1/jobs/${jobId}/applications`, {
    token: current.seed.indianFreelancer.token,
    idempotencyKey: key,
    body: {
      residenceCountry: 'IN',
      payoutCountry: 'IN',
      payoutCurrency,
      coverLetter: 'I can deliver the requested implementation with acceptance tests and operating documentation.',
    },
  });
}

describe('deal-derived corridor facts', () => {
  it('persists explicit payer/proposal facts and snapshots the ordered PL to IN route at human selection', async () => {
    harness = await createHarness();
    const job = await postPolishJob(harness, 'dynamic-job-1');
    expect(job.status).toBe(201);
    expect(job.body).toMatchObject({ payerCountry: 'PL', fundingCurrency: 'PLN' });

    const proposal = await applyFromIndia(harness, job.body.id, 'dynamic-apply-1');
    expect(proposal.status).toBe(201);
    expect(proposal.body).toMatchObject({
      residenceCountry: 'IN', payoutCountry: 'IN', payoutCurrency: 'INR',
    });

    const selected = await call(harness, 'POST', `/v1/applications/${proposal.body.id}/select`, {
      token: harness.seed.polishCompany.token,
      idempotencyKey: 'dynamic-select-1',
      body: { amount: { amountMinor: '1200000', currency: 'PLN', scale: 2 } },
    });
    expect(selected.status).toBe(200);
    expect(selected.body).toMatchObject({
      payerCountry: 'PL', fundingCurrency: 'PLN', providerResidenceCountry: 'IN',
      payoutCountry: 'IN', payoutCurrency: 'INR', corridorId: 'PL-IN-INWARD-v1',
      corridorDirection: 'INWARD', corridorBookId: 'PL-IN-INWARD',
    });
  });

  it('rejects country/currency claims that conflict with verified organizations or configured rails', async () => {
    harness = await createHarness();
    const wrongPayer = await call(harness, 'POST', '/v1/jobs', {
      token: harness.seed.polishCompany.token,
      idempotencyKey: 'dynamic-job-wrong-payer',
      body: {
        title: 'Incorrect payer country',
        description: 'This request attempts to claim a payer country that differs from the verified company.',
        skills: ['typescript'], payerCountry: 'GB', fundingCurrency: 'PLN', destinationCountry: 'IN',
        budget: { amountMinor: '1200000', currency: 'PLN', scale: 2 },
      },
    });
    expect(wrongPayer.status).toBe(422);

    const job = await postPolishJob(harness, 'dynamic-job-2');
    const wrongResidence = await call(harness, 'POST', `/v1/jobs/${job.body.id}/applications`, {
      token: harness.seed.indianFreelancer.token,
      idempotencyKey: 'dynamic-apply-wrong-residence',
      body: {
        residenceCountry: 'GB', payoutCountry: 'GB', payoutCurrency: 'GBP',
        coverLetter: 'This proposal intentionally conflicts with the verified applicant organization country.',
      },
    });
    expect(wrongResidence.status).toBe(422);

    const wrongCurrency = await applyFromIndia(harness, job.body.id, 'dynamic-apply-wrong-currency', 'GBP');
    expect(wrongCurrency.status).toBe(201);
    const selection = await call(harness, 'POST', `/v1/applications/${wrongCurrency.body.id}/select`, {
      token: harness.seed.polishCompany.token,
      idempotencyKey: 'dynamic-select-wrong-currency',
      body: { amount: { amountMinor: '1200000', currency: 'PLN', scale: 2 } },
    });
    expect(selection.status).toBe(422);
    expect(selection.body.error.message).toMatch(/requires INR payout/u);
  });

  it('rejects a tampered selected-deal snapshot before creating an FX quote or payment', async () => {
    harness = await createHarness();
    const job = await postPolishJob(harness, 'dynamic-job-3');
    const proposal = await applyFromIndia(harness, job.body.id, 'dynamic-apply-3');
    const selected = await call(harness, 'POST', `/v1/applications/${proposal.body.id}/select`, {
      token: harness.seed.polishCompany.token,
      idempotencyKey: 'dynamic-select-3',
      body: { amount: { amountMinor: '1200000', currency: 'PLN', scale: 2 } },
    });
    await call(harness, 'POST', `/v1/contracts/${selected.body.id}/approve`, {
      token: harness.seed.polishCompany.token, idempotencyKey: 'dynamic-buyer-approve-3',
      body: { party: 'BUYER', acceptedTermsHash: selected.body.contractHash },
    });
    await call(harness, 'POST', `/v1/contracts/${selected.body.id}/approve`, {
      token: harness.seed.indianFreelancer.token, idempotencyKey: 'dynamic-provider-approve-3',
      body: { party: 'PROVIDER', acceptedTermsHash: selected.body.contractHash },
    });

    await harness.context.store.update(workContracts, { id: selected.body.id }, { payoutCurrency: 'GBP' });
    const payment = await call(harness, 'POST', '/v1/payments', {
      token: harness.seed.polishCompany.token,
      idempotencyKey: 'dynamic-payment-tamper-3',
      body: {
        contractId: selected.body.id,
        fundingAmount: { amountMinor: '1200000', currency: 'PLN', scale: 2 },
      },
    });
    expect(payment.status).toBe(422);
    expect(await harness.context.store.findMany(fxQuotes, {})).toHaveLength(0);
    expect(await harness.context.store.findMany(paymentInstructions, {})).toHaveLength(0);
  });

  it('binds a blocked corridor into the private agreement but refuses payment before FX or escrow', async () => {
    harness = await createHarness();
    const job = await call(harness, 'POST', '/v1/jobs', {
      token: harness.seed.polishCompany.token,
      idempotencyKey: 'blocked-job-pl-kp',
      body: {
        title: 'Blocked corridor policy demonstration',
        description: 'Create a private agreement so reviewers can inspect why this ordered route cannot settle.',
        skills: ['policy-review'], payerCountry: 'PL', fundingCurrency: 'PLN', destinationCountry: 'KP',
        budget: { amountMinor: '100000', currency: 'PLN', scale: 2 },
      },
    });
    const proposal = await call(harness, 'POST', `/v1/jobs/${job.body.id}/applications`, {
      token: harness.seed.northKoreanFreelancer.token,
      idempotencyKey: 'blocked-apply-pl-kp',
      body: {
        residenceCountry: 'KP', payoutCountry: 'KP', payoutCurrency: 'KPW',
        coverLetter: 'This signed demo identity is used only to demonstrate the mandatory blocked-policy gate.',
      },
    });
    const selected = await call(harness, 'POST', `/v1/applications/${proposal.body.id}/select`, {
      token: harness.seed.polishCompany.token,
      idempotencyKey: 'blocked-select-pl-kp',
      body: { amount: { amountMinor: '100000', currency: 'PLN', scale: 2 } },
    });
    expect(selected.status).toBe(200);
    expect(selected.body).toMatchObject({
      corridorId: 'PL-KP-OUTWARD-v1', corridorBookId: 'PL-KP-OUTWARD', corridorDirection: 'OUTWARD',
    });
    const agreement = await call(harness, 'GET', `/v1/contracts/${selected.body.id}/agreement/access`, {
      token: harness.seed.northKoreanFreelancer.token,
    });
    expect(agreement.status).toBe(200);

    await call(harness, 'POST', `/v1/contracts/${selected.body.id}/approve`, {
      token: harness.seed.polishCompany.token, idempotencyKey: 'blocked-approve-buyer-pl-kp',
      body: { party: 'BUYER', acceptedTermsHash: selected.body.contractHash },
    });
    await call(harness, 'POST', `/v1/contracts/${selected.body.id}/approve`, {
      token: harness.seed.northKoreanFreelancer.token, idempotencyKey: 'blocked-approve-provider-pl-kp',
      body: { party: 'PROVIDER', acceptedTermsHash: selected.body.contractHash },
    });
    const payment = await call(harness, 'POST', '/v1/payments', {
      token: harness.seed.polishCompany.token,
      idempotencyKey: 'blocked-payment-pl-kp',
      body: {
        contractId: selected.body.id,
        fundingAmount: { amountMinor: '100000', currency: 'PLN', scale: 2 },
      },
    });
    expect(payment.status).toBe(422);
    expect(payment.body.error.message).toMatch(/blocked by policy/u);
    expect(await harness.context.store.findMany(fxQuotes, {})).toHaveLength(0);
    expect(await harness.context.store.findMany(paymentInstructions, {})).toHaveLength(0);
    expect(await harness.context.store.findMany(escrowBindings, {})).toHaveLength(0);
  });

  it('binds and quotes a reviewed EU service route on its deployed provider rail', async () => {
    harness = await createHarness();
    const job = await call(harness, 'POST', '/v1/jobs', {
      token: harness.seed.germanCompany.token,
      idempotencyKey: 'review-job-de-pl',
      body: {
        title: 'EU corridor review demonstration',
        description: 'Demonstrate that a valid signed pair can agree and use the reviewed EU settlement rail.',
        skills: ['compliance'], payerCountry: 'DE', fundingCurrency: 'EUR', destinationCountry: 'PL',
        budget: { amountMinor: '100000', currency: 'EUR', scale: 2 },
      },
    });
    const proposal = await call(harness, 'POST', `/v1/jobs/${job.body.id}/applications`, {
      token: harness.seed.polishFreelancer.token,
      idempotencyKey: 'review-apply-de-pl',
      body: {
        residenceCountry: 'PL', payoutCountry: 'PL', payoutCurrency: 'PLN',
        coverLetter: 'This country-matched demo proposal exercises the reviewed EU provider rail.',
      },
    });
    const selected = await call(harness, 'POST', `/v1/applications/${proposal.body.id}/select`, {
      token: harness.seed.germanCompany.token,
      idempotencyKey: 'review-select-de-pl',
      body: { amount: { amountMinor: '100000', currency: 'EUR', scale: 2 } },
    });
    expect(selected.body).toMatchObject({
      corridorId: 'DE-PL-EU-B2B-v1', corridorBookId: 'DE-PL-OUTWARD', corridorDirection: 'OUTWARD',
    });
    await call(harness, 'POST', `/v1/contracts/${selected.body.id}/approve`, {
      token: harness.seed.germanCompany.token, idempotencyKey: 'review-approve-buyer-de-pl',
      body: { party: 'BUYER', acceptedTermsHash: selected.body.contractHash },
    });
    await call(harness, 'POST', `/v1/contracts/${selected.body.id}/approve`, {
      token: harness.seed.polishFreelancer.token, idempotencyKey: 'review-approve-provider-de-pl',
      body: { party: 'PROVIDER', acceptedTermsHash: selected.body.contractHash },
    });
    const payment = await call(harness, 'POST', '/v1/payments', {
      token: harness.seed.germanCompany.token,
      idempotencyKey: 'review-payment-de-pl',
      body: {
        contractId: selected.body.id,
        fundingAmount: { amountMinor: '100000', currency: 'EUR', scale: 2 },
      },
    });
    expect(payment.status).toBe(201);
    expect(payment.body.compliance.outcome).toBe('MANUAL_REVIEW');
    expect(payment.body.compliance.reasons.join(' ')).toMatch(/document/iu);
    expect(await harness.context.store.findMany(fxQuotes, {})).toHaveLength(1);
    expect(await harness.context.store.findMany(paymentInstructions, {})).toHaveLength(1);
    expect(await harness.context.store.findMany(escrowBindings, {})).toHaveLength(0);
  });
});
