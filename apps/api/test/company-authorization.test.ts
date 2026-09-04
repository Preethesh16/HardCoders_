import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { call, createHarness, type Harness } from './harness.js';

const sample = {
  legalName: 'WISE PAYMENTS LIMITED',
  country: 'GB',
  registryAuthority: 'COMPANIES_HOUSE',
  registrationNumber: '07209813',
  lei: '213800U4GNTXRFYZKG18',
  taxIdentifier: 'DEMO-PRIVATE-TAX-REF',
  registeredAddress: '1st Floor, Worship Square, 65 Clifton Street, London, England, EC2A 4JE',
  directors: ['Jane Fahey'],
  beneficialOwners: [{
    name: 'Wise Financial Holdings Ltd',
    controlType: 'PERSON_WITH_SIGNIFICANT_CONTROL',
  }],
  representativeEmail: 'demo@anchor.dev',
  representativeRole: 'Anchor demo contracting representative',
  authorityBasis: 'Tenant administrator approved this representative for the local demonstration.',
  mandateReference: 'ANCHOR-DEMO-MANDATE-GB-001',
};

describe('company onboarding authorization agent', () => {
  let harness: Harness;

  beforeEach(async () => { harness = await createHarness(); });
  afterEach(async () => { await harness.close(); });

  it('separates live/public entity evidence from tenant representative authority', async () => {
    const result = await call(harness, 'POST', '/v1/company/authorization/evaluate', {
      token: harness.seed.ukCompany.token,
      idempotencyKey: 'company-auth-1',
      body: sample,
    });
    expect(result.status).toBe(201);
    expect(result.body.profile).toMatchObject({
      legalName: 'WISE PAYMENTS LIMITED',
      country: 'GB',
      registrationNumber: '07209813',
      entityStatus: 'ACTIVE',
      verificationOutcome: 'VERIFIED',
    });
    expect(result.body.decision).toMatchObject({
      outcome: 'AUTHORIZED',
      representativeEmail: 'demo@anchor.dev',
    });
    expect(result.body.decision.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'REGISTRY_IDENTITY', status: 'PASSED' }),
      expect.objectContaining({ code: 'REPRESENTATIVE_MANDATE', status: 'PASSED' }),
      expect.objectContaining({ code: 'SANCTIONS_SCREENING', status: 'PASSED' }),
    ]));
    expect(result.body.decision.citations.length).toBeGreaterThanOrEqual(5);
  });

  it('denies a registry identity mismatch instead of letting the agent infer approval', async () => {
    const result = await call(harness, 'POST', '/v1/company/authorization/evaluate', {
      token: harness.seed.ukCompany.token,
      idempotencyKey: 'company-auth-mismatch',
      body: { ...sample, legalName: 'A DIFFERENT COMPANY LIMITED' },
    });
    expect(result.status).toBe(201);
    expect(result.body.profile.verificationOutcome).toBe('BLOCKED');
    expect(result.body.decision.outcome).toBe('DENIED');
  });

  it('denies a caller-supplied mandate that was never enrolled for the tenant subject', async () => {
    const result = await call(harness, 'POST', '/v1/company/authorization/evaluate', {
      token: harness.seed.ukCompany.token,
      idempotencyKey: 'company-auth-fake-mandate',
      body: { ...sample, mandateReference: 'CALLER-INVENTED-MANDATE' },
    });
    expect(result.status).toBe(201);
    expect(result.body.decision.outcome).toBe('DENIED');
    expect(result.body.decision.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'REPRESENTATIVE_MANDATE', status: 'FAILED' }),
    ]));
  });

  it('does not accept freelancer credentials as company authority', async () => {
    const result = await call(harness, 'POST', '/v1/company/authorization/evaluate', {
      token: harness.seed.ukFreelancer.token,
      idempotencyKey: 'company-auth-wrong-role',
      body: sample,
    });
    expect(result.status).toBe(403);
  });
});
