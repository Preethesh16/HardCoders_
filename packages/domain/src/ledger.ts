import type { CorridorDirection, MoneyDto } from '@optiwork/contracts';
import { canonicalHash } from './canonical.js';

export interface LedgerAccount {
  readonly id: string;
  readonly direction: CorridorDirection;
  readonly currency: string;
  readonly scale: number;
}

export interface JournalLine {
  readonly accountId: string;
  readonly side: 'DEBIT' | 'CREDIT';
  readonly amountMinor: string;
}

export interface JournalEntry {
  readonly id: string;
  readonly direction: CorridorDirection;
  readonly currency: string;
  readonly scale: number;
  readonly reference: string;
  readonly lines: readonly JournalLine[];
  readonly postedAt: string;
  readonly hash: `sha256:${string}`;
}

export class DoubleEntryLedger {
  readonly #accounts = new Map<string, LedgerAccount>();
  readonly #entries = new Map<string, JournalEntry>();

  addAccount(account: LedgerAccount): void {
    if (this.#accounts.has(account.id)) throw new Error(`Account ${account.id} already exists.`);
    this.#accounts.set(account.id, { ...account });
  }

  post(input: Omit<JournalEntry, 'hash'>): JournalEntry {
    const existing = this.#entries.get(input.id);
    if (existing) {
      const candidateHash = canonicalHash(input);
      if (existing.hash !== candidateHash) throw new Error('Journal idempotency conflict.');
      return structuredClone(existing);
    }
    if (input.lines.length < 2) throw new Error('A journal entry needs at least two lines.');
    let debits = 0n;
    let credits = 0n;
    for (const line of input.lines) {
      const account = this.#accounts.get(line.accountId);
      if (!account) throw new Error(`Unknown account ${line.accountId}.`);
      if (account.direction !== input.direction) throw new Error('Inward and outward books cannot be netted.');
      if (account.currency !== input.currency || account.scale !== input.scale) throw new Error('Journal denomination does not match its account.');
      const amount = BigInt(line.amountMinor);
      if (amount <= 0n) throw new Error('Journal amounts must be positive.');
      if (line.side === 'DEBIT') debits += amount;
      else credits += amount;
    }
    if (debits !== credits) throw new Error('Journal entry is not balanced.');
    const entry = { ...input, hash: canonicalHash(input) };
    this.#entries.set(entry.id, entry);
    return structuredClone(entry);
  }

  balance(accountId: string): MoneyDto {
    const account = this.#accounts.get(accountId);
    if (!account) throw new Error(`Unknown account ${accountId}.`);
    let signed = 0n;
    for (const entry of this.#entries.values()) {
      for (const line of entry.lines) {
        if (line.accountId === accountId) signed += line.side === 'CREDIT' ? BigInt(line.amountMinor) : -BigInt(line.amountMinor);
      }
    }
    return { amountMinor: (signed < 0n ? -signed : signed).toString(), currency: account.currency, scale: account.scale };
  }
}
