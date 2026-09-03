/**
 * The flagship journey, end to end.
 *
 * A Polish company posts work, an Indian freelancer applies, both parties
 * approve a contract, the corridor rules pass, PLN is debited, USDC is locked,
 * the freelancer submits work, the company approves it, USDC is released and
 * the freelancer's simulated INR wallet is credited.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { call, createHarness, base64, type Harness } from './harness.js';
import { fiatAccounts, journalEntries, journalLines } from '../src/db/schema.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function walkToFundedContract(current: Harness) {
  const { polishCompany, indianFreelancer } = current.seed;

  const job = await call(current, 'POST', '/v1/jobs', {
    token: polishCompany.token,
    idempotencyKey: 'demo-job-0001',
    body: {
      title: 'Payments reconciliation service',
      description: 'Build a reconciliation service for a cross-border settlement pipeline, with tests.',
      skills: ['typescript', 'postgres', 'reconciliation'],
      destinationCountry: 'IN',
      budget: { amountMinor: '1200000', currency: 'PLN', scale: 2 },
    },
  });
  expect(job.status).toBe(201);

  const application = await call(current, 'POST', `/v1/jobs/${job.body.id}/applications`, {
    token: indianFreelancer.token,
    idempotencyKey: 'demo-application-0001',
    body: {
      coverLetter: 'I have shipped typescript and postgres reconciliation services for two payment providers.',
    },
  });
  expect(application.status).toBe(201);

  const evaluated = await call(current, 'POST', `/v1/applications/${application.body.id}/evaluate`, {
    token: polishCompany.token,
    idempotencyKey: 'demo-evaluate-0001',
    body: { select: false },
  });
  expect(evaluated.status).toBe(200);
  expect(evaluated.body.evaluation.advisoryOnly).toBe(true);
  expect(evaluated.body.citations.length).toBeGreaterThan(0);
  expect(evaluated.body.contract).toBeNull();

  const selected = await call(current, 'POST', `/v1/applications/${application.body.id}/select`, {
    token: polishCompany.token,
    idempotencyKey: 'demo-select-0001',
    body: { amount: { amountMinor: '1200000', currency: 'PLN', scale: 2 } },
  });
  expect(selected.status).toBe(200);
  const contract = selected.body;

  const buyerApproval = await call(current, 'POST', `/v1/contracts/${contract.id}/approve`, {
    token: polishCompany.token,
    idempotencyKey: 'demo-approve-buyer-0001',
    body: { party: 'BUYER', acceptedTermsHash: contract.contractHash },
  });
  expect(buyerApproval.status).toBe(200);
  expect(buyerApproval.body.contract.state).toBe('PARTY_APPROVAL_PENDING');

  const providerApproval = await call(current, 'POST', `/v1/contracts/${contract.id}/approve`, {
    token: indianFreelancer.token,
    idempotencyKey: 'demo-approve-provider-0001',
    body: { party: 'PROVIDER', acceptedTermsHash: contract.contractHash },
  });
  expect(providerApproval.status).toBe(200);
  expect(providerApproval.body.contract.state).toBe('RULES_VERIFIED');

  const documents = ['INVOICE', 'SERVICE_EXPORT_DECLARATION'];
  for (const [index, code] of documents.entries()) {
    const recorded = await call(current, 'POST', `/v1/contracts/${contract.id}/documents`, {
      token: polishCompany.token,
      idempotencyKey: `demo-document-${index}-0001`,
      body: { code, contentType: 'application/pdf', contentBase64: base64(`${code} demonstration document`) },
    });
    expect(recorded.status).toBe(201);
  }

  const payment = await call(current, 'POST', '/v1/payments', {
    token: polishCompany.token,
    idempotencyKey: 'demo-payment-0001',
    body: { contractId: contract.id, fundingAmount: { amountMinor: '1200000', currency: 'PLN', scale: 2 } },
  });
  expect(payment.status).toBe(201);
  return { contract, payment: payment.body };
}

describe('Poland to India inward journey', () => {
  it('carries a payment from a job posting to a simulated INR credit', async () => {
    harness = await createHarness();
    const current = harness;
    const { polishCompany, indianFreelancer } = current.seed;
    const { contract, payment } = await walkToFundedContract(current);

    expect(payment.payment.direction).toBe('INWARD');
    expect(payment.payment.bookId).toBe('PL-IN-INWARD');
    expect(payment.payment.state).toBe('QUOTED');
    expect(payment.compliance.outcome).toBe('PASSED');
    expect(payment.quote.payoutAmount.currency).toBe('INR');
    expect(payment.quote.settlementAmount.currency).toBe('USD');
    expect(payment.quote.settlementAmount.scale).toBe(6);

    // 12000.00 PLN at 0.25 USD/PLN is 3000.000000 USD gross, less 50 bps.
    expect(payment.quote.grossSettlementAmount.amountMinor).toBe('3000000000');
    expect(payment.quote.settlementAmount.amountMinor).toBe('2985000000');

    const funded = await call(current, 'POST', `/v1/payments/${payment.payment.id}/fund`, {
      token: polishCompany.token,
      idempotencyKey: 'demo-fund-0001',
    });
    expect(funded.status).toBe(200);
    expect(funded.body.payment.state).toBe('WORK_PENDING');

    const submission = await call(current, 'POST', `/v1/contracts/${contract.id}/submissions`, {
      token: indianFreelancer.token,
      idempotencyKey: 'demo-submission-0001',
      body: {
        fileName: 'reconciliation-service.zip',
        contentType: 'application/zip',
        contentBase64: base64('deliverable bytes'),
        note: 'First delivery of the reconciliation service.',
      },
    });
    expect(submission.status).toBe(201);
    expect(submission.body.fabricTxId).toMatch(/^FABRIC-SUBMIT-/u);

    const access = await call(current, 'GET', `/v1/submissions/${submission.body.submission.id}/access`, {
      token: polishCompany.token,
    });
    expect(access.status).toBe(200);
    expect(access.body.ttlSeconds).toBeGreaterThan(0);
    expect(access.body.fileHash).toBe(submission.body.submission.fileHash);
    // A signed URL, never a raw storage key.
    expect(JSON.stringify(access.body)).not.toContain('deliverable/');

    const validation = await call(current, 'POST', `/v1/submissions/${submission.body.submission.id}/evaluate`, {
      token: polishCompany.token,
      idempotencyKey: 'demo-work-validation-0001',
    });
    expect(validation.status).toBe(200);
    expect(validation.body.advisory.advisoryOnly).toBe(true);

    const decided = await call(current, 'POST', `/v1/submissions/${submission.body.submission.id}/approve`, {
      token: polishCompany.token,
      idempotencyKey: 'demo-decision-0001',
      body: { decision: 'APPROVED', comment: 'Accepted.' },
    });
    expect(decided.status).toBe(200);
    expect(decided.body.fabricTxId).toMatch(/^FABRIC-DECIDE-/u);
    expect(decided.body.advisory.advisoryOnly).toBe(true);

    const released = await call(current, 'POST', `/v1/payments/${payment.payment.id}/release`, {
      token: polishCompany.token,
      idempotencyKey: 'demo-release-0001',
    });
    expect(released.status).toBe(200);
    expect(released.body.payment.state).toBe('COMPLETED');

    const timeline = await call(current, 'GET', `/v1/payments/${payment.payment.id}/timeline`, {
      token: polishCompany.token,
    });
    expect(timeline.status).toBe(200);
    const kinds = timeline.body.events.map((event: { kind: string }) => event.kind);
    expect(kinds).toEqual(expect.arrayContaining([
      'CORRIDOR_RESOLVED', 'FX_QUOTED', 'COMPLIANCE_EVALUATED', 'PAYMENT_CREATED',
      'FIAT_FUNDED', 'ESCROW_CREATED', 'USDC_LOCKED', 'WORK_SUBMITTED', 'WORK_EVALUATED', 'WORK_APPROVED',
      'RELEASE_AUTHORIZED', 'USDC_RELEASED', 'PAYOUT_CREDITED', 'PAYMENT_COMPLETED',
    ]));
    expect(timeline.body.reconciliation.status).toBe('MATCHED');
    expect(timeline.body.binding.network).toBe('localnet');

    // The freelancer's simulated INR wallet holds exactly the quoted payout.
    const wallet = await current.context.store.findOne(fiatAccounts, {
      bookId: 'PL-IN-INWARD',
      ownerId: indianFreelancer.organizationId,
      accountType: 'BENEFICIARY_WALLET',
      currency: 'INR',
    });
    expect(wallet).not.toBeNull();
    const balance = await current.context.ledger.balance(wallet!.id);
    expect(balance.amount.currency).toBe('INR');
    expect(balance.amount.amountMinor).toBe(payment.quote.payoutAmount.amountMinor);
    expect(balance.signedMinor).toBe(payment.quote.payoutAmount.amountMinor);

    // Every entry in the book balances, and the book as a whole balances.
    expect(await current.context.ledger.bookIsBalanced('PL-IN-INWARD')).toBe(true);
    const entries = await current.context.store.findMany(journalEntries, { bookId: 'PL-IN-INWARD' });
    expect(entries.length).toBeGreaterThanOrEqual(4);
    for (const entry of entries) {
      const lines = await current.context.store.findMany(journalLines, { entryId: entry.id });
      const debits = lines.filter((line) => line.side === 'DEBIT')
        .reduce((sum, line) => sum + BigInt(line.amountMinor), 0n);
      const credits = lines.filter((line) => line.side === 'CREDIT')
        .reduce((sum, line) => sum + BigInt(line.amountMinor), 0n);
      expect(debits).toBe(credits);
      expect(lines.every((line) => line.direction === 'INWARD')).toBe(true);
    }
  });

  it('refuses a release until Fabric holds an approved version, and never releases twice', async () => {
    harness = await createHarness();
    const current = harness;
    const { polishCompany, indianFreelancer } = current.seed;
    const { contract, payment } = await walkToFundedContract(current);

    await call(current, 'POST', `/v1/payments/${payment.payment.id}/fund`, {
      token: polishCompany.token,
      idempotencyKey: 'demo-fund-0002',
    });

    const early = await call(current, 'POST', `/v1/payments/${payment.payment.id}/release`, {
      token: polishCompany.token,
      idempotencyKey: 'demo-release-early-0002',
    });
    expect(early.status).toBe(409);
    expect(early.body.error.message).toMatch(/Fabric-recorded buyer approval/u);

    const submission = await call(current, 'POST', `/v1/contracts/${contract.id}/submissions`, {
      token: indianFreelancer.token,
      idempotencyKey: 'demo-submission-0002',
      body: {
        fileName: 'draft.zip',
        contentType: 'application/zip',
        contentBase64: base64('first draft'),
        note: 'Draft.',
      },
    });
    const revision = await call(current, 'POST', `/v1/submissions/${submission.body.submission.id}/approve`, {
      token: polishCompany.token,
      idempotencyKey: 'demo-decision-revision-0002',
      body: { decision: 'REVISION_REQUIRED', comment: 'Please add tests.' },
    });
    expect(revision.status).toBe(200);

    const stillBlocked = await call(current, 'POST', `/v1/payments/${payment.payment.id}/release`, {
      token: polishCompany.token,
      idempotencyKey: 'demo-release-blocked-0002',
    });
    expect(stillBlocked.status).toBe(409);

    const second = await call(current, 'POST', `/v1/contracts/${contract.id}/submissions`, {
      token: indianFreelancer.token,
      idempotencyKey: 'demo-submission-0003',
      body: {
        fileName: 'final.zip',
        contentType: 'application/zip',
        contentBase64: base64('final delivery with tests'),
        note: 'Tests added.',
      },
    });
    expect(second.body.submission.version).toBe(2);
    await call(current, 'POST', `/v1/submissions/${second.body.submission.id}/approve`, {
      token: polishCompany.token,
      idempotencyKey: 'demo-decision-approve-0002',
      body: { decision: 'APPROVED', comment: 'Accepted.' },
    });

    const released = await call(current, 'POST', `/v1/payments/${payment.payment.id}/release`, {
      token: polishCompany.token,
      idempotencyKey: 'demo-release-0002',
    });
    expect(released.status).toBe(200);
    expect(released.body.payment.state).toBe('COMPLETED');

    // A different key for the same completed payment must not release again.
    const again = await call(current, 'POST', `/v1/payments/${payment.payment.id}/release`, {
      token: polishCompany.token,
      idempotencyKey: 'demo-release-0002-again',
    });
    expect(again.status).toBe(200);
    expect(again.body.payment.state).toBe('COMPLETED');
    const escrow = await current.context.escrow.get(contract.id);
    expect(Object.keys(escrow!.releases)).toHaveLength(1);
    expect(escrow!.releasedMinor).toBe(payment.quote.settlementAmount.amountMinor);
  });

  it('refunds a funded payment back to the buyer book without touching the payout book', async () => {
    harness = await createHarness();
    const current = harness;
    const { polishCompany } = current.seed;
    const { payment } = await walkToFundedContract(current);

    await call(current, 'POST', `/v1/payments/${payment.payment.id}/fund`, {
      token: polishCompany.token,
      idempotencyKey: 'demo-fund-0004',
    });
    const refunded = await call(current, 'POST', `/v1/payments/${payment.payment.id}/refund`, {
      token: polishCompany.token,
      idempotencyKey: 'demo-refund-0004',
      body: { reason: 'The buyer cancelled the engagement.' },
    });
    expect(refunded.status).toBe(200);
    expect(refunded.body.payment.state).toBe('REFUNDED');

    const customerAccount = await current.context.store.findOne(fiatAccounts, {
      bookId: 'PL-IN-INWARD',
      ownerId: polishCompany.organizationId,
      accountType: 'CUSTOMER_FUNDING',
      currency: 'PLN',
    });
    const balance = await current.context.ledger.balance(customerAccount!.id);
    expect(balance.signedMinor).toBe('0');
    expect(await current.context.ledger.bookIsBalanced('PL-IN-INWARD')).toBe(true);
  });
});
