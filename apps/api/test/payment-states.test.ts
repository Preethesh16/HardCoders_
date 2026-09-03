/**
 * Payment state transitions.
 *
 * The saga may only advance along the transitions the shared domain state
 * machine allows, and reconciliation records a disagreement rather than
 * silently repairing it.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { base64, call, createHarness, type Harness } from './harness.js';
import { canTransitionPayment } from '@optiwork/domain';
import { escrowBindings, paymentInstructions } from '../src/db/schema.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function quotedPayment(current: Harness) {
  const { polishCompany, indianFreelancer } = current.seed;
  const job = await call(current, 'POST', '/v1/jobs', {
    token: polishCompany.token,
    idempotencyKey: 'state-job-0001',
    body: {
      title: 'State machine probe',
      description: 'A posting used to walk the payment state machine through its legal transitions.',
      skills: ['typescript'],
      destinationCountry: 'IN',
      budget: { amountMinor: '1200000', currency: 'PLN', scale: 2 },
    },
  });
  const application = await call(current, 'POST', `/v1/jobs/${job.body.id}/applications`, {
    token: indianFreelancer.token,
    idempotencyKey: 'state-application-0001',
    body: { coverLetter: 'An application used to walk the payment state machine end to end.' },
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
  for (const [index, code] of ['INVOICE', 'SERVICE_EXPORT_DECLARATION'].entries()) {
    await call(current, 'POST', `/v1/contracts/${contract.id}/documents`, {
      token: polishCompany.token,
      idempotencyKey: `state-document-${index}`,
      body: { code, contentType: 'application/pdf', contentBase64: base64(code) },
    });
  }
  const payment = await call(current, 'POST', '/v1/payments', {
    token: polishCompany.token,
    idempotencyKey: 'state-payment-0001',
    body: { contractId: contract.id, fundingAmount: { amountMinor: '1200000', currency: 'PLN', scale: 2 } },
  });
  return { contract, payment: payment.body.payment };
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
});
