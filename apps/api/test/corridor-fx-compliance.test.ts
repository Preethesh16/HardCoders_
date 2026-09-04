/**
 * Corridor ordering, quote expiry and the versioned compliance rules.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { bookIdFor, inspect, listCorridors, resolve } from '../src/corridor/service.js';
import { assertQuoteCurrent, buildQuote, quoteIsCurrent } from '../src/fx/quote.js';
import { FixtureRateSource, FrankfurterRateSource } from '../src/fx/rates.js';
import { assertComplianceDecision, evaluate, type CredentialSnapshot } from '../src/compliance/engine.js';
import { RULES_VERSION, thresholdRulesFor } from '../src/compliance/rules.js';
import { money, parseMajor } from '../src/money.js';
import { EXECUTABLE_CORRIDOR_BOOKS } from '../src/payments/providers.js';

const NOW = new Date('2026-09-03T09:00:00.000Z');

afterEach(() => vi.unstubAllGlobals());

function credential(overrides: Partial<CredentialSnapshot> = {}): CredentialSnapshot {
  return {
    id: 'VC-TEST',
    country: 'PL',
    assuranceLevel: 'ENHANCED',
    status: 'ACTIVE',
    expiresAt: '2027-01-01T00:00:00.000Z',
    signatureValid: true,
    ...overrides,
  };
}

describe('corridor resolution', () => {
  it('treats a corridor as an ordered pair with its own direction and book', () => {
    const inward = resolve('PL', 'IN');
    expect(inward.policy.direction).toBe('INWARD');
    expect(inward.bookId).toBe('PL-IN-INWARD');
    expect(inward.policy.fundingCurrency).toBe('PLN');
    expect(inward.policy.payoutCurrency).toBe('INR');

    const outward = resolve('IN', 'GB');
    expect(outward.policy.direction).toBe('OUTWARD');
    expect(outward.bookId).toBe('IN-GB-OUTWARD');
    expect(outward.policy.fundingCurrency).toBe('INR');
    expect(outward.policy.payoutCurrency).toBe('GBP');

    // The reversed pair is a different executable corridor with its own book.
    expect(resolve('IN', 'PL')).toMatchObject({
      bookId: 'IN-PL-OUTWARD', policy: { status: 'ACTIVE', fundingCurrency: 'INR', payoutCurrency: 'PLN' },
    });
    const ukToIndia = resolve('GB', 'IN');
    expect(ukToIndia.bookId).toBe('GB-IN-INWARD');
    expect(ukToIndia.policy).toMatchObject({
      direction: 'INWARD', status: 'ACTIVE', fundingCurrency: 'GBP', payoutCurrency: 'INR',
    });
  });

  it('refuses a blocked corridor, an identical pair and a malformed code', () => {
    expect(resolve('PL', 'RU').policy.status).toBe('MANUAL_REVIEW');
    expect(() => resolve('PL', 'KP')).toThrow(/blocked by policy/u);
    expect(() => resolve('PL', 'PL')).toThrow(/two different countries/u);
    expect(() => resolve('pl', 'IN')).toThrow(/alpha-2 uppercase/u);
  });

  it('derives a distinct book for every configured corridor', () => {
    const books = listCorridors().map(bookIdFor);
    expect(books).toHaveLength(30);
    expect(new Set(books).size).toBe(books.length);
    expect(books).toContain('PL-IN-INWARD');
    expect(books).toContain('GB-IN-INWARD');
    expect(books).toContain('IN-GB-OUTWARD');
  });

  it('marks ACTIVE exactly when the Algorand provider rail is executable', () => {
    const activeBooks = listCorridors()
      .filter((policy) => policy.status === 'ACTIVE')
      .map(bookIdFor)
      .sort();
    expect(activeBooks).toEqual([...EXECUTABLE_CORRIDOR_BOOKS].sort());
  });

  it('inspects all 30 explicit policies while refusing unknown countries', () => {
    const countries = ['PL', 'IN', 'GB', 'DE', 'RU', 'KP'];
    const currencies: Record<string, string> = {
      PL: 'PLN', IN: 'INR', GB: 'GBP', DE: 'EUR', RU: 'RUB', KP: 'KPW',
    };
    for (const origin of countries) {
      for (const destination of countries) {
        if (origin === destination) continue;
        const corridor = inspect(origin, destination);
        expect(corridor.policy).toMatchObject({
          originCountry: origin,
          destinationCountry: destination,
          fundingCurrency: currencies[origin],
          payoutCurrency: currencies[destination],
        });
        if (origin === 'KP' || destination === 'KP') expect(corridor.policy.status).toBe('BLOCKED');
        else if (origin === 'RU' || destination === 'RU') expect(corridor.policy.status).toBe('MANUAL_REVIEW');
      }
    }
    expect(() => inspect('US', 'IN')).toThrow(/not configured/u);
  });
});

describe('FX quotes', () => {
  it('records both legs, fees, source, observation time and an explicit expiry', async () => {
    const policy = resolve('PL', 'IN').policy;
    const rates = await new FixtureRateSource().rates(policy, NOW);
    const quote = buildQuote({
      id: 'FXQ-1',
      policy,
      fundingAmount: parseMajor('12000.00', 'PLN', 2),
      rates,
      quotedAt: NOW,
      ttlSeconds: 900,
    });
    expect(quote.legs.map((leg) => leg.pair)).toEqual(['PLN/USD', 'USD/INR']);
    expect(quote.settlementAmount.currency).toBe('USD');
    expect(quote.settlementAmount.scale).toBe(6);
    expect(quote.payoutAmount.currency).toBe('INR');
    expect(quote.executable).toBe(false);
    expect(quote.rateSource).toMatch(/^FIXTURE_/u);
    expect(quote.rateObservedAt).toBe('2026-09-01T00:00:00.000Z');
    expect(quote.expiresAt).toBe('2026-09-03T09:15:00.000Z');
    expect(quote.canonicalHash).toMatch(/^sha256:[a-f0-9]{64}$/u);

    // Fees plus net always equal gross, exactly.
    const originFee = BigInt(quote.fees[0]!.amount.amountMinor);
    expect(BigInt(quote.settlementAmount.amountMinor) + originFee)
      .toBe(BigInt(quote.grossSettlementAmount.amountMinor));
  });

  it('produces a byte-identical hash for identical inputs', async () => {
    const policy = resolve('PL', 'IN').policy;
    const rates = await new FixtureRateSource().rates(policy, NOW);
    const build = () => buildQuote({
      id: 'FXQ-STABLE',
      policy,
      fundingAmount: parseMajor('12000.00', 'PLN', 2),
      rates,
      quotedAt: NOW,
      ttlSeconds: 900,
    });
    expect(build().canonicalHash).toBe(build().canonicalHash);
  });

  it('expires exactly at its stated instant', () => {
    const quote = { id: 'FXQ-1', expiresAt: '2026-09-03T09:15:00.000Z' };
    expect(quoteIsCurrent(quote, new Date('2026-09-03T09:14:59.999Z'))).toBe(true);
    expect(quoteIsCurrent(quote, new Date('2026-09-03T09:15:00.000Z'))).toBe(false);
    expect(() => assertQuoteCurrent(quote, new Date('2026-09-03T09:15:00.001Z'))).toThrow(/expired/u);
  });

  it('refuses a funding amount in the wrong currency or too small to settle', async () => {
    const policy = resolve('PL', 'IN').policy;
    const rates = await new FixtureRateSource().rates(policy, NOW);
    expect(() => buildQuote({
      id: 'FXQ-2', policy, fundingAmount: money('100', 'EUR', 2), rates, quotedAt: NOW, ttlSeconds: 900,
    })).toThrow(/funds in PLN/u);
    expect(() => buildQuote({
      id: 'FXQ-3', policy, fundingAmount: money('0', 'PLN', 2), rates, quotedAt: NOW, ttlSeconds: 900,
    })).toThrow(/positive funding amount/u);
  });

  it('fails closed instead of disguising a fixture as live when Frankfurter is unreachable', async () => {
    const policy = resolve('PL', 'IN').policy;
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const source = new FrankfurterRateSource('https://api.frankfurter.app', 50);
    await expect(source.rates(policy, NOW)).rejects.toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE', statusCode: 503,
    });
  });

  it('records both live Frankfurter legs with their shared observation date', async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      const to = url.searchParams.get('to');
      const response = new Response(JSON.stringify({
        date: '2026-09-03',
        rates: { [String(to)]: to === 'USD' ? 0.25 : 83.4 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
      Object.defineProperty(response, 'url', { value: url.toString() });
      return response;
    });
    vi.stubGlobal('fetch', fetchMock);
    const policy = resolve('PL', 'IN').policy;
    const rates = await new FrankfurterRateSource('https://api.frankfurter.app').rates(policy, NOW);
    const quote = buildQuote({
      id: 'FXQ-LIVE', policy, fundingAmount: money('1200000', 'PLN', 2), rates, quotedAt: NOW, ttlSeconds: 900,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(quote).toMatchObject({
      provider: 'FRANKFURTER_ECB_REFERENCE',
      rateSource: 'FRANKFURTER_ECB_2026-09-03',
      rateObservedAt: '2026-09-03T00:00:00.000Z',
      expiresAt: '2026-09-03T09:15:00.000Z',
    });
  });
});

describe('versioned compliance rules', () => {
  const inward = resolve('PL', 'IN').policy;
  const outward = resolve('IN', 'GB').policy;

  it('applies the per-unit cap to both Indian directions', () => {
    expect(thresholdRulesFor('PL-IN-INWARD').map((rule) => rule.code)).toEqual(['RBI_PER_UNIT_CAP']);
    expect(thresholdRulesFor('IN-GB-OUTWARD').map((rule) => rule.code))
      .toEqual(['RBI_PER_UNIT_CAP', 'RBI_IMPORT_BUYER_DD', 'INDIA_FORM_15CA_PART_REVIEW']);
  });

  it('never applies the import buyer due-diligence threshold to an inward freelancer payment', () => {
    // 20 lakh INR: far above the 2.5 lakh import threshold, below the 25 lakh cap.
    const decision = evaluate({
      id: 'CMP-1',
      policy: inward,
      inrEquivalent: money('200000000', 'INR', 2),
      originCredential: credential({ country: 'PL', assuranceLevel: 'BASIC' }),
      destinationCredential: credential({ country: 'IN' }),
      providedDocuments: ['INVOICE', 'SERVICE_EXPORT_DECLARATION'],
      evaluatedAt: NOW,
    });
    expect(decision.outcome).toBe('PASSED');
    expect(decision.appliedRules).not.toContain('RBI_IMPORT_BUYER_DD');
    expect(decision.requiredDocuments.map((document) => document.code))
      .toEqual(['INVOICE', 'SERVICE_EXPORT_DECLARATION']);
    expect(decision.rulesVersion).toBe(RULES_VERSION);
    expect(decision.citations.length).toBeGreaterThan(0);
  });

  it('applies the import buyer due-diligence threshold to an outward payment', () => {
    const belowThreshold = evaluate({
      id: 'CMP-2',
      policy: outward,
      inrEquivalent: money('25000000', 'INR', 2),
      originCredential: credential({ country: 'IN', assuranceLevel: 'BASIC' }),
      destinationCredential: credential({ country: 'GB' }),
      providedDocuments: ['INVOICE', 'FORM_A2_DEMO', 'TAX_REVIEW_DEMO', 'IMPORT_EVIDENCE'],
      evaluatedAt: NOW,
    });
    // Exactly at the threshold is not "greater than" it.
    expect(belowThreshold.outcome).toBe('PASSED');

    const aboveThreshold = evaluate({
      ...{
        id: 'CMP-3',
        policy: outward,
        inrEquivalent: money('25000001', 'INR', 2),
        originCredential: credential({ country: 'IN', assuranceLevel: 'BASIC' }),
        destinationCredential: credential({ country: 'GB' }),
        providedDocuments: ['INVOICE', 'FORM_A2_DEMO', 'TAX_REVIEW_DEMO', 'IMPORT_EVIDENCE'],
        evaluatedAt: NOW,
      },
    });
    expect(aboveThreshold.outcome).toBe('MANUAL_REVIEW');
    expect(aboveThreshold.reasons.join(' ')).toMatch(/RBI_IMPORT_BUYER_DD/u);
    expect(aboveThreshold.requiredDocuments.map((document) => document.code)).toContain('BUYER_DUE_DILIGENCE');
  });

  it('blocks above the per-unit cap in either direction', () => {
    for (const policy of [inward, outward]) {
      const decision = evaluate({
        id: `CMP-CAP-${policy.direction}`,
        policy,
        inrEquivalent: money('250000001', 'INR', 2),
        originCredential: credential({ country: policy.originCountry }),
        destinationCredential: credential({ country: policy.destinationCountry }),
        providedDocuments: [...policy.requiredDocuments, 'BUYER_DUE_DILIGENCE'],
        evaluatedAt: NOW,
      });
      expect(decision.outcome).toBe('BLOCKED');
      expect(decision.reasons.join(' ')).toMatch(/RBI_PER_UNIT_CAP/u);
    }
  });

  it('blocks on an expired, revoked, unsigned or wrong-country credential', () => {
    const base = {
      id: 'CMP-4',
      policy: inward,
      inrEquivalent: money('1000000', 'INR', 2),
      destinationCredential: credential({ country: 'IN' }),
      providedDocuments: ['INVOICE', 'SERVICE_EXPORT_DECLARATION'],
      evaluatedAt: NOW,
    };
    const cases: Array<[string, CredentialSnapshot]> = [
      ['expired', credential({ expiresAt: '2026-09-01T00:00:00.000Z' })],
      ['revoked', credential({ status: 'REVOKED' })],
      ['unsigned', credential({ signatureValid: false })],
      ['wrong country', credential({ country: 'DE' })],
    ];
    for (const [label, originCredential] of cases) {
      const decision = evaluate({ ...base, id: `CMP-${label.replaceAll(' ', '-')}`, originCredential });
      expect(decision.outcome, label).toBe('BLOCKED');
    }
  });

  it('hashes the decision canonically and stably', () => {
    const input = {
      id: 'CMP-5',
      policy: inward,
      inrEquivalent: money('1000000', 'INR', 2),
      originCredential: credential(),
      destinationCredential: credential({ country: 'IN' }),
      providedDocuments: ['INVOICE', 'SERVICE_EXPORT_DECLARATION'],
      evaluatedAt: NOW,
    };
    expect(evaluate(input).canonicalHash).toBe(evaluate(input).canonicalHash);
    expect(evaluate({ ...input, inrEquivalent: money('1000001', 'INR', 2) }).canonicalHash)
      .not.toBe(evaluate(input).canonicalHash);
  });

  it('requires EU B2B evidence and passes the deployed route when it is complete', () => {
    const policy = resolve('DE', 'PL').policy;
    const base = {
      id: 'CMP-EU-VAT', policy,
      inrEquivalent: money('50000000', 'INR', 2),
      originCredential: credential({ country: 'DE' }),
      destinationCredential: credential({ country: 'PL' }),
      purposeCode: 'B2B_DIGITAL_SERVICES',
      evaluatedAt: NOW,
    };
    const held = evaluate({ ...base, providedDocuments: ['EU_VAT_IDS', 'B2B_SERVICE_CLASSIFICATION'] });
    expect(held.outcome).toBe('MANUAL_REVIEW');
    expect(held.requiredDocuments.find((item) => item.code === 'REVERSE_CHARGE_INVOICE')?.satisfied).toBe(false);

    const complete = evaluate({
      ...base,
      providedDocuments: ['EU_VAT_IDS', 'B2B_SERVICE_CLASSIFICATION', 'REVERSE_CHARGE_INVOICE'],
    });
    expect(complete.outcome).toBe('PASSED');
  });

  it('distinguishes a Russia review from a confirmed listed-party block', () => {
    const policy = resolve('PL', 'RU').policy;
    const base = {
      id: 'CMP-EU-SANCTIONS', policy,
      inrEquivalent: money('30000000', 'INR', 2),
      originCredential: credential({ country: 'PL' }),
      destinationCredential: credential({ country: 'RU' }),
      purposeCode: 'B2B_SERVICES',
      providedDocuments: ['EU_SANCTIONS_SCREENING', 'BENEFICIARY_BANK_SCREENING', 'PAYMENT_PURPOSE_EVIDENCE'],
      evaluatedAt: NOW,
    };
    expect(evaluate(base).outcome).toBe('MANUAL_REVIEW');
    const blocked = evaluate({ ...base, riskSignals: ['SANCTIONS_PARTY_MATCH'] });
    expect(blocked.outcome).toBe('BLOCKED');
    expect(blocked.appliedRules).toContain('SANCTIONS_PARTY_MATCH');
  });

  it('evaluates a configured DPRK block instead of hiding the policy explanation', () => {
    const policy = inspect('PL', 'KP').policy;
    const decision = evaluate({
      id: 'CMP-DPRK', policy,
      inrEquivalent: money('1000000', 'INR', 2),
      originCredential: credential({ country: 'PL' }),
      destinationCredential: credential({ country: 'KP' }),
      providedDocuments: [],
      evaluatedAt: NOW,
    });
    expect(decision.outcome).toBe('BLOCKED');
    expect(decision.appliedRules).toContain('EU_DPRK_TRANSFER_RESTRICTION');
    expect(decision.requiredDocuments.map((item) => item.code)).toContain('PRIOR_AUTHORIZATION');
  });

  it('enforces the shared rich decision schema at runtime', () => {
    const decision = evaluate({
      id: 'CMP-SCHEMA',
      policy: inward,
      inrEquivalent: money('1000000', 'INR', 2),
      originCredential: credential(),
      destinationCredential: credential({ country: 'IN' }),
      providedDocuments: ['INVOICE', 'SERVICE_EXPORT_DECLARATION'],
      evaluatedAt: NOW,
    });

    expect(() => assertComplianceDecision(decision)).not.toThrow();
    expect(() => assertComplianceDecision({ ...decision, uncommittedField: true }))
      .toThrow(/shared runtime contract/u);
    expect(() => assertComplianceDecision({ ...decision, evaluatedAt: 'not-an-instant' }))
      .toThrow(/shared runtime contract/u);
    expect(() => assertComplianceDecision({
      ...decision,
      inrEquivalent: money('1000001', 'INR', 2),
    })).toThrow(/canonical commitment/u);
  });
});
