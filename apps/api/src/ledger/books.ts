/**
 * Simulated fiat books.
 *
 * Every movement of simulated fiat is a balanced double-entry posting in
 * exact integer minor units. A book belongs to exactly one corridor direction,
 * and an entry can only touch accounts inside its own book — so an INWARD
 * Poland→India payment and an OUTWARD India→UK supplier payment can never be
 * netted against each other, by construction rather than by convention.
 */

import type { CorridorDirection } from '@optiwork/contracts';
import { canonicalHash } from '../canonical.js';
import { conflict, unprocessable } from '../errors.js';
import { fiatAccounts, journalEntries, journalLines } from '../db/schema.js';
import type { DataStore } from '../db/store.js';
import type { Clock, IdGenerator } from '../runtime.js';
import { money, type Money } from '../money.js';

export type AccountType =
  | 'CUSTOMER_FUNDING'
  | 'PROVIDER_SETTLEMENT'
  | 'PROVIDER_FEE_INCOME'
  | 'PAYOUT_PAYABLE'
  | 'BENEFICIARY_WALLET';

export interface AccountSpec {
  readonly bookId: string;
  readonly direction: CorridorDirection;
  readonly ownerKind: 'ORGANIZATION' | 'USER' | 'PROVIDER' | 'PLATFORM';
  readonly ownerId: string;
  readonly accountType: AccountType;
  readonly currency: string;
  readonly scale: number;
}

export interface PostingLine {
  readonly accountId: string;
  readonly side: 'DEBIT' | 'CREDIT';
  readonly amount: Money;
}

export interface PostingInput {
  readonly bookId: string;
  readonly direction: CorridorDirection;
  readonly reference: string;
  readonly memo: string;
  readonly paymentId?: string;
  readonly lines: readonly PostingLine[];
}

export class Ledger {
  constructor(
    private readonly store: DataStore,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  /** Idempotently returns the one account matching this specification. */
  async account(spec: AccountSpec): Promise<string> {
    const existing = await this.store.findOne(fiatAccounts, {
      bookId: spec.bookId,
      ownerKind: spec.ownerKind,
      ownerId: spec.ownerId,
      accountType: spec.accountType,
      currency: spec.currency,
    });
    if (existing) {
      if (existing.direction !== spec.direction || existing.scale !== spec.scale) {
        throw conflict(`Account ${existing.id} already exists with a different direction or scale.`);
      }
      return existing.id;
    }
    const created = await this.store.insert(fiatAccounts, {
      id: this.ids.next('ACC'),
      bookId: spec.bookId,
      direction: spec.direction,
      ownerKind: spec.ownerKind,
      ownerId: spec.ownerId,
      accountType: spec.accountType,
      currency: spec.currency,
      scale: spec.scale,
      createdAt: this.clock.now().toISOString(),
    });
    return created.id;
  }

  /**
   * Posts one balanced entry. Re-posting the same `bookId`/`reference` returns
   * the existing entry when the lines are identical and conflicts when they are
   * not, so a retried payment step never double-posts.
   */
  async post(input: PostingInput): Promise<{ entryId: string; entryHash: string; replay: boolean }> {
    if (input.lines.length < 2) throw unprocessable('A journal entry needs at least two lines.');

    const accounts = await Promise.all(input.lines.map(async (line) => {
      const account = await this.store.findOne(fiatAccounts, { id: line.accountId });
      if (!account) throw unprocessable(`Unknown ledger account ${line.accountId}.`);
      return account;
    }));

    const first = accounts[0]!;
    let debits = 0n;
    let credits = 0n;
    for (const [index, line] of input.lines.entries()) {
      const account = accounts[index]!;
      if (account.bookId !== input.bookId || account.direction !== input.direction) {
        throw conflict(
          `Account ${account.id} belongs to book ${account.bookId}/${account.direction}; `
          + `${input.bookId}/${input.direction} entries cannot be netted against it.`,
        );
      }
      if (account.currency !== first.currency || account.scale !== first.scale) {
        throw conflict('A journal entry cannot mix currencies or scales.');
      }
      if (line.amount.currency !== account.currency || line.amount.scale !== account.scale) {
        throw conflict('A journal line must be denominated in its account currency and scale.');
      }
      const amount = BigInt(line.amount.amountMinor);
      if (amount <= 0n) throw unprocessable('Journal amounts must be positive; use the other side instead.');
      if (line.side === 'DEBIT') debits += amount;
      else credits += amount;
    }
    if (debits !== credits) throw unprocessable('A journal entry must balance exactly.');

    const entryHash = canonicalHash({
      bookId: input.bookId,
      direction: input.direction,
      currency: first.currency,
      scale: first.scale,
      reference: input.reference,
      lines: input.lines.map((line) => ({
        accountId: line.accountId,
        side: line.side,
        amountMinor: line.amount.amountMinor,
      })),
    });

    const existing = await this.store.findOne(journalEntries, { bookId: input.bookId, reference: input.reference });
    if (existing) {
      if (existing.entryHash !== entryHash) {
        throw conflict(`Journal reference ${input.reference} already exists with different lines.`);
      }
      return { entryId: existing.id, entryHash, replay: true };
    }

    const entryId = this.ids.next('JE');
    await this.store.insert(journalEntries, {
      id: entryId,
      bookId: input.bookId,
      direction: input.direction,
      currency: first.currency,
      scale: first.scale,
      paymentId: input.paymentId ?? null,
      reference: input.reference,
      memo: input.memo,
      postedAt: this.clock.now().toISOString(),
      entryHash,
    });
    for (const [index, line] of input.lines.entries()) {
      await this.store.insert(journalLines, {
        id: this.ids.next('JL'),
        entryId,
        accountId: line.accountId,
        bookId: input.bookId,
        direction: input.direction,
        currency: first.currency,
        scale: first.scale,
        ordinal: index + 1,
        side: line.side,
        amountMinor: line.amount.amountMinor,
      });
    }
    return { entryId, entryHash, replay: false };
  }

  /** Signed balance: credits minus debits, in the account's own denomination. */
  async balance(accountId: string): Promise<{ signedMinor: string; amount: Money }> {
    const account = await this.store.findOne(fiatAccounts, { id: accountId });
    if (!account) throw unprocessable(`Unknown ledger account ${accountId}.`);
    const lines = await this.store.findMany(journalLines, { accountId });
    let signed = 0n;
    for (const line of lines) {
      signed += line.side === 'CREDIT' ? BigInt(line.amountMinor) : -BigInt(line.amountMinor);
    }
    const magnitude = signed < 0n ? -signed : signed;
    return {
      signedMinor: signed.toString(),
      amount: money(magnitude, account.currency, account.scale),
    };
  }

  /** Proves a book is internally balanced; used by the reconciliation view. */
  async bookIsBalanced(bookId: string): Promise<boolean> {
    const lines = await this.store.findMany(journalLines, { bookId });
    let signed = 0n;
    for (const line of lines) {
      signed += line.side === 'CREDIT' ? BigInt(line.amountMinor) : -BigInt(line.amountMinor);
    }
    return signed === 0n;
  }

  async entriesForPayment(paymentId: string) {
    return this.store.findMany(journalEntries, { paymentId }, { orderBy: 'postedAt' });
  }

  async linesForEntry(entryId: string) {
    return this.store.findMany(journalLines, { entryId }, { orderBy: 'ordinal' });
  }
}
