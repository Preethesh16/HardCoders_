import { describe, expect, it } from 'vitest';

import { canonicalHash } from '../src/canonical.js';
import { money, parseRate } from '../src/money.js';
import {
  DeterministicDemoProvider,
  defaultSettlementProviders,
  selectSettlementRoute,
  type SettlementProviderAdapter,
  type SettlementTransaction,
} from '../src/settlement/router.js';

const NOW = new Date('2026-09-04T12:00:00.000Z');

function transaction(overrides: Partial<SettlementTransaction> = {}): SettlementTransaction {
  const fx = {
    pair: 'USD/INR', rateUnits: '83200000', rateScale: 6,
    source: 'TEST_ECB', observedAt: '2026-09-04T00:00:00.000Z', fetchedAt: NOW.toISOString(),
  };
  return {
    transactionId: 'PAY-ROUTER-001', corridorId: 'PL-IN-INWARD-v1', bookId: 'PL-IN-INWARD',
    sourceAsset: 'USDC', sourceAmount: money('100000000', 'USD', 6),
    destinationCurrency: 'INR', destinationScale: 2,
    destinationProviderAddress: 'A'.repeat(58), complianceOutcome: 'PASSED',
    complianceResultHash: `sha256:${'c'.repeat(64)}`, rulesVersion: 'RULES-2026-09-04',
    fxRate: parseRate('83.200000'), fxSource: fx.source, fxObservedAt: fx.observedAt,
    fxFetchedAt: fx.fetchedAt, fxOracleHash: canonicalHash(fx), settlementObligations: [],
    ...overrides,
  };
}

function provider(overrides: ConstructorParameters<typeof DeterministicDemoProvider>[0]) {
  return new DeterministicDemoProvider(overrides);
}

describe('dynamic settlement router', () => {
  it('selects the highest exact net recipient amount after hard gates', async () => {
    const result = await selectSettlementRoute({
      transaction: transaction(), providers: defaultSettlementProviders(), generation: 1, now: NOW,
    });
    expect(result.status).toBe('SELECTED');
    expect(result.selectedProviderId).toBe('RAPIDRAMP_DEMO');
    expect(result.routeHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(result.candidates).toHaveLength(3);
  });

  it('rejects a cheaper but unauthorized provider before ranking', async () => {
    const result = await selectSettlementRoute({
      transaction: transaction({
        corridorId: 'GB-IN-INWARD-v1', bookId: 'GB-IN-INWARD',
      }),
      providers: defaultSettlementProviders(), generation: 1, now: NOW,
    });
    expect(result.status).toBe('SELECTED');
    expect(result.selectedProviderId).not.toBe('ECONOFLOW_DEMO');
    const rejected = result.candidates.find((item) => item.quote.providerId === 'ECONOFLOW_DEMO');
    expect(rejected?.eligible).toBe(false);
    expect(rejected?.reasonCodes).toContain('CORRIDOR_NOT_ALLOWED');
  });

  it('holds the escrow when every quote is stale', async () => {
    const stale = provider({
      providerId: 'STALE_DEMO', providerLabel: 'Stale', corridors: ['PL-IN-INWARD'], currencies: ['INR'],
      spreadBasisPoints: 1, feeBasisPoints: 1, networkFeeMinor: 0n,
      estimatedSettlementSeconds: 10, reliabilityBasisPoints: 9999, liquidityUsdcMinor: 1_000_000_000n,
      quoteTtlSeconds: 0,
    });
    const result = await selectSettlementRoute({ transaction: transaction(), providers: [stale], generation: 1, now: NOW });
    expect(result.status).toBe('NO_ELIGIBLE_ROUTE');
    expect(result.reasonCodes).toContain('QUOTE_STALE');
  });

  it('reroutes around an unavailable best-price provider before release', async () => {
    const unavailable = provider({
      providerId: 'CHEAP_BUT_DOWN', providerLabel: 'Down', corridors: ['PL-IN-INWARD'], currencies: ['INR'],
      spreadBasisPoints: 0, feeBasisPoints: 0, networkFeeMinor: 0n,
      estimatedSettlementSeconds: 1, reliabilityBasisPoints: 10_000, liquidityUsdcMinor: 1_000_000_000n,
      operational: false,
    });
    const fallback = provider({
      providerId: 'SAFE_FALLBACK', providerLabel: 'Fallback', corridors: ['PL-IN-INWARD'], currencies: ['INR'],
      spreadBasisPoints: 5, feeBasisPoints: 5, networkFeeMinor: 0n,
      estimatedSettlementSeconds: 60, reliabilityBasisPoints: 9990, liquidityUsdcMinor: 1_000_000_000n,
    });
    const result = await selectSettlementRoute({
      transaction: transaction(), providers: [unavailable, fallback], generation: 1, now: NOW,
    });
    expect(result.selectedProviderId).toBe('SAFE_FALLBACK');
    expect(result.candidates[0]?.reasonCodes).toContain('PROVIDER_UNAVAILABLE');
  });

  it('blocks every route when the committed compliance result did not pass', async () => {
    const result = await selectSettlementRoute({
      transaction: transaction({ complianceOutcome: 'BLOCKED' }),
      providers: defaultSettlementProviders(), generation: 1, now: NOW,
    });
    expect(result.status).toBe('NO_ELIGIBLE_ROUTE');
    expect(result.reasonCodes).toContain('COMPLIANCE_NOT_PASSED');
  });

  it('deducts only obligations explicitly marked settlement-affecting', async () => {
    const adapter = defaultSettlementProviders()[0] as SettlementProviderAdapter;
    const withoutTax = await adapter.getQuote(transaction(), NOW);
    const withholding = money('10000', 'INR', 2);
    const withTax = await adapter.getQuote(transaction({
      settlementObligations: [{ code: 'DEMO_LEGAL_WITHHOLDING', amount: withholding, authority: 'TEST_RULE', settlementAffecting: true }],
    }), NOW);
    expect(BigInt(withoutTax.recipientAmount.amountMinor) - BigInt(withTax.recipientAmount.amountMinor)).toBe(10_000n);
    expect(withTax.settlementObligations).toHaveLength(1);
  });
});
