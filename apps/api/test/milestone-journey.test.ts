import { afterEach, describe, expect, it } from 'vitest';
import { base64, call, createHarness, type Harness } from './harness.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('milestone-scoped settlement', () => {
  it('creates distinct escrows and releases each only for its own approved evidence', async () => {
    harness = await createHarness();
    const current = harness;
    const buyer = current.seed.polishCompany;
    const freelancer = current.seed.indianFreelancer;
    const job = await call(current, 'POST', '/v1/jobs', {
      token: buyer.token,
      idempotencyKey: 'milestone-job',
      body: {
        title: 'Two-stage reconciliation engine',
        description: 'Design and implement a cross-border reconciliation engine with independently reviewable outputs.',
        skills: ['typescript', 'fabric', 'algorand'],
        acceptanceCriteria: ['Each stage passes its recorded acceptance checks.'],
        targetDeliveryDate: '2026-11-30',
        payerCountry: 'PL', fundingCurrency: 'PLN', destinationCountry: 'IN',
        budget: { amountMinor: '1200000', currency: 'PLN', scale: 2 },
        milestones: [
          {
            title: 'Architecture proof', description: 'Define interfaces and security boundaries.',
            deliverable: 'Architecture PDF', acceptanceCriteria: ['Threat boundaries are documented.'],
            amount: { amountMinor: '400000', currency: 'PLN', scale: 2 }, dueDate: '2026-10-31',
          },
          {
            title: 'Working implementation', description: 'Implement the approved interfaces and acceptance tests.',
            deliverable: 'Source archive and test report', acceptanceCriteria: ['All acceptance tests pass.'],
            amount: { amountMinor: '800000', currency: 'PLN', scale: 2 }, dueDate: '2026-11-30',
          },
        ],
      },
    });
    expect(job.status).toBe(201);
    expect(job.body.milestones).toHaveLength(2);

    const application = await call(current, 'POST', `/v1/jobs/${job.body.id}/applications`, {
      token: freelancer.token,
      idempotencyKey: 'milestone-application',
      body: {
        residenceCountry: 'IN', payoutCountry: 'IN', payoutCurrency: 'INR',
        coverLetter: 'I can deliver both independently verifiable stages.',
      },
    });
    const selected = await call(current, 'POST', `/v1/applications/${application.body.id}/select`, {
      token: buyer.token,
      idempotencyKey: 'milestone-select',
      body: { amount: { amountMinor: '900000', currency: 'PLN', scale: 2 } },
    });
    expect(selected.status).toBe(200);
    const contract = selected.body;
    const schedule = await call(current, 'GET', `/v1/contracts/${contract.id}/milestones`, { token: buyer.token });
    expect(schedule.body.milestones.map((item: { amountMinor: string }) => item.amountMinor)).toEqual(['300000', '600000']);

    await call(current, 'POST', `/v1/contracts/${contract.id}/approve`, {
      token: buyer.token, idempotencyKey: 'milestone-buyer-approve',
      body: { party: 'BUYER', acceptedTermsHash: contract.contractHash },
    });
    const providerApproval = await call(current, 'POST', `/v1/contracts/${contract.id}/approve`, {
      token: freelancer.token, idempotencyKey: 'milestone-provider-approve',
      body: { party: 'PROVIDER', acceptedTermsHash: contract.contractHash },
    });
    expect(providerApproval.body.contract.state).toBe('RULES_VERIFIED');

    const requiredDocuments = [
      'CESOP_REPORTING_ASSESSMENT', 'EU_PARTY_SCREENING', 'INDIA_MERCHANT_CDD', 'INVOICE',
      'PAYER_PAYEE_TRANSFER_DATA', 'PAYMENT_RECIPIENT_RECORD', 'PURPOSE_CODE_P0802',
      'RESTRICTED_TRADE_SCREENING', 'SERVICE_EXPORT_DECLARATION',
    ];
    for (const [index, code] of requiredDocuments.entries()) {
      await call(current, 'POST', `/v1/contracts/${contract.id}/documents`, {
        token: buyer.token, idempotencyKey: `milestone-document-${index}`,
        body: { code, contentType: 'application/pdf', contentBase64: base64(`${code} demo evidence`) },
      });
    }

    const payments = [];
    for (const milestone of schedule.body.milestones) {
      const created = await call(current, 'POST', '/v1/payments', {
        token: buyer.token, idempotencyKey: `milestone-payment-${milestone.ordinal}`,
        body: {
          contractId: contract.id, milestoneId: milestone.id,
          fundingAmount: { amountMinor: milestone.amountMinor, currency: milestone.amountCurrency, scale: milestone.amountScale },
        },
      });
      expect(created.status).toBe(201);
      expect(created.body.payment.milestoneId).toBe(milestone.id);
      const funded = await call(current, 'POST', `/v1/payments/${created.body.payment.id}/fund`, {
        token: buyer.token, idempotencyKey: `milestone-fund-${milestone.ordinal}`,
      });
      expect(funded.status, JSON.stringify(funded.body)).toBe(200);
      expect(funded.body.payment.state).toBe('WORK_PENDING');
      payments.push(created.body.payment);
    }
    expect(new Set(payments.map((payment) => payment.id)).size).toBe(2);

    const releaseBeforeOwnEvidence = await call(current, 'POST', `/v1/payments/${payments[1]!.id}/release`, {
      token: buyer.token, idempotencyKey: 'milestone-early-second-release',
    });
    expect(releaseBeforeOwnEvidence.status).toBe(409);

    for (const [index, milestone] of schedule.body.milestones.entries()) {
      const submission = await call(current, 'POST', `/v1/contracts/${contract.id}/submissions`, {
        token: freelancer.token, idempotencyKey: `milestone-submission-${milestone.ordinal}`,
        body: {
          milestoneId: milestone.id,
          fileName: `milestone-${milestone.ordinal}.zip`, contentType: 'application/zip',
          contentBase64: base64(`milestone ${milestone.ordinal} deliverable bytes`),
          note: `Delivery for milestone ${milestone.ordinal}.`,
        },
      });
      expect(submission.status).toBe(201);
      expect(submission.body.submission.milestoneId).toBe(milestone.id);
      await call(current, 'POST', `/v1/submissions/${submission.body.submission.id}/approve`, {
        token: buyer.token, idempotencyKey: `milestone-decision-${milestone.ordinal}`,
        body: { decision: 'APPROVED', comment: 'Accepted against this milestone only.' },
      });
      const released = await call(current, 'POST', `/v1/payments/${payments[index]!.id}/release`, {
        token: buyer.token, idempotencyKey: `milestone-release-${milestone.ordinal}`,
      });
      expect(released.status).toBe(200);
      expect(released.body.payment.state).toBe('COMPLETED');

      const timeline = await call(current, 'GET', `/v1/payments/${payments[index]!.id}/timeline`, { token: buyer.token });
      expect(timeline.body.milestone.id).toBe(milestone.id);
      if (index > 0) expect(timeline.body.binding.dealId).toContain(milestone.id);
      if (index === 0) expect(timeline.body.milestones.some((item: { state: string }) => item.state !== 'COMPLETED')).toBe(true);
      else expect(timeline.body.milestones.every((item: { state: string }) => item.state === 'COMPLETED')).toBe(true);
    }

    const firstTimeline = await call(current, 'GET', `/v1/payments/${payments[0]!.id}/timeline`, { token: buyer.token });
    const secondTimeline = await call(current, 'GET', `/v1/payments/${payments[1]!.id}/timeline`, { token: buyer.token });
    expect(firstTimeline.body.binding.dealId).not.toBe(secondTimeline.body.binding.dealId);
    expect(firstTimeline.body.submissions).toHaveLength(2);
  });
});
