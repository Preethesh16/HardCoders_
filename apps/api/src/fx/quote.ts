/**
 * FX quotes.
 *
 * A quote records both legs of the journey — funding currency to USD, then USD
 * to payout currency — with the fees the providers charge, the source and
 * observation time of the rates, an explicit expiry, and a canonical hash. The
 * blockchain only ever carries the USD settlement amount; it performs neither
 * currency trade.
 */

import type { CorridorPolicy } from '@optiwork/contracts';
import { canonicalHash } from '../canonical.js';
import { unprocessable } from '../errors.js';
import { basisPointFee, convertMoney, money, subtractMoney, type Money } from '../money.js';
import type { CorridorRates } from './rates.js';

export const SETTLEMENT_SCALE = 6;

/** Fees are versioned with the quote so a stored quote stays explainable. */
export const FEE_SCHEDULE_VERSION = 'OPTIWORK-FEES-v1';
export const ORIGIN_FEE_BASIS_POINTS = 50;
export const DESTINATION_FEE_BASIS_POINTS = 35;

/**
 * A leg carries its rate as an exact scaled integer in string form. Nothing in
 * a quote is ever a JavaScript number, so a quote can be serialised, stored,
 * hashed and re-read without losing a digit.
 */
export interface QuoteLeg {
  readonly ordinal: number;
  readonly pair: string;
  readonly rateUnits: string;
  readonly rateScale: number;
  readonly from: Money;
  readonly to: Money;
}

export interface QuoteFee {
  readonly code: string;
  readonly basisPoints: number;
  readonly amount: Money;
}

export interface FxQuoteRecord {
  readonly id: string;
  readonly corridorId: string;
  readonly fundingAmount: Money;
  readonly grossSettlementAmount: Money;
  readonly settlementAmount: Money;
  readonly grossPayoutAmount: Money;
  readonly payoutAmount: Money;
  readonly legs: readonly QuoteLeg[];
  readonly fees: readonly QuoteFee[];
  readonly provider: string;
  readonly rateSource: string;
  readonly rateObservedAt: string;
  readonly feeScheduleVersion: string;
  readonly quotedAt: string;
  readonly expiresAt: string;
  readonly executable: false;
  readonly canonicalHash: string;
}

/** The payout scale each currency settles at in the simulated fiat books. */
const PAYOUT_SCALE: Readonly<Record<string, number>> = { INR: 2, GBP: 2, PLN: 2, EUR: 2, USD: 2 };

export function payoutScaleFor(currency: string): number {
  const scale = PAYOUT_SCALE[currency];
  if (scale === undefined) throw unprocessable(`No payout scale is configured for ${currency}.`);
  return scale;
}

export interface BuildQuoteInput {
  readonly id: string;
  readonly policy: CorridorPolicy;
  readonly fundingAmount: Money;
  readonly rates: CorridorRates;
  readonly quotedAt: Date;
  readonly ttlSeconds: number;
  readonly provider?: string;
}

export function buildQuote(input: BuildQuoteInput): FxQuoteRecord {
  const { policy, fundingAmount, rates } = input;
  if (fundingAmount.currency !== policy.fundingCurrency) {
    throw unprocessable(`Corridor ${policy.id} funds in ${policy.fundingCurrency}, not ${fundingAmount.currency}.`);
  }
  if (BigInt(fundingAmount.amountMinor) <= 0n) {
    throw unprocessable('A quote needs a positive funding amount.');
  }

  const grossSettlementAmount = convertMoney(fundingAmount, 'USD', SETTLEMENT_SCALE, rates.fundingToUsd);
  const originFee = basisPointFee(grossSettlementAmount, ORIGIN_FEE_BASIS_POINTS);
  const settlementAmount = subtractMoney(grossSettlementAmount, originFee);
  if (BigInt(settlementAmount.amountMinor) <= 0n) {
    throw unprocessable('The funding amount is too small to settle after origin fees.');
  }

  const payoutScale = payoutScaleFor(policy.payoutCurrency);
  const grossPayoutAmount = convertMoney(settlementAmount, policy.payoutCurrency, payoutScale, rates.usdToPayout);
  const destinationFee = basisPointFee(grossPayoutAmount, DESTINATION_FEE_BASIS_POINTS);
  const payoutAmount = subtractMoney(grossPayoutAmount, destinationFee);
  if (BigInt(payoutAmount.amountMinor) <= 0n) {
    throw unprocessable('The funding amount is too small to pay out after destination fees.');
  }

  const legs: QuoteLeg[] = [
    {
      ordinal: 1,
      pair: `${policy.fundingCurrency}/USD`,
      rateUnits: rates.fundingToUsd.units.toString(),
      rateScale: rates.fundingToUsd.scale,
      from: fundingAmount,
      to: grossSettlementAmount,
    },
    {
      ordinal: 2,
      pair: `USD/${policy.payoutCurrency}`,
      rateUnits: rates.usdToPayout.units.toString(),
      rateScale: rates.usdToPayout.scale,
      from: settlementAmount,
      to: grossPayoutAmount,
    },
  ];
  const fees: QuoteFee[] = [
    { code: 'ORIGIN_AND_PLATFORM', basisPoints: ORIGIN_FEE_BASIS_POINTS, amount: originFee },
    { code: 'DESTINATION_OFFRAMP', basisPoints: DESTINATION_FEE_BASIS_POINTS, amount: destinationFee },
  ];

  const unsigned = {
    id: input.id,
    corridorId: policy.id,
    fundingAmount,
    grossSettlementAmount,
    settlementAmount,
    grossPayoutAmount,
    payoutAmount,
    legs,
    fees,
    provider: input.provider ?? (rates.source.startsWith('FRANKFURTER_ECB_')
      ? 'FRANKFURTER_ECB_REFERENCE'
      : 'OPTIWORK_FIXTURE_PROVIDER'),
    rateSource: rates.source,
    rateObservedAt: rates.observedAt,
    feeScheduleVersion: FEE_SCHEDULE_VERSION,
    quotedAt: input.quotedAt.toISOString(),
    expiresAt: new Date(input.quotedAt.getTime() + input.ttlSeconds * 1_000).toISOString(),
    executable: false as const,
  };

  return { ...unsigned, canonicalHash: canonicalHash(unsigned) };
}

export function quoteIsCurrent(quote: { expiresAt: string }, at: Date): boolean {
  return Date.parse(quote.expiresAt) > at.getTime();
}

export function assertQuoteCurrent(quote: { id: string; expiresAt: string }, at: Date): void {
  if (!quoteIsCurrent(quote, at)) {
    throw unprocessable(`FX quote ${quote.id} expired at ${quote.expiresAt}.`, { expiresAt: quote.expiresAt });
  }
}

function sameMoney(left: Money, right: Money): boolean {
  return left.amountMinor === right.amountMinor
    && left.currency === right.currency
    && left.scale === right.scale;
}

/**
 * Refuses a persisted quote whose hash or internal money chain no longer
 * matches the object originally produced by the quote builder.
 */
export function assertQuoteIntegrity(quote: FxQuoteRecord): void {
  const { canonicalHash: expectedHash, ...unsigned } = quote;
  if (canonicalHash(unsigned) !== expectedHash) {
    throw unprocessable(`FX quote ${quote.id} does not match its canonical commitment.`);
  }
  const quotedAt = Date.parse(quote.quotedAt);
  const observedAt = Date.parse(quote.rateObservedAt);
  const expiresAt = Date.parse(quote.expiresAt);
  if (![quotedAt, observedAt, expiresAt].every(Number.isFinite)
    || expiresAt <= quotedAt
    || observedAt > quotedAt) {
    throw unprocessable(`FX quote ${quote.id} has invalid provenance timestamps.`);
  }
  const [originLeg, payoutLeg] = quote.legs;
  if (quote.legs.length !== 2
    || originLeg?.ordinal !== 1
    || payoutLeg?.ordinal !== 2
    || !sameMoney(originLeg.from, quote.fundingAmount)
    || !sameMoney(originLeg.to, quote.grossSettlementAmount)
    || !sameMoney(payoutLeg.from, quote.settlementAmount)
    || !sameMoney(payoutLeg.to, quote.grossPayoutAmount)
    || quote.settlementAmount.currency !== 'USD'
    || quote.settlementAmount.scale !== SETTLEMENT_SCALE
    || quote.executable !== false
    || quote.provider.trim() === ''
    || quote.rateSource.trim() === '') {
    throw unprocessable(`FX quote ${quote.id} has inconsistent legs or settlement denomination.`);
  }
  let expectedGrossSettlement: Money;
  let expectedGrossPayout: Money;
  try {
    expectedGrossSettlement = convertMoney(quote.fundingAmount, 'USD', SETTLEMENT_SCALE, {
      units: BigInt(originLeg.rateUnits), scale: originLeg.rateScale,
    });
    expectedGrossPayout = convertMoney(quote.settlementAmount, quote.payoutAmount.currency, quote.payoutAmount.scale, {
      units: BigInt(payoutLeg.rateUnits), scale: payoutLeg.rateScale,
    });
  } catch {
    throw unprocessable(`FX quote ${quote.id} contains an invalid scaled rate.`);
  }
  const [originFee, destinationFee] = quote.fees;
  if (originLeg.pair !== `${quote.fundingAmount.currency}/USD`
    || payoutLeg.pair !== `USD/${quote.payoutAmount.currency}`
    || !sameMoney(expectedGrossSettlement, quote.grossSettlementAmount)
    || !sameMoney(expectedGrossPayout, quote.grossPayoutAmount)
    || quote.fees.length !== 2
    || originFee?.code !== 'ORIGIN_AND_PLATFORM'
    || originFee.basisPoints !== ORIGIN_FEE_BASIS_POINTS
    || !sameMoney(originFee.amount, basisPointFee(quote.grossSettlementAmount, ORIGIN_FEE_BASIS_POINTS))
    || BigInt(quote.settlementAmount.amountMinor) + BigInt(originFee.amount.amountMinor)
      !== BigInt(quote.grossSettlementAmount.amountMinor)
    || destinationFee?.code !== 'DESTINATION_OFFRAMP'
    || destinationFee.basisPoints !== DESTINATION_FEE_BASIS_POINTS
    || !sameMoney(destinationFee.amount, basisPointFee(quote.grossPayoutAmount, DESTINATION_FEE_BASIS_POINTS))
    || BigInt(quote.payoutAmount.amountMinor) + BigInt(destinationFee.amount.amountMinor)
      !== BigInt(quote.grossPayoutAmount.amountMinor)) {
    throw unprocessable(`FX quote ${quote.id} does not conserve money across rates and fees.`);
  }
}

/** Total fees expressed in the settlement currency for storage and display. */
export function totalFeesMinor(quote: FxQuoteRecord): string {
  return quote.fees
    .reduce((sum, fee) => sum + BigInt(fee.amount.amountMinor), 0n)
    .toString();
}

export function usdcMinorForSettlement(settlementAmount: Money): Money {
  if (settlementAmount.currency !== 'USD' || settlementAmount.scale !== SETTLEMENT_SCALE) {
    throw unprocessable('USDC settlement requires a six-decimal USD amount.');
  }
  return money(settlementAmount.amountMinor, 'USD', SETTLEMENT_SCALE);
}
