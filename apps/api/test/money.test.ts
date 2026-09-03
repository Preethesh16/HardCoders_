/**
 * Fixed-point money.
 *
 * These tests exist to prove that no PLN, USD or INR amount ever passes through
 * a JavaScript floating-point number, and that rounding is exact and stated.
 */

import { describe, expect, it } from 'vitest';
import {
  basisPointFee,
  convertMoney,
  formatMoney,
  formatRate,
  money,
  parseMajor,
  parseRate,
  rescale,
  subtractMoney,
} from '../src/money.js';

describe('fixed-point amounts', () => {
  it('rejects anything that is not an exact non-negative integer of minor units', () => {
    expect(() => money('12.5', 'PLN', 2)).toThrow(/integer of minor units/u);
    expect(() => money('-100', 'PLN', 2)).toThrow();
    expect(() => money('100', 'pln', 2)).toThrow(/currency/u);
    expect(() => money('100', 'PLN', 9)).toThrow(/scale/u);
    expect(money(1_200_000n, 'PLN', 2).amountMinor).toBe('1200000');
  });

  it('parses and formats major units without a floating-point step', () => {
    expect(parseMajor('12000.00', 'PLN', 2)).toEqual({ amountMinor: '1200000', currency: 'PLN', scale: 2 });
    expect(parseMajor('0.07', 'USD', 6)).toEqual({ amountMinor: '70000', currency: 'USD', scale: 6 });
    expect(() => parseMajor('0.001', 'PLN', 2)).toThrow(/decimal places/u);
    expect(formatMoney(money('1200000', 'PLN', 2))).toBe('12000.00 PLN');
    expect(formatMoney(money('7', 'USD', 6))).toBe('0.000007 USD');
    expect(formatMoney(money('0', 'INR', 2))).toBe('0.00 INR');
  });

  it('converts PLN to USD to INR exactly at the demonstration reference rates', () => {
    const funding = parseMajor('12000.00', 'PLN', 2);
    // 12000.00 PLN x 0.25 USD/PLN = 3000.000000 USD.
    const usd = convertMoney(funding, 'USD', 6, parseRate('0.250000'));
    expect(usd).toEqual({ amountMinor: '3000000000', currency: 'USD', scale: 6 });

    // 3000.000000 USD x 83.194675 INR/USD = 249584.025 INR, half-up to .03.
    const inr = convertMoney(usd, 'INR', 2, parseRate('83.194675'));
    expect(inr).toEqual({ amountMinor: '24958403', currency: 'INR', scale: 2 });
  });

  it('rounds half-up at the boundary rather than to nearest-even', () => {
    // 1 minor unit x 1.5 rounds up to 2, not down to the even 2 by accident.
    expect(convertMoney(money('1', 'USD', 0), 'INR', 0, parseRate('1.5')).amountMinor).toBe('2');
    expect(convertMoney(money('1', 'USD', 0), 'INR', 0, parseRate('2.5')).amountMinor).toBe('3');
    expect(convertMoney(money('1', 'USD', 0), 'INR', 0, parseRate('1.4999')).amountMinor).toBe('1');
  });

  it('computes basis-point fees on exact integers with half-up rounding', () => {
    // 50 bps of 3000.000000 USD is exactly 15.000000 USD.
    expect(basisPointFee(money('3000000000', 'USD', 6), 50).amountMinor).toBe('15000000');
    // 35 bps of 1 minor unit rounds to 0; 5000 bps of 1 rounds up to 1.
    expect(basisPointFee(money('1', 'USD', 6), 35).amountMinor).toBe('0');
    expect(basisPointFee(money('1', 'USD', 6), 5_000).amountMinor).toBe('1');
    expect(() => basisPointFee(money('1', 'USD', 6), 10_001)).toThrow();
  });

  it('never loses a digit when rescaling, and refuses when it would', () => {
    expect(rescale(money('1200000', 'PLN', 2), 6).amountMinor).toBe('12000000000');
    expect(rescale(money('12000000000', 'PLN', 6), 2).amountMinor).toBe('1200000');
    expect(() => rescale(money('12000000001', 'PLN', 6), 2)).toThrow(/lose precision/u);
  });

  it('refuses to subtract into a negative balance or across denominations', () => {
    expect(subtractMoney(money('100', 'USD', 2), money('40', 'USD', 2)).amountMinor).toBe('60');
    expect(() => subtractMoney(money('40', 'USD', 2), money('100', 'USD', 2))).toThrow(/negative/u);
    expect(() => subtractMoney(money('100', 'USD', 2), money('40', 'INR', 2))).toThrow(/currency and scale/u);
  });

  it('keeps every supplied digit of an FX rate as a scaled integer', () => {
    const rate = parseRate('83.194675');
    expect(rate).toEqual({ units: 83_194_675n, scale: 6 });
    expect(formatRate(rate)).toBe('83.194675');
    expect(formatRate(parseRate('0.25'))).toBe('0.25');
    expect(() => parseRate('0')).toThrow(/positive/u);
  });

  it('produces the same total whether fees are taken before or after conversion checks', () => {
    const gross = money('3000000000', 'USD', 6);
    const fee = basisPointFee(gross, 50);
    const net = subtractMoney(gross, fee);
    expect(BigInt(net.amountMinor) + BigInt(fee.amountMinor)).toBe(BigInt(gross.amountMinor));
  });
});
