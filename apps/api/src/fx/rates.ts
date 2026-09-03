/**
 * FX rate sources.
 *
 * The default is a deterministic fixture so the demo, the tests and a recorded
 * walkthrough always produce identical quotes and identical quote hashes. The
 * optional live adapter reads Frankfurter's ECB reference rates. Neither path
 * ever performs floating-point money arithmetic: a decimal rate string is
 * parsed straight into a scaled integer.
 */

import type { CorridorPolicy } from '@optiwork/contracts';
import { unavailable } from '../errors.js';
import { parseRate, type ScaledRate } from '../money.js';

export interface CorridorRates {
  readonly fundingToUsd: ScaledRate;
  readonly usdToPayout: ScaledRate;
  readonly source: string;
  readonly observedAt: string;
}

export interface FxRateSource {
  readonly name: 'FIXTURE' | 'FRANKFURTER';
  rates(policy: CorridorPolicy, at: Date): Promise<CorridorRates>;
}

/**
 * Fixed ECB-style reference rates captured on 2026-09-01. They are frozen on
 * purpose: a demo must not change its numbers because a market moved.
 */
export const FIXTURE_RATES: Readonly<Record<string, { readonly toUsd: string; readonly observedAt: string }>> = {
  PLN: { toUsd: '0.250000', observedAt: '2026-09-01T00:00:00.000Z' },
  INR: { toUsd: '0.012020', observedAt: '2026-09-01T00:00:00.000Z' },
  GBP: { toUsd: '1.265000', observedAt: '2026-09-01T00:00:00.000Z' },
  EUR: { toUsd: '1.085000', observedAt: '2026-09-01T00:00:00.000Z' },
  USD: { toUsd: '1.000000', observedAt: '2026-09-01T00:00:00.000Z' },
};

function invert(rate: string): ScaledRate {
  // 1 / rate at twelve decimal places, computed entirely in integers.
  const parsed = parseRate(rate);
  const scale = 12;
  const numerator = 10n ** BigInt(scale + parsed.scale);
  const units = (numerator * 2n + parsed.units) / (parsed.units * 2n);
  if (units <= 0n) throw new RangeError('Inverted FX rate must remain positive.');
  return { units, scale };
}

function fixtureFor(currency: string): { toUsd: string; observedAt: string } {
  const entry = FIXTURE_RATES[currency];
  if (!entry) throw unavailable(`No deterministic FX fixture is configured for ${currency}.`);
  return entry;
}

export class FixtureRateSource implements FxRateSource {
  readonly name = 'FIXTURE' as const;

  async rates(policy: CorridorPolicy, _at?: Date): Promise<CorridorRates> {
    const funding = fixtureFor(policy.fundingCurrency);
    const payout = fixtureFor(policy.payoutCurrency);
    return {
      fundingToUsd: parseRate(funding.toUsd),
      usdToPayout: invert(payout.toUsd),
      source: 'FIXTURE_ECB_REFERENCE_2026_09_01',
      observedAt: funding.observedAt,
    };
  }
}

const frankfurterSchema = (value: unknown): { date: string; rates: Record<string, number> } => {
  if (typeof value !== 'object' || value === null) throw unavailable('The FX response is not an object.');
  const record = value as Record<string, unknown>;
  if (typeof record['date'] !== 'string' || typeof record['rates'] !== 'object' || record['rates'] === null) {
    throw unavailable('The FX response is missing a date or rates.');
  }
  return { date: record['date'], rates: record['rates'] as Record<string, number> };
};

/**
 * Live ECB reference rates. Frankfurter returns JSON numbers, so the value is
 * re-serialised to its shortest exact decimal string and parsed into a scaled
 * integer immediately; no arithmetic is performed on the double.
 */
export class FrankfurterRateSource implements FxRateSource {
  readonly name = 'FRANKFURTER' as const;

  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 4_000,
    private readonly fallback: FxRateSource = new FixtureRateSource(),
  ) {}

  async rates(policy: CorridorPolicy, at: Date): Promise<CorridorRates> {
    try {
      const [fundingToUsd, payoutPerUsd] = await Promise.all([
        this.pair(policy.fundingCurrency, 'USD'),
        this.pair('USD', policy.payoutCurrency),
      ]);
      return {
        fundingToUsd: fundingToUsd.rate,
        usdToPayout: payoutPerUsd.rate,
        source: `FRANKFURTER_ECB_${fundingToUsd.date}`,
        observedAt: new Date(`${fundingToUsd.date}T00:00:00.000Z`).toISOString(),
      };
    } catch {
      // A demo must never fail because a public rate service is unreachable.
      const rates = await this.fallback.rates(policy, at);
      return { ...rates, source: `${rates.source}_FALLBACK` };
    }
  }

  private async pair(from: string, to: string): Promise<{ rate: ScaledRate; date: string }> {
    const url = new URL('/latest', this.baseUrl);
    url.searchParams.set('from', from);
    url.searchParams.set('to', to);
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw unavailable('The reference FX service rejected the request.');
    const body = frankfurterSchema(await response.json());
    const value = body.rates[to];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw unavailable(`The reference FX service returned no ${from}/${to} rate.`);
    }
    return { rate: parseRate(value.toFixed(10)), date: body.date };
  }
}
