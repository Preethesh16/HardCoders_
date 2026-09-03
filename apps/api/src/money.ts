/**
 * Fixed-point money.
 *
 * Every monetary value in OptiWork is an exact base-10 integer of minor units
 * carried as a decimal string, with its currency and scale. Nothing here — and
 * nothing that calls it — may convert money to a JavaScript `number`.
 */

import type { MoneyDto } from '@optiwork/contracts';
import { addMoney, convertMoney, type ScaledRate } from '@optiwork/domain';

export type { ScaledRate };
export { addMoney, convertMoney };

export interface Money extends MoneyDto {}

const DECIMAL = /^(0|[1-9][0-9]*)$/u;

export function money(amountMinor: string | bigint, currency: string, scale: number): Money {
  const value = typeof amountMinor === 'bigint' ? amountMinor.toString() : amountMinor;
  if (!DECIMAL.test(value)) throw new TypeError(`Money must be a non-negative integer of minor units: ${value}`);
  if (!/^[A-Z]{3}$/u.test(currency)) throw new TypeError(`Unsupported currency code: ${currency}`);
  if (!Number.isInteger(scale) || scale < 0 || scale > 8) throw new RangeError(`Unsupported scale: ${scale}`);
  return { amountMinor: value, currency, scale };
}

export function minorOf(value: Money): bigint {
  return BigInt(value.amountMinor);
}

export function sameDenomination(left: Money, right: Money): boolean {
  return left.currency === right.currency && left.scale === right.scale;
}

export function subtractMoney(left: Money, right: Money): Money {
  if (!sameDenomination(left, right)) throw new TypeError('Money operands must share a currency and scale.');
  const result = minorOf(left) - minorOf(right);
  if (result < 0n) throw new RangeError('Money subtraction must not produce a negative amount.');
  return money(result, left.currency, left.scale);
}

/** Half-up basis-point fee on an exact integer amount. Never floating point. */
export function basisPointFee(value: Money, basisPoints: number): Money {
  if (!Number.isInteger(basisPoints) || basisPoints < 0 || basisPoints > 10_000) {
    throw new RangeError('Basis points must be an integer between 0 and 10000.');
  }
  const amount = minorOf(value);
  const fee = (amount * BigInt(basisPoints) * 2n + 10_000n) / 20_000n;
  return money(fee, value.currency, value.scale);
}

/** Rescales an exact amount, refusing any conversion that would lose precision. */
export function rescale(value: Money, scale: number): Money {
  if (scale === value.scale) return value;
  if (scale > value.scale) {
    return money(minorOf(value) * 10n ** BigInt(scale - value.scale), value.currency, scale);
  }
  const divisor = 10n ** BigInt(value.scale - scale);
  const amount = minorOf(value);
  if (amount % divisor !== 0n) throw new RangeError('Rescaling would lose precision.');
  return money(amount / divisor, value.currency, scale);
}

/** Human-readable major units, produced by string surgery rather than division. */
export function formatMoney(value: Money): string {
  const digits = value.amountMinor.padStart(value.scale + 1, '0');
  const whole = digits.slice(0, digits.length - value.scale) || '0';
  const fraction = value.scale === 0 ? '' : `.${digits.slice(digits.length - value.scale)}`;
  return `${whole}${fraction} ${value.currency}`;
}

/** Parses a major-unit decimal string such as "1200.50" into exact minor units. */
export function parseMajor(value: string, currency: string, scale: number): Money {
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/u.exec(value.trim());
  if (!match) throw new TypeError(`Not a decimal amount: ${value}`);
  const fraction = match[2] ?? '';
  if (fraction.length > scale) throw new RangeError(`More decimal places than scale ${scale} allows.`);
  // BigInt normalises the leading zeros that "0.07" at scale 6 would produce.
  return money(BigInt(`${match[1]}${fraction.padEnd(scale, '0')}`), currency, scale);
}

/** Builds a scaled rate from a decimal string, keeping every supplied digit. */
export function parseRate(value: string, maximumScale = 12): ScaledRate {
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/u.exec(value.trim());
  if (!match) throw new TypeError(`Not a decimal rate: ${value}`);
  const fraction = (match[2] ?? '').slice(0, maximumScale);
  const scale = fraction.length;
  const units = BigInt(`${match[1]}${fraction}`);
  if (units <= 0n) throw new RangeError('An FX rate must be positive.');
  return { units, scale };
}

export function formatRate(rate: ScaledRate): string {
  const digits = rate.units.toString().padStart(rate.scale + 1, '0');
  const whole = digits.slice(0, digits.length - rate.scale) || '0';
  return rate.scale === 0 ? whole : `${whole}.${digits.slice(digits.length - rate.scale)}`;
}
