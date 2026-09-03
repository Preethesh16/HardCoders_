import { describe, expect, it } from 'vitest';
import { addMoney, convertMoney } from '../src/index.js';

describe('deterministic money', () => {
  it('converts USD 1,500 to INR with a scaled 83.50 rate', () => {
    expect(
      convertMoney(
        { amountMinor: '150000', currency: 'USD', scale: 2 },
        'INR',
        2,
        { units: 8350n, scale: 2 },
      ),
    ).toEqual({ amountMinor: '12525000', currency: 'INR', scale: 2 });
  });

  it('rounds half up at the target minor unit', () => {
    expect(
      convertMoney(
        { amountMinor: '1', currency: 'USD', scale: 2 },
        'INR',
        2,
        { units: 150n, scale: 2 },
      ).amountMinor,
    ).toBe('2');
  });

  it('refuses to add unlike currencies', () => {
    expect(() =>
      addMoney(
        { amountMinor: '100', currency: 'USD', scale: 2 },
        { amountMinor: '100', currency: 'INR', scale: 2 },
      ),
    ).toThrow('same currency');
  });
});
