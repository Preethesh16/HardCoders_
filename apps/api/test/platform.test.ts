/**
 * Credentials, idempotency, escrow lifecycle, authorization and privacy.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { call, createHarness, type Harness } from './harness.js';
import { createDemoIssuer, signCredential, subjectCommitment, verify } from '../src/identity/credentials.js';
import {
  SimulatedEscrowExecutor,
  escrowBindingCommitment,
  releaseBindingCommitment,
  type EscrowBindingInput,
  type ReleaseBinding,
} from '../src/algorand/executor-client.js';
import { FixtureAiAdapter, assertNoPersonalFacts } from '../src/ai/adapter.js';
import { deterministicAddress, providersForBook } from '../src/payments/providers.js';
import { fingerprintOf } from '../src/idempotency/store.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const NOW = new Date('2026-09-03T09:00:00.000Z');

function demoCredential(overrides: Partial<Parameters<typeof signCredential>[0]> = {}) {
  const issuer = createDemoIssuer();
  const claims = {
    id: 'VC-UNIT-001',
    issuerDid: issuer.issuerDid,
    subjectDid: 'did:key:zUnitSubject',
    subjectCommitment: subjectCommitment('ORG-UNIT-001', 'optiwork-unit-test-salt-0001'),
    subjectType: 'COMPANY' as const,
    country: 'PL',
    assuranceLevel: 'ENHANCED' as const,
    issuedAt: '2026-08-01T00:00:00.000Z',
    expiresAt: '2027-08-01T00:00:00.000Z',
    status: 'ACTIVE' as const,
    ...overrides,
  };
  return { issuer, credential: signCredential(claims, issuer.privateKeyPem) };
}

describe('did:key credentials', () => {
  it('verifies issuer, audience, subject, country, expiry and status together', () => {
    const { issuer, credential } = demoCredential();
    const result = verify({
      credential,
      issuerPublicKeyPem: issuer.publicKeyPem,
      currentStatus: 'ACTIVE',
      expectedAudienceDid: issuer.issuerDid,
      expectedCountry: 'PL',
      expectedSubjectType: 'COMPANY',
      expectedSubjectDid: credential.subjectDid,
      at: NOW,
    });
    expect(result.valid).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.checks['signatureValid']).toBe(true);
  });

  it('fails a tampered claim, a wrong issuer key, an expired credential and a revoked one', () => {
    const { issuer, credential } = demoCredential();
    const other = createDemoIssuer();

    const tampered = verify({
      credential: { ...credential, country: 'DE' },
      issuerPublicKeyPem: issuer.publicKeyPem,
      currentStatus: 'ACTIVE',
      at: NOW,
    });
    expect(tampered.checks['signatureValid']).toBe(false);

    const wrongKey = verify({
      credential,
      issuerPublicKeyPem: other.publicKeyPem,
      currentStatus: 'ACTIVE',
      at: NOW,
    });
    expect(wrongKey.checks['signatureValid']).toBe(false);

    const expired = demoCredential({ expiresAt: '2026-09-02T00:00:00.000Z' });
    const expiredResult = verify({
      credential: expired.credential,
      issuerPublicKeyPem: expired.issuer.publicKeyPem,
      currentStatus: 'ACTIVE',
      at: NOW,
    });
    expect(expiredResult.valid).toBe(false);
    expect(expiredResult.failures).toContain('notExpired');
    // A signature stays cryptographically valid even after the credential lapses.
    expect(expiredResult.checks['signatureValid']).toBe(true);

    const revoked = verify({
      credential,
      issuerPublicKeyPem: issuer.publicKeyPem,
      currentStatus: 'REVOKED',
      at: NOW,
    });
    expect(revoked.valid).toBe(false);
    expect(revoked.failures).toContain('statusActive');
  });

  it('honours a revocation recorded after issuance, through the API', async () => {
    harness = await createHarness();
    const current = harness;
    const { polishCompany, platformAdmin } = current.seed;

    const first = await call(current, 'POST', '/v1/credentials/verify', {
      token: polishCompany.token,
      idempotencyKey: 'verify-credential-0001',
      body: { credentialId: polishCompany.credentialId, expectedCountry: 'PL' },
    });
    expect(first.status).toBe(200);
    expect(first.body.result.valid).toBe(true);

    await current.context.store.insert(
      (await import('../src/db/schema.js')).credentialStatus,
      {
        id: 'CS-REVOKE-TEST',
        credentialId: polishCompany.credentialId,
        status: 'REVOKED',
        reason: 'Test revocation.',
        recordedAt: current.clock.now().toISOString(),
      },
    );

    const second = await call(current, 'POST', '/v1/credentials/verify', {
      token: platformAdmin.token,
      idempotencyKey: 'verify-credential-0002',
      body: { credentialId: polishCompany.credentialId },
    });
    expect(second.body.result.valid).toBe(false);
    expect(second.body.status).toBe('REVOKED');
  });
});

describe('idempotency', () => {
  it('replays the exact response for the same key and fingerprint', async () => {
    harness = await createHarness();
    const current = harness;
    const body = {
      title: 'Idempotency probe',
      description: 'A posting used to prove that a repeated command executes exactly once.',
      skills: ['typescript'],
      payerCountry: 'PL',
      fundingCurrency: 'PLN',
      destinationCountry: 'IN',
      budget: { amountMinor: '100000', currency: 'PLN', scale: 2 },
    };
    const first = await call(current, 'POST', '/v1/jobs', {
      token: current.seed.polishCompany.token,
      idempotencyKey: 'idem-job-0001',
      body,
    });
    const second = await call(current, 'POST', '/v1/jobs', {
      token: current.seed.polishCompany.token,
      idempotencyKey: 'idem-job-0001',
      body,
    });
    expect(first.status).toBe(201);
    expect(first.replay).toBe('false');
    expect(second.status).toBe(201);
    expect(second.replay).toBe('true');
    expect(second.body).toEqual(first.body);

    const jobs = await call(current, 'GET', '/v1/jobs', { token: current.seed.polishCompany.token });
    expect(jobs.body.jobs.filter((job: { title: string }) => job.title === 'Idempotency probe')).toHaveLength(1);
  });

  it('conflicts when the same key carries a different request', async () => {
    harness = await createHarness();
    const current = harness;
    const body = {
      title: 'Conflict probe',
      description: 'A posting used to prove that a reused key with different content is refused.',
      skills: ['typescript'],
      payerCountry: 'PL',
      fundingCurrency: 'PLN',
      destinationCountry: 'IN',
      budget: { amountMinor: '100000', currency: 'PLN', scale: 2 },
    };
    await call(current, 'POST', '/v1/jobs', {
      token: current.seed.polishCompany.token,
      idempotencyKey: 'idem-job-0002',
      body,
    });
    const conflicting = await call(current, 'POST', '/v1/jobs', {
      token: current.seed.polishCompany.token,
      idempotencyKey: 'idem-job-0002',
      body: { ...body, budget: { amountMinor: '200000', currency: 'PLN', scale: 2 } },
    });
    expect(conflicting.status).toBe(409);
    expect(conflicting.body.error.message).toMatch(/already used for a different/u);
  });

  it('requires an Idempotency-Key on every mutation', async () => {
    harness = await createHarness();
    const response = await call(harness, 'POST', '/v1/corridors/resolve', {
      token: harness.seed.polishCompany.token,
      body: { originCountry: 'PL', destinationCountry: 'IN' },
    });
    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/Idempotency-Key/u);
  });

  it('scopes a key to its subject so one tenant cannot replay another tenant', () => {
    const request = { method: 'POST', path: '/v1/jobs', body: { a: 1 }, subject: 'USER-A' };
    expect(fingerprintOf(request)).not.toBe(fingerprintOf({ ...request, subject: 'USER-B' }));
    expect(fingerprintOf(request)).toBe(fingerprintOf({ ...request }));
  });
});

describe('authorization', () => {
  it('rejects a missing or malformed bearer token', async () => {
    harness = await createHarness();
    const anonymous = await harness.app.inject({ method: 'GET', url: '/v1/jobs' });
    expect(anonymous.statusCode).toBe(401);
    const malformed = await call(harness, 'GET', '/v1/jobs', { token: 'not-a-principal' });
    expect(malformed.status).toBe(401);
  });

  it('enforces role and ownership on every mutation', async () => {
    harness = await createHarness();
    const current = harness;
    const { polishCompany, indianFreelancer, indianCompany } = current.seed;

    // A freelancer may not post work.
    const posted = await call(current, 'POST', '/v1/jobs', {
      token: indianFreelancer.token,
      idempotencyKey: 'authz-job-0001',
      body: {
        title: 'Unauthorized posting',
        description: 'A freelancer must not be able to post work on behalf of a company.',
        skills: ['typescript'],
        payerCountry: 'IN',
        fundingCurrency: 'PLN',
        destinationCountry: 'IN',
        budget: { amountMinor: '100000', currency: 'PLN', scale: 2 },
      },
    });
    expect(posted.status).toBe(403);

    const job = await call(current, 'POST', '/v1/jobs', {
      token: polishCompany.token,
      idempotencyKey: 'authz-job-0002',
      body: {
        title: 'Ownership probe',
        description: 'A posting used to prove another tenant cannot read or act on it.',
        skills: ['typescript'],
        payerCountry: 'PL',
        fundingCurrency: 'PLN',
        destinationCountry: 'IN',
        budget: { amountMinor: '100000', currency: 'PLN', scale: 2 },
      },
    });
    // Another company cannot read this company's applicant list.
    const foreign = await call(current, 'GET', `/v1/jobs/${job.body.id}/applications`, {
      token: indianCompany.token,
    });
    expect(foreign.status).toBe(403);
  });

  it('lets the audit role read across tenants but never write', async () => {
    harness = await createHarness();
    const current = harness;
    const job = await call(current, 'POST', '/v1/jobs', {
      token: current.seed.polishCompany.token,
      idempotencyKey: 'authz-job-0003',
      body: {
        title: 'Audit probe',
        description: 'A posting used to prove the audit role reads across tenants without writing.',
        skills: ['typescript'],
        payerCountry: 'PL',
        fundingCurrency: 'PLN',
        destinationCountry: 'IN',
        budget: { amountMinor: '100000', currency: 'PLN', scale: 2 },
      },
    });
    const read = await call(current, 'GET', `/v1/jobs/${job.body.id}/applications`, {
      token: current.seed.platformAdmin.token,
    });
    expect(read.status).toBe(200);

    const write = await call(current, 'POST', `/v1/jobs/${job.body.id}/applications`, {
      token: current.seed.platformAdmin.token,
      idempotencyKey: 'authz-apply-0003',
      body: {
        residenceCountry: 'PL', payoutCountry: 'PL', payoutCurrency: 'PLN',
        coverLetter: 'An auditor must never be able to apply for work on a tenant behalf.',
      },
    });
    expect(write.status).toBe(403);
  });
});

describe('simulated escrow lifecycle', () => {
  const binding: EscrowBindingInput = {
    dealId: 'DEAL-UNIT-001',
    agreementHash: `sha256:${'a'.repeat(64)}`,
    originProviderAddress: deterministicAddress('PROVIDER-EU-ORIGIN'),
    destinationProviderAddress: deterministicAddress('PROVIDER-IN-INWARD'),
    assetId: 1,
    amount: { amountMinor: '2985000000', currency: 'USD', scale: 6 },
    network: 'localnet',
    genesisHash: 'localnet-demo-genesis-hash',
    applicationId: '1',
  };

  function releaseCommand(overrides: Partial<ReleaseBinding> = {}, key = 'REL-1', amountMinor = binding.amount.amountMinor) {
    const releaseBinding: ReleaseBinding = {
      escrowBindingHash: escrowBindingCommitment(binding),
      workEvidenceHash: `sha256:${'b'.repeat(64)}`,
      fabricTxHash: `sha256:${'c'.repeat(64)}`,
      complianceResultHash: `sha256:${'d'.repeat(64)}`,
      fxQuoteHash: `sha256:${'e'.repeat(64)}`,
      settlementRouteHash: `sha256:${'1'.repeat(64)}`,
      generation: 1,
      idempotencyKey: key,
      expiresAt: new Date(NOW.getTime() + 600_000).toISOString(),
      ...overrides,
    };
    return {
      evidenceId: 'EVID-UNIT-001',
      escrowBinding: binding,
      milestoneId: 'MS-UNIT-001',
      amountMinor,
      intentId: 'INTENT-UNIT-001',
      bindingHash: `sha256:${'f'.repeat(64)}`,
      fenceGeneration: releaseBinding.generation,
      leaseExpiresAt: releaseBinding.expiresAt,
      authorizationCommitment: releaseBindingCommitment(releaseBinding),
      fabricClaimTransactionId: 'FABRIC-UNIT-001',
      releaseBinding,
    };
  }

  it('walks create, fund, pause, resume, release and complete', async () => {
    const executor = new SimulatedEscrowExecutor(() => NOW);
    expect((await executor.create(binding, 'K-CREATE')).escrow.state).toBe('CREATED');
    expect((await executor.fund(binding.dealId, 'K-FUND')).escrow.lockedMinor).toBe(binding.amount.amountMinor);
    expect((await executor.pause(binding.dealId, 'K-PAUSE')).escrow.state).toBe('PAUSED');
    expect((await executor.resume(binding.dealId, 'K-RESUME')).escrow.state).toBe('FUNDED');
    const released = await executor.release(releaseCommand(), 'REL-1');
    expect(released.escrow.state).toBe('COMPLETED');
    expect(released.escrow.lockedMinor).toBe('0');
    expect(released.transactionId).toMatch(/^[A-Z2-7]{52}$/u);
    expect((await executor.complete(binding.dealId, 'K-COMPLETE')).escrow.state).toBe('COMPLETED');
  });

  it('supports a partial release and conserves the locked amount', async () => {
    const executor = new SimulatedEscrowExecutor(() => NOW);
    await executor.create(binding, 'P-CREATE');
    await executor.fund(binding.dealId, 'P-FUND');
    const partial = await executor.release(
      { ...releaseCommand({}, 'P-REL-1', '985000000'), milestoneId: 'MS-A' },
      'P-REL-1',
    );
    expect(partial.escrow.state).toBe('PARTIALLY_RELEASED');
    expect(partial.escrow.lockedMinor).toBe('2000000000');
    const rest = await executor.release(
      { ...releaseCommand({}, 'P-REL-2', '2000000000'), milestoneId: 'MS-B' },
      'P-REL-2',
    );
    expect(rest.escrow.state).toBe('COMPLETED');
    expect(BigInt(rest.escrow.releasedMinor)).toBe(BigInt(binding.amount.amountMinor));
  });

  it('refuses a second release of the same milestone', async () => {
    const executor = new SimulatedEscrowExecutor(() => NOW);
    await executor.create(binding, 'D-CREATE');
    await executor.fund(binding.dealId, 'D-FUND');
    await executor.release(releaseCommand({}, 'D-REL-1', '985000000'), 'D-REL-1');
    await expect(executor.release(releaseCommand({ generation: 2 }, 'D-REL-2', '100000000'), 'D-REL-2'))
      .rejects.toThrow(/already released/u);
  });

  it('refuses an expired authorization and a substituted commitment', async () => {
    const executor = new SimulatedEscrowExecutor(() => NOW);
    await executor.create(binding, 'E-CREATE');
    await executor.fund(binding.dealId, 'E-FUND');

    const expired = releaseCommand({ expiresAt: new Date(NOW.getTime() - 1_000).toISOString() }, 'E-REL-1');
    await expect(executor.release(expired, 'E-REL-1')).rejects.toThrow(/has expired/u);

    const substituted = releaseCommand({}, 'E-REL-2');
    await expect(executor.release(
      { ...substituted, authorizationCommitment: `sha256:${'9'.repeat(64)}` },
      'E-REL-2',
    )).rejects.toThrow(/canonical release-binding hash/u);

    const misbound = releaseCommand({}, 'E-REL-3');
    await expect(executor.release(misbound, 'E-REL-DIFFERENT'))
      .rejects.toThrow(/different idempotency key/u);
  });

  it('refunds locked funds and replays an identical command without a second effect', async () => {
    const executor = new SimulatedEscrowExecutor(() => NOW);
    await executor.create(binding, 'R-CREATE');
    await executor.fund(binding.dealId, 'R-FUND');
    const refunded = await executor.refund(binding.dealId, 'R-REFUND');
    expect(refunded.escrow.state).toBe('REFUNDED');
    expect(refunded.escrow.refundedMinor).toBe(binding.amount.amountMinor);
    const replay = await executor.refund(binding.dealId, 'R-REFUND');
    expect(replay.replay).toBe(true);
    expect(replay.transactionId).toBe(refunded.transactionId);
    await expect(executor.fund(binding.dealId, 'R-FUND-AGAIN')).rejects.toThrow(/created escrow/u);
  });

  it('derives distinct provider treasuries for the inward and outward books', () => {
    const inward = providersForBook('PL-IN-INWARD');
    const outward = providersForBook('IN-GB-OUTWARD');
    const polandToUk = providersForBook('PL-GB-OUTWARD');
    const addresses = [
      inward.origin.address, inward.destination.address,
      outward.origin.address, outward.destination.address,
    ];
    expect(new Set(addresses).size).toBe(4);
    for (const address of addresses) expect(address).toMatch(/^[A-Z2-7]{58}$/u);
    expect(polandToUk.origin.address).toBe(inward.origin.address);
    expect(polandToUk.destination.address).toBe(outward.destination.address);
    expect(providersForBook('GB-IN-INWARD').bookId).toBe('GB-IN-INWARD');
    expect(providersForBook('DE-PL-OUTWARD').bookId).toBe('DE-PL-OUTWARD');
    expect(() => providersForBook('PL-RU-OUTWARD')).toThrow(/No provider treasuries/u);
  });
});

describe('no personal data reaches a ledger, a trace or a log', () => {
  it('refuses to place an identifying fact in an AI request', async () => {
    const adapter = new FixtureAiAdapter();
    expect(() => assertNoPersonalFacts({
      purpose: 'APPLICATION_SCORING',
      instruction: 'score',
      facts: { fullName: 'A Person' },
    })).toThrow(/opaque values only/u);
    await expect(adapter.evaluate({
      purpose: 'APPLICATION_SCORING',
      instruction: 'score',
      facts: { walletAddress: 'ABC' },
    })).rejects.toThrow();

    const allowed = await adapter.evaluate({
      purpose: 'APPLICATION_SCORING',
      instruction: 'score',
      facts: { skillMatches: 3, priorContracts: 1 },
    });
    expect(allowed.advisoryOnly).toBe(true);
    expect(allowed.source).toBe('FIXTURE');
    expect(allowed.fixtureId).toBeDefined();
  });

  it('produces the same fixture result for the same facts', async () => {
    const adapter = new FixtureAiAdapter();
    const request = {
      purpose: 'WORK_VALIDATION' as const,
      instruction: 'assess',
      facts: { version: 1, fileHashPrefix: 'abcd1234' },
    };
    const first = await adapter.evaluate(request);
    const second = await adapter.evaluate(request);
    expect(first.score).toBe(second.score);
    expect(first.promptHash).toBe(second.promptHash);
  });

  it('keeps names, emails and storage keys out of the escrow and timeline payloads', async () => {
    harness = await createHarness();
    const current = harness;
    const { polishCompany, indianFreelancer } = current.seed;

    const job = await call(current, 'POST', '/v1/jobs', {
      token: polishCompany.token,
      idempotencyKey: 'pii-job-0001',
      body: {
        title: 'Privacy probe',
        description: 'A posting used to prove no personal identifier reaches a ledger payload.',
        skills: ['typescript'],
        payerCountry: 'PL',
        fundingCurrency: 'PLN',
        destinationCountry: 'IN',
        budget: { amountMinor: '1200000', currency: 'PLN', scale: 2 },
      },
    });
    const application = await call(current, 'POST', `/v1/jobs/${job.body.id}/applications`, {
      token: indianFreelancer.token,
      idempotencyKey: 'pii-application-0001',
      body: {
        residenceCountry: 'IN', payoutCountry: 'IN', payoutCurrency: 'INR',
        coverLetter: 'A cover letter that names nobody but demonstrates the workflow end to end.',
      },
    });
    const evaluated = await call(current, 'POST', `/v1/applications/${application.body.id}/evaluate`, {
      token: polishCompany.token,
      idempotencyKey: 'pii-evaluate-0001',
      body: { select: true, amount: { amountMinor: '1200000', currency: 'PLN', scale: 2 } },
    });
    const contract = evaluated.body.contract;

    // Everything Fabric would hold for this milestone is hashes and versions.
    await call(current, 'POST', `/v1/contracts/${contract.id}/approve`, {
      token: polishCompany.token,
      idempotencyKey: 'pii-approve-buyer',
      body: { party: 'BUYER', acceptedTermsHash: contract.contractHash },
    });
    await call(current, 'POST', `/v1/contracts/${contract.id}/approve`, {
      token: indianFreelancer.token,
      idempotencyKey: 'pii-approve-provider',
      body: { party: 'PROVIDER', acceptedTermsHash: contract.contractHash },
    });

    const timeline = await call(current, 'GET', `/v1/contracts/${contract.id}`, { token: polishCompany.token });
    const serialized = JSON.stringify(timeline.body.timeline);
    for (const forbidden of ['Meera Iyer', 'Nova Systemy', 'Warsaw engineering lead', '@']) {
      expect(serialized).not.toContain(forbidden);
    }

    // The timeline itself refuses to record a prohibited field.
    await expect(current.context.timeline.append({
      kind: 'JOB_POSTED',
      actor: { subject: 'USER-X', role: 'company_member' },
      detail: { email: 'someone@example.invalid' },
    })).rejects.toThrow(/must not include/u);
    await expect(current.context.timeline.append({
      kind: 'WORK_ACCESS_GRANTED',
      actor: { subject: 'USER-X', role: 'company_member' },
      detail: { objectKey: 'deliverable/ORG/OBJ-1' },
    })).rejects.toThrow(/must not include/u);
  });
});
