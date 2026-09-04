import { describe, expect, it } from 'vitest';
import type { VerifiableCredential } from '@optiwork/contracts';
import {
  DoubleEntryLedger,
  assertPaymentTransition,
  assertQuoteCurrent,
  canonicalHash,
  createDemoIssuer,
  createFxQuote,
  createWorkEvidence,
  corridorPolicies,
  decideWorkEvidence,
  findCorridorPolicy,
  MATRIX_COUNTRIES,
  MATRIX_CURRENCIES,
  resolveCorridor,
  signCredential,
  subjectCommitment,
  verifyCredential,
} from '../src/index.js';

const now = new Date('2026-09-03T10:00:00.000Z');

function credential(
  id: string,
  country: string,
  subjectType: VerifiableCredential['subjectType'],
  assuranceLevel: VerifiableCredential['assuranceLevel'] = 'BASIC',
): { value: VerifiableCredential; publicKeyPem: string } {
  const issuer = createDemoIssuer();
  const value = signCredential({
    id,
    issuerDid: issuer.issuerDid,
    subjectDid: `did:key:z${id}`,
    subjectCommitment: subjectCommitment(id, 'test-salt-contains-more-than-sixteen'),
    subjectType,
    country,
    assuranceLevel,
    issuedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2027-01-01T00:00:00.000Z',
    status: 'ACTIVE',
  }, issuer.privateKeyPem);
  return { value, publicKeyPem: issuer.publicKeyPem };
}

describe('cross-border domain', () => {
  it('contains every directed non-self pair in the six-country matrix exactly once', () => {
    expect(corridorPolicies).toHaveLength(30);
    const pairs = new Set(corridorPolicies.map((policy) => `${policy.originCountry}-${policy.destinationCountry}`));
    expect(pairs.size).toBe(30);
    expect(corridorPolicies
      .filter((policy) => policy.status === 'ACTIVE')
      .every((policy) => policy.purposeCodes.length > 0)).toBe(true);
    for (const origin of MATRIX_COUNTRIES) {
      for (const destination of MATRIX_COUNTRIES) {
        if (origin === destination) continue;
        const policy = findCorridorPolicy(origin, destination);
        expect(policy.fundingCurrency).toBe(MATRIX_CURRENCIES[origin]);
        expect(policy.payoutCurrency).toBe(MATRIX_CURRENCIES[destination]);
        expect(policy.direction).toBe(destination === 'IN' ? 'INWARD' : 'OUTWARD');
      }
    }
  });

  it('resolves ordered corridors and applies the explicit sanctions status matrix', () => {
    expect(resolveCorridor('PL', 'IN').direction).toBe('INWARD');
    expect(resolveCorridor('GB', 'IN')).toMatchObject({
      direction: 'INWARD', status: 'ACTIVE', fundingCurrency: 'GBP', payoutCurrency: 'INR',
    });
    expect(resolveCorridor('IN', 'GB').direction).toBe('OUTWARD');
    expect(resolveCorridor('PL', 'GB')).toMatchObject({
      direction: 'OUTWARD', status: 'ACTIVE', fundingCurrency: 'PLN', payoutCurrency: 'GBP',
    });
    expect(resolveCorridor('PL', 'RU').status).toBe('MANUAL_REVIEW');
    expect(() => resolveCorridor('PL', 'KP')).toThrow(/blocked/iu);
    expect(resolveCorridor('IN', 'PL').status).toBe('ACTIVE');
    for (const country of MATRIX_COUNTRIES.filter((country) => country !== 'KP')) {
      expect(findCorridorPolicy(country, 'KP').status).toBe('BLOCKED');
      expect(findCorridorPolicy('KP', country).status).toBe('BLOCKED');
    }
    for (const country of MATRIX_COUNTRIES.filter((country) => country !== 'RU' && country !== 'KP')) {
      expect(findCorridorPolicy(country, 'RU').status).toBe('MANUAL_REVIEW');
      expect(findCorridorPolicy('RU', country).status).toBe('MANUAL_REVIEW');
    }
    expect(() => resolveCorridor('US', 'IN')).toThrow(/not configured/iu);
  });

  it('builds a deterministic two-leg PLN/USD/INR quote without floating point', () => {
    const quote = createFxQuote('quote-001', resolveCorridor('PL', 'IN'), {
      amountMinor: '800000', currency: 'PLN', scale: 2,
    }, now);
    expect(quote.grossSettlementAmount).toEqual({ amountMinor: '2000000000', currency: 'USD', scale: 6 });
    expect(quote.settlementAmount.amountMinor).toBe('1990000000');
    expect(quote.payoutAmount.currency).toBe('INR');
    expect(quote.canonicalHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(() => assertQuoteCurrent(quote, new Date('2026-09-03T10:01:00.000Z'))).toThrow(/expired/iu);
  });

  it('verifies Ed25519 credentials and detects tampering', () => {
    const signed = credential('company-pl', 'PL', 'COMPANY');
    expect(signed.value.issuerDid).toMatch(/^did:key:z6Mk/u);
    expect(verifyCredential(signed.value, signed.publicKeyPem, now)).toBe(true);
    expect(verifyCredential({ ...signed.value, country: 'DE' }, signed.publicKeyPem, now)).toBe(false);
    expect(verifyCredential(signed.value, createDemoIssuer().publicKeyPem, now)).toBe(false);
  });

  it('prevents inward/outward journal netting and conflicting replay', () => {
    const ledger = new DoubleEntryLedger();
    ledger.addAccount({ id: 'inward-provider', direction: 'INWARD', currency: 'INR', scale: 2 });
    ledger.addAccount({ id: 'inward-freelancer', direction: 'INWARD', currency: 'INR', scale: 2 });
    ledger.addAccount({ id: 'outward-provider', direction: 'OUTWARD', currency: 'INR', scale: 2 });
    const entry = ledger.post({
      id: 'journal-001', direction: 'INWARD', currency: 'INR', scale: 2,
      reference: 'payment-001', postedAt: now.toISOString(),
      lines: [
        { accountId: 'inward-provider', side: 'DEBIT', amountMinor: '10000' },
        { accountId: 'inward-freelancer', side: 'CREDIT', amountMinor: '10000' },
      ],
    });
    expect(ledger.post({ ...entry, hash: undefined } as never).hash).toBe(entry.hash);
    expect(() => ledger.post({
      id: 'journal-002', direction: 'INWARD', currency: 'INR', scale: 2,
      reference: 'illegal-net', postedAt: now.toISOString(),
      lines: [
        { accountId: 'outward-provider', side: 'DEBIT', amountMinor: '10000' },
        { accountId: 'inward-freelancer', side: 'CREDIT', amountMinor: '10000' },
      ],
    })).toThrow(/cannot be netted/iu);
  });

  it('binds a buyer decision to one exact work version', () => {
    const evidence = createWorkEvidence({
      evidenceId: 'evidence-001',
      contractHash: canonicalHash({ contract: 'contract-001' }),
      milestoneHash: canonicalHash({ milestone: 'milestone-001' }),
      fileHash: canonicalHash({ bytes: 'release.zip' }),
      sellerIdentityRef: 'seller-ref-001',
      version: 1,
      submittedAt: now.toISOString(),
    });
    const approved = decideWorkEvidence(evidence, 'APPROVED', 'buyer-ref-001', now);
    expect(approved.buyerDecisionHash).toMatch(/^sha256:/u);
    expect(() => decideWorkEvidence(approved, 'REVISION_REQUIRED', 'buyer-ref-001', now)).toThrow(/already/iu);
  });

  it('enforces the payment saga', () => {
    expect(() => assertPaymentTransition('DRAFT', 'COMPLETED')).toThrow(/invalid/iu);
    expect(() => assertPaymentTransition('DRAFT', 'COMPLIANCE_PENDING')).not.toThrow();
  });
});
