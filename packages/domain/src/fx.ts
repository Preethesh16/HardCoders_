import type { CorridorPolicy, FxQuote, MoneyDto } from '@optiwork/contracts';
import { canonicalHash } from './canonical.js';
import { convertMoney, type ScaledRate } from './money.js';

export interface FxQuoteRates {
  readonly fundingToUsd: ScaledRate;
  readonly usdToPayout: ScaledRate;
  readonly provider: string;
}

export const demoFxRates: Readonly<Record<string, FxQuoteRates>> = {
  'PL-IN-INWARD-v1': {
    fundingToUsd: { units: 250_000n, scale: 6 },
    usdToPayout: { units: 83_200_000n, scale: 6 },
    provider: 'FRANKFURTER_REFERENCE_FIXTURE',
  },
  'IN-GB-OUTWARD-v1': {
    fundingToUsd: { units: 12_020n, scale: 6 },
    usdToPayout: { units: 790_000n, scale: 6 },
    provider: 'FRANKFURTER_REFERENCE_FIXTURE',
  },
};

function subtractBasisPoints(money: MoneyDto, bps: number): { net: MoneyDto; fee: MoneyDto } {
  const amount = BigInt(money.amountMinor);
  const fee = (amount * BigInt(bps) + 5_000n) / 10_000n;
  return {
    net: { ...money, amountMinor: (amount - fee).toString() },
    fee: { ...money, amountMinor: fee.toString() },
  };
}

export function createFxQuote(
  id: string,
  policy: CorridorPolicy,
  fundingAmount: MoneyDto,
  now = new Date(),
  rates = demoFxRates[policy.id],
): FxQuote {
  if (!rates) throw new Error(`No FX fixture is configured for ${policy.id}.`);
  if (fundingAmount.currency !== policy.fundingCurrency) throw new Error('Funding currency does not match the corridor.');
  const grossSettlementAmount = convertMoney(fundingAmount, 'USD', 6, rates.fundingToUsd);
  const origin = subtractBasisPoints(grossSettlementAmount, 50);
  const grossPayoutAmount = convertMoney(origin.net, policy.payoutCurrency, 2, rates.usdToPayout);
  const destination = subtractBasisPoints(grossPayoutAmount, 35);
  const unsigned = {
    id,
    corridorId: policy.id,
    fundingAmount,
    grossSettlementAmount,
    settlementAmount: origin.net,
    grossPayoutAmount,
    payoutAmount: destination.net,
    rates: [
      { pair: `${policy.fundingCurrency}/USD`, units: rates.fundingToUsd.units.toString(), scale: rates.fundingToUsd.scale },
      { pair: `USD/${policy.payoutCurrency}`, units: rates.usdToPayout.units.toString(), scale: rates.usdToPayout.scale },
    ] as FxQuote['rates'],
    fees: [
      { code: 'ORIGIN_AND_PLATFORM', amount: origin.fee, basisPoints: 50 },
      { code: 'DESTINATION_OFFRAMP', amount: destination.fee, basisPoints: 35 },
    ],
    provider: rates.provider,
    quotedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    executable: false as const,
  };
  return { ...unsigned, canonicalHash: canonicalHash(unsigned) };
}

export function assertQuoteCurrent(quote: FxQuote, at = new Date()): void {
  if (Date.parse(quote.expiresAt) <= at.getTime()) throw new Error('FX quote has expired.');
}
