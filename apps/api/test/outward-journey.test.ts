/**
 * The India to United Kingdom supplier journey.
 *
 * It proves the separation that matters: the outward payment lands in its own
 * book, shares no account with any inward payment, applies the Indian import
 * due-diligence rule that inward freelancer payments must never see, and
 * requires Form A2, tax-review and import-evidence document commitments.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { base64, call, createHarness, type Harness } from './harness.js';
import { fiatAccounts, journalLines } from '../src/db/schema.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function supplierContract(current: Harness, fundingMinor: string) {
  const { indianCompany, ukSupplier } = current.seed;
  const job = await call(current, 'POST', '/v1/jobs', {
    token: indianCompany.token,
    idempotencyKey: `outward-job-${fundingMinor}`,
    body: {
      title: 'Precision optical assemblies',
      description: 'Supply calibrated optical assemblies against the attached specification and invoice.',
      skills: ['optics', 'manufacturing'],
      payerCountry: 'IN',
      fundingCurrency: 'INR',
      destinationCountry: 'GB',
      budget: { amountMinor: fundingMinor, currency: 'INR', scale: 2 },
    },
  });
  const application = await call(current, 'POST', `/v1/jobs/${job.body.id}/applications`, {
    token: ukSupplier.token,
    idempotencyKey: `outward-application-${fundingMinor}`,
    body: {
      residenceCountry: 'GB', payoutCountry: 'GB', payoutCurrency: 'GBP',
      coverLetter: 'Pennine Optics supplies calibrated optics and manufacturing to specification.',
    },
  });
  const evaluated = await call(current, 'POST', `/v1/applications/${application.body.id}/evaluate`, {
    token: indianCompany.token,
    idempotencyKey: `outward-evaluate-${fundingMinor}`,
    body: { select: true, amount: { amountMinor: fundingMinor, currency: 'INR', scale: 2 } },
  });
  const contract = evaluated.body.contract;
  await call(current, 'POST', `/v1/contracts/${contract.id}/approve`, {
    token: indianCompany.token,
    idempotencyKey: `outward-approve-buyer-${fundingMinor}`,
    body: { party: 'BUYER', acceptedTermsHash: contract.contractHash },
  });
  await call(current, 'POST', `/v1/contracts/${contract.id}/approve`, {
    token: ukSupplier.token,
    idempotencyKey: `outward-approve-provider-${fundingMinor}`,
    body: { party: 'PROVIDER', acceptedTermsHash: contract.contractHash },
  });
  return contract;
}

const IMPORT_DOCUMENTS = [
  'AUTHORISED_DEALER_REVIEW', 'BUYER_DUE_DILIGENCE', 'BUYER_DUE_DILIGENCE_CONDITIONAL',
  'COMMODITY_CODE', 'EXPORT_LICENCE_IF_REQUIRED', 'FOREIGN_MERCHANT_CDD', 'FORM_15CA_CONDITIONAL',
  'FORM_15CB_CONDITIONAL', 'FORM_A2_DEMO', 'FX_AND_FEE_DISCLOSURE', 'IMPORT_EVIDENCE', 'INVOICE',
  'PACKING_LIST', 'PAYEE_TRANSACTION_RECORD', 'PAYMENT_PURPOSE_DECLARATION', 'RESTRICTED_TRADE_SCREENING',
  'TAX_REVIEW_DEMO', 'UK_EXPORT_DECLARATION', 'UK_EXPORT_VAT_EVIDENCE', 'UK_SANCTIONS_SCREENING',
] as const;

function documents(codes: readonly string[]) {
  return codes.map((code) => ({
    code,
    contentType: 'application/pdf',
    contentBase64: base64(`${code} demonstration document`),
  }));
}

describe('India to United Kingdom outward supplier journey', () => {
  it('books an outward payment in its own book with import documents and Form A2 simulation', async () => {
    harness = await createHarness();
    const current = harness;
    const { indianCompany, ukSupplier } = current.seed;
    // 8,00,000 INR - above the 2.5 lakh import due-diligence threshold.
    const contract = await supplierContract(current, '80000000');

    const created = await call(current, 'POST', '/v1/supplier-payments', {
      token: indianCompany.token,
      idempotencyKey: 'outward-payment-0001',
      body: {
        contractId: contract.id,
        fundingAmount: { amountMinor: '80000000', currency: 'INR', scale: 2 },
        invoiceReference: 'INV-PENNINE-2026-0042',
        documents: documents(IMPORT_DOCUMENTS),
      },
    });
    expect(created.status).toBe(201);
    expect(created.body.payment.direction).toBe('OUTWARD');
    expect(created.body.payment.bookId).toBe('IN-GB-OUTWARD');
    expect(created.body.quote.payoutAmount.currency).toBe('GBP');
    expect(created.body.compliance.outcome).toBe('PASSED');
    // The import buyer due-diligence rule applied, because this is outward.
    expect(created.body.compliance.appliedRules).toContain('RBI_IMPORT_BUYER_DD');
    expect(created.body.compliance.requiredDocuments.map((d: { code: string }) => d.code))
      .toEqual(expect.arrayContaining(['FORM_A2_DEMO', 'TAX_REVIEW_DEMO', 'IMPORT_EVIDENCE', 'BUYER_DUE_DILIGENCE']));

    const funded = await call(current, 'POST', `/v1/payments/${created.body.payment.id}/fund`, {
      token: indianCompany.token,
      idempotencyKey: 'outward-fund-0001',
    });
    expect(funded.status).toBe(200);
    expect(funded.body.payment.state).toBe('WORK_PENDING');

    const submission = await call(current, 'POST', `/v1/contracts/${contract.id}/submissions`, {
      token: ukSupplier.token,
      idempotencyKey: 'outward-submission-0001',
      body: {
        fileName: 'shipment-manifest.pdf',
        contentType: 'application/pdf',
        contentBase64: base64('shipment manifest'),
        note: 'Assemblies shipped.',
      },
    });
    await call(current, 'POST', `/v1/submissions/${submission.body.submission.id}/approve`, {
      token: indianCompany.token,
      idempotencyKey: 'outward-decision-0001',
      body: { decision: 'APPROVED', comment: 'Goods received.' },
    });
    const released = await call(current, 'POST', `/v1/payments/${created.body.payment.id}/release`, {
      token: indianCompany.token,
      idempotencyKey: 'outward-release-0001',
    });
    expect(released.status).toBe(200);
    expect(released.body.payment.state).toBe('COMPLETED');

    const wallet = await current.context.store.findOne(fiatAccounts, {
      bookId: 'IN-GB-OUTWARD',
      ownerId: ukSupplier.organizationId,
      accountType: 'BENEFICIARY_WALLET',
      currency: 'GBP',
    });
    const balance = await current.context.ledger.balance(wallet!.id);
    expect(balance.amount.currency).toBe('GBP');
    expect(balance.amount.amountMinor).toBe(created.body.quote.payoutAmount.amountMinor);
    expect(await current.context.ledger.bookIsBalanced('IN-GB-OUTWARD')).toBe(true);
  });

  it('never lets an outward posting touch an inward account', async () => {
    harness = await createHarness();
    const current = harness;
    const { indianCompany } = current.seed;
    const contract = await supplierContract(current, '80000000');
    const created = await call(current, 'POST', '/v1/supplier-payments', {
      token: indianCompany.token,
      idempotencyKey: 'outward-payment-0002',
      body: {
        contractId: contract.id,
        fundingAmount: { amountMinor: '80000000', currency: 'INR', scale: 2 },
        invoiceReference: 'INV-PENNINE-2026-0043',
        documents: documents(IMPORT_DOCUMENTS),
      },
    });
    await call(current, 'POST', `/v1/payments/${created.body.payment.id}/fund`, {
      token: indianCompany.token,
      idempotencyKey: 'outward-fund-0002',
    });

    const outwardLines = await current.context.store.findMany(journalLines, { bookId: 'IN-GB-OUTWARD' });
    expect(outwardLines.length).toBeGreaterThan(0);
    expect(outwardLines.every((line) => line.direction === 'OUTWARD')).toBe(true);

    // Every account an outward line references belongs to the outward book.
    for (const line of outwardLines) {
      const account = await current.context.store.findOne(fiatAccounts, { id: line.accountId });
      expect(account?.bookId).toBe('IN-GB-OUTWARD');
      expect(account?.direction).toBe('OUTWARD');
    }

    // An explicit attempt to net across books is refused by the ledger.
    const inwardAccount = await current.context.ledger.account({
      bookId: 'PL-IN-INWARD',
      direction: 'INWARD',
      ownerKind: 'PLATFORM',
      ownerId: 'OPTIWORK',
      accountType: 'ESCROW_CONTROL',
      currency: 'USD',
      scale: 6,
    });
    const outwardAccount = await current.context.ledger.account({
      bookId: 'IN-GB-OUTWARD',
      direction: 'OUTWARD',
      ownerKind: 'PLATFORM',
      ownerId: 'OPTIWORK',
      accountType: 'ESCROW_CONTROL',
      currency: 'USD',
      scale: 6,
    });
    await expect(current.context.ledger.post({
      bookId: 'IN-GB-OUTWARD',
      direction: 'OUTWARD',
      reference: 'ILLEGAL-NETTING',
      memo: 'Attempt to net inward against outward.',
      lines: [
        { accountId: outwardAccount, side: 'DEBIT', amount: { amountMinor: '1', currency: 'USD', scale: 6 } },
        { accountId: inwardAccount, side: 'CREDIT', amount: { amountMinor: '1', currency: 'USD', scale: 6 } },
      ],
    })).rejects.toThrow(/cannot be netted/u);
  });

  it('blocks an outward payment above the per-unit cap', async () => {
    harness = await createHarness();
    const current = harness;
    const { indianCompany } = current.seed;
    // 30 lakh INR, above the 25 lakh per-unit ceiling.
    const contract = await supplierContract(current, '300000000');
    const created = await call(current, 'POST', '/v1/supplier-payments', {
      token: indianCompany.token,
      idempotencyKey: 'outward-payment-0003',
      body: {
        contractId: contract.id,
        fundingAmount: { amountMinor: '300000000', currency: 'INR', scale: 2 },
        invoiceReference: 'INV-PENNINE-2026-0044',
        documents: documents(IMPORT_DOCUMENTS),
      },
    });
    expect(created.status).toBe(422);
    expect(JSON.stringify(created.body.error.detail.reasons)).toMatch(/RBI_PER_UNIT_CAP/u);
  });

  it('holds an outward payment for manual review when a required document is missing', async () => {
    harness = await createHarness();
    const current = harness;
    const { indianCompany } = current.seed;
    const contract = await supplierContract(current, '80000000');
    const created = await call(current, 'POST', '/v1/supplier-payments', {
      token: indianCompany.token,
      idempotencyKey: 'outward-payment-0005',
      body: {
        contractId: contract.id,
        fundingAmount: { amountMinor: '80000000', currency: 'INR', scale: 2 },
        invoiceReference: 'INV-PENNINE-2026-0045',
        documents: documents(['INVOICE', 'FORM_A2_DEMO']),
      },
    });
    expect(created.status).toBe(201);
    expect(created.body.compliance.outcome).toBe('MANUAL_REVIEW');
    expect(created.body.payment.state).toBe('MANUAL_REVIEW');

    const funded = await call(current, 'POST', `/v1/payments/${created.body.payment.id}/fund`, {
      token: indianCompany.token,
      idempotencyKey: 'outward-fund-0005',
    });
    expect(funded.status).toBe(409);
  });
});
