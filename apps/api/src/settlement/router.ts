/**
 * Deterministic, auditable settlement routing.
 *
 * Provider adapters are deliberately zero-value demo implementations. They
 * model the boundary a licensed payout provider would expose without claiming
 * a commercial integration. Discovery and optimisation stay off-chain; the
 * selected route is canonically committed into the Algorand release permit.
 */

import { canonicalHash } from '../canonical.js';
import { basisPointFee, convertMoney, money, subtractMoney, type Money, type ScaledRate } from '../money.js';

export type RouteReasonCode =
  | 'COMPLIANCE_NOT_PASSED'
  | 'CORRIDOR_NOT_ALLOWED'
  | 'DESTINATION_CURRENCY_UNSUPPORTED'
  | 'INSUFFICIENT_LIQUIDITY'
  | 'PROVIDER_UNAVAILABLE'
  | 'QUOTE_STALE';

export interface SettlementObligation {
  readonly code: string;
  readonly amount: Money;
  readonly authority: string;
  readonly settlementAffecting: true;
}

export interface SettlementTransaction {
  readonly transactionId: string;
  readonly corridorId: string;
  readonly bookId: string;
  readonly sourceAsset: 'USDC';
  readonly sourceAmount: Money;
  readonly destinationCurrency: string;
  readonly destinationScale: number;
  readonly destinationProviderAddress: string;
  readonly complianceOutcome: 'PASSED' | 'MANUAL_REVIEW' | 'BLOCKED';
  readonly complianceResultHash: string;
  readonly rulesVersion: string;
  readonly fxRate: ScaledRate;
  readonly fxSource: string;
  readonly fxObservedAt: string;
  readonly fxFetchedAt: string;
  readonly fxOracleHash: string;
  readonly settlementObligations: readonly SettlementObligation[];
}

export interface ProviderRouteQuote {
  readonly quoteId: string;
  readonly providerId: string;
  readonly providerLabel: string;
  readonly demoOnly: true;
  readonly transactionId: string;
  readonly corridorId: string;
  readonly sourceAsset: 'USDC';
  readonly sourceAmount: Money;
  readonly destinationCurrency: string;
  readonly grossDestinationAmount: Money;
  readonly spread: Money;
  readonly providerFee: Money;
  readonly networkFee: Money;
  readonly settlementObligations: readonly SettlementObligation[];
  readonly recipientAmount: Money;
  readonly spreadBasisPoints: number;
  readonly estimatedSettlementSeconds: number;
  readonly reliabilityBasisPoints: number;
  readonly availableLiquidityMinor: string;
  readonly quotedAt: string;
  readonly expiresAt: string;
  readonly fxSource: string;
  readonly fxObservedAt: string;
  readonly fxFetchedAt: string;
  readonly fxOracleHash: string;
  readonly authenticityHash: string;
}

export interface EvaluatedProviderRoute {
  readonly quote: ProviderRouteQuote;
  readonly eligible: boolean;
  readonly reasonCodes: readonly RouteReasonCode[];
}

export interface SettlementRouteDecision {
  readonly schemaVersion: '1.0';
  readonly transactionId: string;
  readonly corridorId: string;
  readonly bookId: string;
  readonly generation: number;
  readonly status: 'SELECTED' | 'NO_ELIGIBLE_ROUTE';
  readonly selectedProviderId: string | null;
  readonly selectedQuoteId: string | null;
  readonly selectedRecipientAmount: Money | null;
  readonly selectedProviderFee: Money | null;
  readonly selectedSpread: Money | null;
  readonly selectedNetworkFee: Money | null;
  readonly selectedEstimatedSettlementSeconds: number | null;
  readonly candidates: readonly EvaluatedProviderRoute[];
  readonly rankingRule: 'MAX_NET_RECIPIENT_THEN_ETA_THEN_RELIABILITY_THEN_PROVIDER_ID';
  readonly reasonCodes: readonly string[];
  readonly decidedAt: string;
  readonly expiresAt: string | null;
  readonly fxOracleHash: string;
  readonly complianceResultHash: string;
  readonly rulesVersion: string;
  readonly destinationProviderAddress: string;
  readonly routeHash: string;
}

export interface SettlementExecution {
  readonly providerId: string;
  readonly quoteId: string;
  readonly transactionId: string;
  readonly status: 'COMPLETED';
  readonly settlementReference: string;
  readonly settledAt: string;
  readonly demoOnly: true;
}

export interface SettlementProviderAdapter {
  readonly providerId: string;
  getQuote(transaction: SettlementTransaction, now: Date): Promise<ProviderRouteQuote>;
  getEligibility(transaction: SettlementTransaction): Promise<readonly RouteReasonCode[]>;
  getLiquidity(transaction: SettlementTransaction): Promise<string>;
  executeSettlement(transaction: SettlementTransaction, quote: ProviderRouteQuote, now: Date): Promise<SettlementExecution>;
  getSettlementStatus(reference: string): Promise<'COMPLETED' | 'NOT_FOUND'>;
}

export interface DemoProviderConfig {
  readonly providerId: string;
  readonly providerLabel: string;
  readonly corridors: readonly string[];
  readonly currencies: readonly string[];
  readonly spreadBasisPoints: number;
  readonly feeBasisPoints: number;
  readonly networkFeeMinor: bigint;
  readonly estimatedSettlementSeconds: number;
  readonly reliabilityBasisPoints: number;
  readonly liquidityUsdcMinor: bigint;
  readonly operational?: boolean;
  readonly quoteTtlSeconds?: number;
}

function sumObligations(transaction: SettlementTransaction, denomination: Money): Money {
  return transaction.settlementObligations.reduce((total, item) => {
    if (item.amount.currency !== denomination.currency || item.amount.scale !== denomination.scale) {
      throw new TypeError(`Settlement obligation ${item.code} has the wrong denomination.`);
    }
    return money(BigInt(total.amountMinor) + BigInt(item.amount.amountMinor), total.currency, total.scale);
  }, money(0n, denomination.currency, denomination.scale));
}

export class DeterministicDemoProvider implements SettlementProviderAdapter {
  readonly providerId: string;
  readonly #settlements = new Map<string, SettlementExecution>();

  constructor(private readonly config: DemoProviderConfig) {
    this.providerId = config.providerId;
  }

  async getEligibility(transaction: SettlementTransaction): Promise<readonly RouteReasonCode[]> {
    const reasons: RouteReasonCode[] = [];
    if (transaction.complianceOutcome !== 'PASSED') reasons.push('COMPLIANCE_NOT_PASSED');
    if (!this.config.corridors.includes(transaction.bookId)) reasons.push('CORRIDOR_NOT_ALLOWED');
    if (!this.config.currencies.includes(transaction.destinationCurrency)) reasons.push('DESTINATION_CURRENCY_UNSUPPORTED');
    if (this.config.operational === false) reasons.push('PROVIDER_UNAVAILABLE');
    if (BigInt(transaction.sourceAmount.amountMinor) > this.config.liquidityUsdcMinor) reasons.push('INSUFFICIENT_LIQUIDITY');
    return reasons;
  }

  async getLiquidity(_transaction: SettlementTransaction): Promise<string> {
    return this.config.liquidityUsdcMinor.toString();
  }

  async getQuote(transaction: SettlementTransaction, now: Date): Promise<ProviderRouteQuote> {
    const gross = convertMoney(
      money(transaction.sourceAmount.amountMinor, 'USD', transaction.sourceAmount.scale),
      transaction.destinationCurrency,
      transaction.destinationScale,
      transaction.fxRate,
    );
    const spread = basisPointFee(gross, this.config.spreadBasisPoints);
    const providerFee = basisPointFee(gross, this.config.feeBasisPoints);
    const networkFee = money(this.config.networkFeeMinor, gross.currency, gross.scale);
    const obligations = sumObligations(transaction, gross);
    const recipientAmount = [spread, providerFee, networkFee, obligations]
      .reduce((remaining, deduction) => subtractMoney(remaining, deduction), gross);
    const quotedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + (this.config.quoteTtlSeconds ?? 300) * 1_000).toISOString();
    const unsigned = {
      quoteId: `${this.config.providerId}:${transaction.transactionId}:${quotedAt}`,
      providerId: this.config.providerId,
      providerLabel: this.config.providerLabel,
      demoOnly: true as const,
      transactionId: transaction.transactionId,
      corridorId: transaction.corridorId,
      sourceAsset: 'USDC' as const,
      sourceAmount: transaction.sourceAmount,
      destinationCurrency: transaction.destinationCurrency,
      grossDestinationAmount: gross,
      spread,
      providerFee,
      networkFee,
      settlementObligations: transaction.settlementObligations,
      recipientAmount,
      spreadBasisPoints: this.config.spreadBasisPoints,
      estimatedSettlementSeconds: this.config.estimatedSettlementSeconds,
      reliabilityBasisPoints: this.config.reliabilityBasisPoints,
      availableLiquidityMinor: this.config.liquidityUsdcMinor.toString(),
      quotedAt,
      expiresAt,
      fxSource: transaction.fxSource,
      fxObservedAt: transaction.fxObservedAt,
      fxFetchedAt: transaction.fxFetchedAt,
      fxOracleHash: transaction.fxOracleHash,
    };
    return { ...unsigned, authenticityHash: canonicalHash(unsigned) };
  }

  async executeSettlement(
    transaction: SettlementTransaction,
    quote: ProviderRouteQuote,
    now: Date,
  ): Promise<SettlementExecution> {
    if (quote.providerId !== this.providerId || quote.transactionId !== transaction.transactionId) {
      throw new Error('Provider quote is not bound to this adapter and transaction.');
    }
    if (Date.parse(quote.expiresAt) <= now.getTime()) throw new Error('Provider quote expired before settlement execution.');
    const reference = `DEMO-${canonicalHash({ providerId: this.providerId, quoteId: quote.quoteId }).slice(-20).toUpperCase()}`;
    const result: SettlementExecution = {
      providerId: this.providerId,
      quoteId: quote.quoteId,
      transactionId: transaction.transactionId,
      status: 'COMPLETED',
      settlementReference: reference,
      settledAt: now.toISOString(),
      demoOnly: true,
    };
    this.#settlements.set(reference, result);
    return result;
  }

  async getSettlementStatus(reference: string): Promise<'COMPLETED' | 'NOT_FOUND'> {
    return this.#settlements.has(reference) ? 'COMPLETED' : 'NOT_FOUND';
  }
}

const BOOKS = [
  'PL-IN-INWARD', 'PL-GB-OUTWARD', 'PL-DE-OUTWARD',
  'IN-PL-OUTWARD', 'IN-GB-OUTWARD', 'IN-DE-OUTWARD',
  'GB-PL-OUTWARD', 'GB-IN-INWARD', 'GB-DE-OUTWARD',
  'DE-PL-OUTWARD', 'DE-IN-INWARD', 'DE-GB-OUTWARD',
] as const;

/** Three transparent mock providers for the hackathon routing demonstration. */
export function defaultSettlementProviders(): readonly SettlementProviderAdapter[] {
  return [
    new DeterministicDemoProvider({
      providerId: 'RAPIDRAMP_DEMO', providerLabel: 'RapidRamp demo rail', corridors: BOOKS,
      currencies: ['PLN', 'INR', 'GBP', 'EUR'], spreadBasisPoints: 0, feeBasisPoints: 35,
      networkFeeMinor: 0n, estimatedSettlementSeconds: 45, reliabilityBasisPoints: 9950,
      liquidityUsdcMinor: 1_000_000_000_000n,
    }),
    new DeterministicDemoProvider({
      providerId: 'CLEARSETTLE_DEMO', providerLabel: 'ClearSettle demo rail', corridors: BOOKS,
      currencies: ['PLN', 'INR', 'GBP', 'EUR'], spreadBasisPoints: 0, feeBasisPoints: 35,
      networkFeeMinor: 0n, estimatedSettlementSeconds: 80, reliabilityBasisPoints: 9980,
      liquidityUsdcMinor: 2_000_000_000_000n,
    }),
    new DeterministicDemoProvider({
      // Intentionally narrow authorization: on other corridors it may look
      // cheapest but is rejected before optimisation.
      providerId: 'ECONOFLOW_DEMO', providerLabel: 'EconoFlow limited demo rail',
      corridors: ['IN-PL-OUTWARD'], currencies: ['PLN'],
      spreadBasisPoints: 4, feeBasisPoints: 4, networkFeeMinor: 10n,
      estimatedSettlementSeconds: 130, reliabilityBasisPoints: 9800,
      liquidityUsdcMinor: 500_000_000_000n,
    }),
  ];
}

function routeHash(unsigned: Omit<SettlementRouteDecision, 'routeHash'>): string {
  return canonicalHash(unsigned);
}

/** Hard-gate first, then rank only eligible providers using exact amounts. */
export async function selectSettlementRoute(input: {
  readonly transaction: SettlementTransaction;
  readonly providers: readonly SettlementProviderAdapter[];
  readonly generation: number;
  readonly now: Date;
}): Promise<SettlementRouteDecision> {
  const candidates = await Promise.all(input.providers.map(async (provider): Promise<EvaluatedProviderRoute> => {
    const quote = await provider.getQuote(input.transaction, input.now);
    const reasons = [...await provider.getEligibility(input.transaction)];
    if (Date.parse(quote.expiresAt) <= input.now.getTime()) reasons.push('QUOTE_STALE');
    return { quote, eligible: reasons.length === 0, reasonCodes: [...new Set(reasons)] };
  }));
  const eligible = candidates.filter((candidate) => candidate.eligible).sort((left, right) => {
    const net = BigInt(right.quote.recipientAmount.amountMinor) - BigInt(left.quote.recipientAmount.amountMinor);
    if (net !== 0n) return net > 0n ? 1 : -1;
    if (left.quote.estimatedSettlementSeconds !== right.quote.estimatedSettlementSeconds) {
      return left.quote.estimatedSettlementSeconds - right.quote.estimatedSettlementSeconds;
    }
    if (left.quote.reliabilityBasisPoints !== right.quote.reliabilityBasisPoints) {
      return right.quote.reliabilityBasisPoints - left.quote.reliabilityBasisPoints;
    }
    return left.quote.providerId < right.quote.providerId ? -1 : left.quote.providerId === right.quote.providerId ? 0 : 1;
  });
  const selected = eligible[0] ?? null;
  const unsigned: Omit<SettlementRouteDecision, 'routeHash'> = {
    schemaVersion: '1.0',
    transactionId: input.transaction.transactionId,
    corridorId: input.transaction.corridorId,
    bookId: input.transaction.bookId,
    generation: input.generation,
    status: selected ? 'SELECTED' : 'NO_ELIGIBLE_ROUTE',
    selectedProviderId: selected?.quote.providerId ?? null,
    selectedQuoteId: selected?.quote.quoteId ?? null,
    selectedRecipientAmount: selected?.quote.recipientAmount ?? null,
    selectedProviderFee: selected?.quote.providerFee ?? null,
    selectedSpread: selected?.quote.spread ?? null,
    selectedNetworkFee: selected?.quote.networkFee ?? null,
    selectedEstimatedSettlementSeconds: selected?.quote.estimatedSettlementSeconds ?? null,
    candidates,
    rankingRule: 'MAX_NET_RECIPIENT_THEN_ETA_THEN_RELIABILITY_THEN_PROVIDER_ID',
    reasonCodes: selected
      ? [`${selected.quote.providerId} maximizes exact net recipient amount among hard-gate eligible routes.`]
      : [...new Set(candidates.flatMap((candidate) => candidate.reasonCodes))],
    decidedAt: input.now.toISOString(),
    expiresAt: selected?.quote.expiresAt ?? null,
    fxOracleHash: input.transaction.fxOracleHash,
    complianceResultHash: input.transaction.complianceResultHash,
    rulesVersion: input.transaction.rulesVersion,
    destinationProviderAddress: input.transaction.destinationProviderAddress,
  };
  return { ...unsigned, routeHash: routeHash(unsigned) };
}

export function providerForDecision(
  providers: readonly SettlementProviderAdapter[],
  decision: SettlementRouteDecision,
): SettlementProviderAdapter {
  const provider = providers.find((candidate) => candidate.providerId === decision.selectedProviderId);
  if (!provider) throw new Error(`Selected settlement provider ${decision.selectedProviderId ?? 'NONE'} is unavailable.`);
  return provider;
}
