/**
 * Payment state transitions.
 *
 * The saga may only advance along the transitions the shared domain state
 * machine allows, and reconciliation records a disagreement rather than
 * silently repairing it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { base64, call, createHarness, type Harness } from './harness.js';
import { canTransitionPayment } from '@optiwork/domain';
import { escrowBindings, fxQuotes, paymentInstructions, providerCommands } from '../src/db/schema.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
  vi.unstubAllGlobals();
});

async function quotedPayment(current: Harness, purposeCode?: string) {
  const { polishCompany, indianFreelancer } = current.seed;
  const job = await call(current, 'POST', '/v1/jobs', {
    token: polishCompany.token,
    idempotencyKey: 'state-job-0001',
    body: {
      title: 'State machine probe',
      description: 'A posting used to walk the payment state machine through its legal transitions.',
      skills: ['typescript'],
      payerCountry: 'PL',
      fundingCurrency: 'PLN',
      destinationCountry: 'IN',
      budget: { amountMinor: '1200000', currency: 'PLN', scale: 2 },
    },
  });
  const application = await call(current, 'POST', `/v1/jobs/${job.body.id}/applications`, {
    token: indianFreelancer.token,
    idempotencyKey: 'state-application-0001',
    body: {
      residenceCountry: 'IN', payoutCountry: 'IN', payoutCurrency: 'INR',
      coverLetter: 'An application used to walk the payment state machine end to end.',
    },
  });
  const evaluated = await call(current, 'POST', `/v1/applications/${application.body.id}/evaluate`, {
    token: polishCompany.token,
    idempotencyKey: 'state-evaluate-0001',
    body: { select: true, amount: { amountMinor: '1200000', currency: 'PLN', scale: 2 } },
  });
  const contract = evaluated.body.contract;
  await call(current, 'POST', `/v1/contracts/${contract.id}/approve`, {
    token: polishCompany.token,
    idempotencyKey: 'state-approve-buyer',
    body: { party: 'BUYER', acceptedTermsHash: contract.contractHash },
  });
  await call(current, 'POST', `/v1/contracts/${contract.id}/approve`, {
    token: indianFreelancer.token,
    idempotencyKey: 'state-approve-provider',
    body: { party: 'PROVIDER', acceptedTermsHash: contract.contractHash },
  });
  for (const [index, code] of [
    'CESOP_REPORTING_ASSESSMENT', 'EU_PARTY_SCREENING', 'INDIA_MERCHANT_CDD', 'INVOICE',
    'PAYER_PAYEE_TRANSFER_DATA', 'PAYMENT_RECIPIENT_RECORD', 'PURPOSE_CODE_P0802',
    'RESTRICTED_TRADE_SCREENING', 'SERVICE_EXPORT_DECLARATION',
  ].entries()) {
    await call(current, 'POST', `/v1/contracts/${contract.id}/documents`, {
      token: polishCompany.token,
      idempotencyKey: `state-document-${index}`,
      body: { code, contentType: 'application/pdf', contentBase64: base64(code) },
    });
  }
  const payment = await call(current, 'POST', '/v1/payments', {
    token: polishCompany.token,
    idempotencyKey: 'state-payment-0001',
    body: {
      contractId: contract.id,
      fundingAmount: { amountMinor: '1200000', currency: 'PLN', scale: 2 },
      ...(purposeCode === undefined ? {} : { purposeCode }),
    },
  });
  return { contract, payment: payment.body.payment, result: payment.body };
}

describe('payment state machine', () => {
  it('agrees with the shared domain transition table', () => {
    expect(canTransitionPayment('QUOTED', 'FIAT_FUNDED')).toBe(true);
    expect(canTransitionPayment('FIAT_FUNDED', 'ESCROW_CREATED')).toBe(true);
    expect(canTransitionPayment('USDC_LOCKED', 'WORK_PENDING')).toBe(true);
    expect(canTransitionPayment('WORK_PENDING', 'RELEASE_AUTHORIZED')).toBe(true);
    expect(canTransitionPayment('RELEASE_AUTHORIZED', 'USDC_RELEASED')).toBe(true);
    expect(canTransitionPayment('PAYOUT_CREDITED', 'COMPLETED')).toBe(true);

    expect(canTransitionPayment('QUOTED', 'USDC_RELEASED')).toBe(false);
    expect(canTransitionPayment('COMPLETED', 'REFUNDED')).toBe(false);
    expect(canTransitionPayment('REFUNDED', 'USDC_LOCKED')).toBe(false);
  });

  it('refuses to release or refund a payment that has not been funded', async () => {
    harness = await createHarness();
    const current = harness;
    const { payment } = await quotedPayment(current);
    expect(payment.state).toBe('QUOTED');

    const released = await call(current, 'POST', `/v1/payments/${payment.id}/release`, {
      token: current.seed.polishCompany.token,
      idempotencyKey: 'state-release-early',
    });
    expect(released.status).toBe(409);
    expect(released.body.error.message).toMatch(/cannot be released from state QUOTED/u);

    const refunded = await call(current, 'POST', `/v1/payments/${payment.id}/refund`, {
      token: current.seed.polishCompany.token,
      idempotencyKey: 'state-refund-early',
      body: { reason: 'Nothing has been funded yet.' },
    });
    expect(refunded.status).toBe(409);
  });

  it('treats a repeated fund as an idempotent no-op rather than a second lock', async () => {
    harness = await createHarness();
    const current = harness;
    const { contract, payment } = await quotedPayment(current);

    const first = await call(current, 'POST', `/v1/payments/${payment.id}/fund`, {
      token: current.seed.polishCompany.token,
      idempotencyKey: 'state-fund-0001',
    });
    expect(first.body.payment.state).toBe('WORK_PENDING');

    // A different key on an already funded payment must not lock a second time.
    const second = await call(current, 'POST', `/v1/payments/${payment.id}/fund`, {
      token: current.seed.polishCompany.token,
      idempotencyKey: 'state-fund-0002',
    });
    expect(second.status).toBe(200);
    expect(second.body.payment.state).toBe('WORK_PENDING');

    const escrow = await current.context.escrow.get(contract.id);
    expect(escrow!.lockedMinor).toBe(escrow!.amount.amountMinor);
    expect(await current.context.ledger.bookIsBalanced('PL-IN-INWARD')).toBe(true);
  });

  it('records a reconciliation mismatch instead of repairing it', async () => {
    harness = await createHarness();
    const current = harness;
    const { payment } = await quotedPayment(current);
    await call(current, 'POST', `/v1/payments/${payment.id}/fund`, {
      token: current.seed.polishCompany.token,
      idempotencyKey: 'state-fund-0003',
    });

    // Corrupt the durable projection so it disagrees with the settlement ledger.
    await current.context.store.update(escrowBindings, { paymentId: payment.id }, { state: 'REFUNDED' });

    const reconciled = await call(current, 'POST', `/v1/payments/${payment.id}/reconcile`, {
      token: current.seed.providerOperator.token,
      idempotencyKey: 'state-reconcile-0001',
    });
    expect(reconciled.status).toBe(200);
    expect(reconciled.body.status).toBe('MISMATCHED');
    expect(reconciled.body.expected.escrowState).toBe('REFUNDED');
    expect(reconciled.body.observed.escrowState).toBe('FUNDED');

    const stored = await current.context.store.findOne(paymentInstructions, { id: payment.id });
    expect(stored?.state).toBe('FAILED_RECONCILIATION');
  });

  it('refuses an expired quote before any fiat post or escrow signing', async () => {
    harness = await createHarness();
    const current = harness;
    const { contract, payment } = await quotedPayment(current);
    current.clock.advance(1_000_000);

    const funded = await call(current, 'POST', `/v1/payments/${payment.id}/fund`, {
      token: current.seed.polishCompany.token,
      idempotencyKey: 'state-fund-expired',
    });
    expect(funded.status).toBe(422);
    expect(funded.body.error.message).toMatch(/FX quote .* expired/u);
    expect(await current.context.escrow.get(contract.id)).toBeNull();
    expect(await current.context.store.findMany(providerCommands, { paymentId: payment.id })).toHaveLength(0);
  });

  it('refuses a tampered persisted quote before any escrow signing', async () => {
    harness = await createHarness();
    const current = harness;
    const { contract, payment } = await quotedPayment(current);
    const stored = await current.context.store.findOne(fxQuotes, { id: payment.quoteId });
    const quote = stored!.quote as Record<string, any>;
    await current.context.store.update(fxQuotes, { id: payment.quoteId }, {
      quote: {
        ...quote,
        settlementAmount: { ...quote['settlementAmount'], amountMinor: '1' },
      },
    });

    const funded = await call(current, 'POST', `/v1/payments/${payment.id}/fund`, {
      token: current.seed.polishCompany.token,
      idempotencyKey: 'state-fund-tampered-quote',
    });
    expect(funded.status).toBe(422);
    expect(funded.body.error.message).toMatch(/canonical commitment/u);
    expect(await current.context.escrow.get(contract.id)).toBeNull();
    expect(await current.context.store.findMany(providerCommands, { paymentId: payment.id })).toHaveLength(0);
  });

  it('never creates an escrow for a non-passed compliance decision', async () => {
    harness = await createHarness();
    const current = harness;
    const { contract, result } = await quotedPayment(current, 'NOT_REVIEWED_FOR_CORRIDOR');
    expect(result.error.message).toMatch(/regulatory plan cannot authorize/u);
    expect(result.error.detail.gate).toBe('MANUAL_REVIEW_REQUIRED');
    expect(await current.context.escrow.get(contract.id)).toBeNull();
    expect(await current.context.store.findMany(providerCommands, {})).toHaveLength(0);
  });

  it('persists live reference provenance and locks the exact quoted USDC amount', async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      const to = url.searchParams.get('to');
      const response = new Response(JSON.stringify({
        date: '2026-09-03', rates: { [String(to)]: to === 'USD' ? 0.25 : 83.4 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
      Object.defineProperty(response, 'url', { value: url.toString() });
      return response;
    });
    vi.stubGlobal('fetch', fetchMock);
    harness = await createHarness({ FX_MODE: 'frankfurter' });
    const current = harness;
    const { payment, result } = await quotedPayment(current);
    expect(result.quote).toMatchObject({
      provider: 'FRANKFURTER_ECB_REFERENCE',
      rateSource: 'FRANKFURTER_ECB_2026-09-03',
      rateObservedAt: '2026-09-03T00:00:00.000Z',
    });

    const funded = await call(current, 'POST', `/v1/payments/${payment.id}/fund`, {
      token: current.seed.polishCompany.token,
      idempotencyKey: 'state-fund-live-reference',
    });
    expect(funded.status).toBe(200);
    const binding = await current.context.store.findOne(escrowBindings, { paymentId: payment.id });
    expect(binding?.amountUsdcMinor).toBe(result.quote.settlementAmount.amountMinor);
    expect(funded.body.quote.canonicalHash).toBe(result.quote.canonicalHash);
  });
});
