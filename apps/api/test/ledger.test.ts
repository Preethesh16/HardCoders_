/**
 * The double-entry ledger.
 *
 * Balance, denomination and the inward/outward separation are enforced here in
 * code and again in SQL by `apps/api/migrations/0001_ledger_integrity.sql`.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryDataStore } from '../src/db/store.js';
import { Ledger } from '../src/ledger/books.js';
import { FixedClock, SequentialIds } from '../src/runtime.js';
import { money } from '../src/money.js';

let ledger: Ledger;
let store: MemoryDataStore;

beforeEach(() => {
  store = new MemoryDataStore();
  ledger = new Ledger(store, new FixedClock(new Date('2026-09-03T09:00:00.000Z')), new SequentialIds());
});

const inward = (accountType: 'CUSTOMER_FUNDING' | 'PROVIDER_SETTLEMENT' | 'BENEFICIARY_WALLET', ownerId: string, currency = 'PLN', scale = 2) =>
  ledger.account({ bookId: 'PL-IN-INWARD', direction: 'INWARD' as const, ownerKind: 'ORGANIZATION' as const, ownerId, accountType, currency, scale });

const outward = (accountType: 'CUSTOMER_FUNDING' | 'PROVIDER_SETTLEMENT', ownerId: string, currency = 'INR', scale = 2) =>
  ledger.account({ bookId: 'IN-GB-OUTWARD', direction: 'OUTWARD' as const, ownerKind: 'ORGANIZATION' as const, ownerId, accountType, currency, scale });

describe('double-entry postings', () => {
  it('posts a balanced entry and reports exact signed balances', async () => {
    const customer = await inward('CUSTOMER_FUNDING', 'ORG-A');
    const provider = await inward('PROVIDER_SETTLEMENT', 'ORG-B');
    const posted = await ledger.post({
      bookId: 'PL-IN-INWARD',
      direction: 'INWARD',
      reference: 'PAY-1:FIAT_FUNDING',
      memo: 'Simulated PLN debit',
      lines: [
        { accountId: customer, side: 'DEBIT', amount: money('1200000', 'PLN', 2) },
        { accountId: provider, side: 'CREDIT', amount: money('1200000', 'PLN', 2) },
      ],
    });
    expect(posted.replay).toBe(false);
    expect((await ledger.balance(customer)).signedMinor).toBe('-1200000');
    expect((await ledger.balance(provider)).signedMinor).toBe('1200000');
    expect(await ledger.bookIsBalanced('PL-IN-INWARD')).toBe(true);
  });

  it('refuses an unbalanced entry, a single line and a non-positive amount', async () => {
    const customer = await inward('CUSTOMER_FUNDING', 'ORG-A');
    const provider = await inward('PROVIDER_SETTLEMENT', 'ORG-B');
    const line = (accountId: string, side: 'DEBIT' | 'CREDIT', minor: string) =>
      ({ accountId, side, amount: money(minor, 'PLN', 2) });

    await expect(ledger.post({
      bookId: 'PL-IN-INWARD', direction: 'INWARD', reference: 'R1', memo: 'unbalanced',
      lines: [line(customer, 'DEBIT', '100'), line(provider, 'CREDIT', '99')],
    })).rejects.toThrow(/must balance exactly/u);

    await expect(ledger.post({
      bookId: 'PL-IN-INWARD', direction: 'INWARD', reference: 'R2', memo: 'single line',
      lines: [line(customer, 'DEBIT', '100')],
    })).rejects.toThrow(/at least two lines/u);

    await expect(ledger.post({
      bookId: 'PL-IN-INWARD', direction: 'INWARD', reference: 'R3', memo: 'zero',
      lines: [line(customer, 'DEBIT', '0'), line(provider, 'CREDIT', '0')],
    })).rejects.toThrow(/must be positive/u);
  });

  it('refuses to mix currencies or scales inside one entry', async () => {
    const pln = await inward('CUSTOMER_FUNDING', 'ORG-A', 'PLN', 2);
    const usd = await inward('PROVIDER_SETTLEMENT', 'ORG-B', 'USD', 6);
    await expect(ledger.post({
      bookId: 'PL-IN-INWARD', direction: 'INWARD', reference: 'R4', memo: 'mixed',
      lines: [
        { accountId: pln, side: 'DEBIT', amount: money('100', 'PLN', 2) },
        { accountId: usd, side: 'CREDIT', amount: money('100', 'USD', 6) },
      ],
    })).rejects.toThrow(/mix currencies or scales/u);
  });

  it('never nets an inward account against an outward entry', async () => {
    const inwardAccount = await inward('CUSTOMER_FUNDING', 'ORG-A', 'INR', 2);
    const outwardAccount = await outward('PROVIDER_SETTLEMENT', 'ORG-B', 'INR', 2);
    await expect(ledger.post({
      bookId: 'IN-GB-OUTWARD', direction: 'OUTWARD', reference: 'R5', memo: 'netting attempt',
      lines: [
        { accountId: outwardAccount, side: 'DEBIT', amount: money('100', 'INR', 2) },
        { accountId: inwardAccount, side: 'CREDIT', amount: money('100', 'INR', 2) },
      ],
    })).rejects.toThrow(/cannot be netted against it/u);

    // The reverse direction is refused just as firmly.
    await expect(ledger.post({
      bookId: 'PL-IN-INWARD', direction: 'INWARD', reference: 'R6', memo: 'netting attempt',
      lines: [
        { accountId: inwardAccount, side: 'DEBIT', amount: money('100', 'INR', 2) },
        { accountId: outwardAccount, side: 'CREDIT', amount: money('100', 'INR', 2) },
      ],
    })).rejects.toThrow(/cannot be netted against it/u);
  });

  it('keeps identical inward and outward accounts entirely separate', async () => {
    const inwardAccount = await inward('CUSTOMER_FUNDING', 'ORG-SHARED', 'INR', 2);
    const inwardOther = await inward('PROVIDER_SETTLEMENT', 'ORG-OTHER', 'INR', 2);
    const outwardAccount = await outward('CUSTOMER_FUNDING', 'ORG-SHARED', 'INR', 2);
    const outwardOther = await outward('PROVIDER_SETTLEMENT', 'ORG-OTHER', 'INR', 2);
    expect(inwardAccount).not.toBe(outwardAccount);

    await ledger.post({
      bookId: 'PL-IN-INWARD', direction: 'INWARD', reference: 'IN-1', memo: 'inward',
      lines: [
        { accountId: inwardOther, side: 'DEBIT', amount: money('500', 'INR', 2) },
        { accountId: inwardAccount, side: 'CREDIT', amount: money('500', 'INR', 2) },
      ],
    });
    await ledger.post({
      bookId: 'IN-GB-OUTWARD', direction: 'OUTWARD', reference: 'OUT-1', memo: 'outward',
      lines: [
        { accountId: outwardAccount, side: 'DEBIT', amount: money('700', 'INR', 2) },
        { accountId: outwardOther, side: 'CREDIT', amount: money('700', 'INR', 2) },
      ],
    });
    // Same organization, same currency, opposite books: balances never merge.
    expect((await ledger.balance(inwardAccount)).signedMinor).toBe('500');
    expect((await ledger.balance(outwardAccount)).signedMinor).toBe('-700');
    expect(await ledger.bookIsBalanced('PL-IN-INWARD')).toBe(true);
    expect(await ledger.bookIsBalanced('IN-GB-OUTWARD')).toBe(true);
  });

  it('replays an identical reference and conflicts on a changed one', async () => {
    const customer = await inward('CUSTOMER_FUNDING', 'ORG-A');
    const provider = await inward('PROVIDER_SETTLEMENT', 'ORG-B');
    const lines = [
      { accountId: customer, side: 'DEBIT' as const, amount: money('100', 'PLN', 2) },
      { accountId: provider, side: 'CREDIT' as const, amount: money('100', 'PLN', 2) },
    ];
    const first = await ledger.post({
      bookId: 'PL-IN-INWARD', direction: 'INWARD', reference: 'PAY-9:FUNDING', memo: 'first', lines,
    });
    const replay = await ledger.post({
      bookId: 'PL-IN-INWARD', direction: 'INWARD', reference: 'PAY-9:FUNDING', memo: 'first', lines,
    });
    expect(replay.replay).toBe(true);
    expect(replay.entryId).toBe(first.entryId);
    expect((await ledger.balance(customer)).signedMinor).toBe('-100');

    await expect(ledger.post({
      bookId: 'PL-IN-INWARD', direction: 'INWARD', reference: 'PAY-9:FUNDING', memo: 'changed',
      lines: [
        { accountId: customer, side: 'DEBIT', amount: money('200', 'PLN', 2) },
        { accountId: provider, side: 'CREDIT', amount: money('200', 'PLN', 2) },
      ],
    })).rejects.toThrow(/already exists with different lines/u);
  });

  it('reuses an account rather than creating a duplicate', async () => {
    const first = await inward('CUSTOMER_FUNDING', 'ORG-A');
    const second = await inward('CUSTOMER_FUNDING', 'ORG-A');
    expect(second).toBe(first);
  });

  it('handles amounts far beyond the safe-integer range exactly', async () => {
    const customer = await inward('CUSTOMER_FUNDING', 'ORG-BIG', 'PLN', 2);
    const provider = await inward('PROVIDER_SETTLEMENT', 'ORG-BIG-2', 'PLN', 2);
    const huge = '9007199254740993000';
    await ledger.post({
      bookId: 'PL-IN-INWARD', direction: 'INWARD', reference: 'BIG-1', memo: 'large',
      lines: [
        { accountId: customer, side: 'DEBIT', amount: money(huge, 'PLN', 2) },
        { accountId: provider, side: 'CREDIT', amount: money(huge, 'PLN', 2) },
      ],
    });
    expect((await ledger.balance(provider)).amount.amountMinor).toBe(huge);
  });
});
