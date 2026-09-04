/**
 * Persistence round-trips.
 *
 * The in-memory store returns exactly what it was given. A real database does
 * not: PostgreSQL renders a `timestamptz` as `2026-09-02 09:00:00+00`, not as
 * the ISO-8601 string that was written. Anything a signature or a hash covers
 * must therefore survive that round trip byte for byte, or the signature
 * silently stops verifying once the process restarts.
 *
 * These tests run the real services against a store that deliberately
 * reformats every timestamp column, exactly as PostgreSQL would.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createContext, type AppContext } from '../src/context.js';
import { seedDemo } from '../src/demo/seed.js';
import { runWalkthrough } from '../src/demo/walkthrough.js';
import { MemoryDataStore, type DataStore, type FindOptions, type Insert, type Select, type Table } from '../src/db/store.js';
import { FixedClock, SequentialIds } from '../src/runtime.js';
import { IdentityService } from '../src/identity/service.js';
import { Ledger } from '../src/ledger/books.js';
import { journalEntries, journalLines } from '../src/db/schema.js';
import { money } from '../src/money.js';

/** ISO-8601 instants, as the application writes them. */
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

/** The same instants, as PostgreSQL renders a `timestamptz` back. */
function asPostgresTimestamp(value: string): string {
  return `${value.slice(0, 10)} ${value.slice(11, 19)}+00`;
}

/**
 * Wraps a store so every ISO-8601 value it returns comes back in PostgreSQL's
 * rendering. Columns that must survive verbatim are excluded, which is exactly
 * the guarantee the schema encodes by storing them as text.
 */
class ReformattingStore implements DataStore {
  constructor(
    private readonly inner: DataStore,
    private readonly verbatim: ReadonlySet<string> = new Set(['issuedAt', 'expiresAt']),
  ) {}

  #reformat<T>(row: T): T {
    if (row === null || typeof row !== 'object') return row;
    const record = row as Record<string, unknown>;
    for (const [key, value] of Object.entries(record)) {
      if (typeof value === 'string' && ISO.test(value) && !this.verbatim.has(key)) {
        record[key] = asPostgresTimestamp(value);
      }
    }
    return row;
  }

  async insert<T extends Table>(table: T, row: Insert<T>): Promise<Select<T>> {
    return this.#reformat(await this.inner.insert(table, row));
  }
  async findOne<T extends Table>(table: T, where: Partial<Select<T>>): Promise<Select<T> | null> {
    const found = await this.inner.findOne(table, where);
    return found === null ? null : this.#reformat(found);
  }
  async findMany<T extends Table>(table: T, where?: Partial<Select<T>>, options?: FindOptions<T>): Promise<Select<T>[]> {
    return (await this.inner.findMany(table, where, options)).map((row) => this.#reformat(row));
  }
  async update<T extends Table>(table: T, where: Partial<Select<T>>, patch: Partial<Insert<T>>): Promise<Select<T>[]> {
    return (await this.inner.update(table, where, patch)).map((row) => this.#reformat(row));
  }
  transaction<R>(work: (tx: DataStore) => Promise<R>): Promise<R> {
    return this.inner.transaction(() => work(this));
  }
  close(): Promise<void> {
    return this.inner.close();
  }
}

let context: AppContext | undefined;

afterEach(async () => {
  await context?.close();
  context = undefined;
});

function harnessContext(store: DataStore): AppContext {
  return createContext(loadConfig({ OPTIWORK_PROFILE: 'demo', REGULATION_REFRESH_MODE: 'fixture' }), {
    store,
    clock: new FixedClock(new Date('2026-09-03T09:00:00.000Z')),
    ids: new SequentialIds(),
  });
}

describe('signed values survive a database round trip', () => {
  it('still verifies a credential after the store reformats its timestamps', async () => {
    context = harnessContext(new ReformattingStore(new MemoryDataStore()));
    const seed = await seedDemo(context);
    const identity = new IdentityService(context);

    const verified = await identity.verifyCredential(seed.polishCompany.principal, {
      credentialId: seed.polishCompany.credentialId,
      expectedCountry: 'PL',
    });
    expect(verified.result.checks['signatureValid']).toBe(true);
    expect(verified.result.valid).toBe(true);

    const snapshot = await identity.snapshot(seed.polishCompany.credentialId);
    expect(snapshot.signatureValid).toBe(true);
    expect(snapshot.status).toBe('ACTIVE');
  });

  it('fails verification if the signed instants are ever reformatted', async () => {
    // The guarantee this test protects: were `issuedAt`/`expiresAt` stored as
    // `timestamptz`, every credential would stop verifying after a restart.
    const store = new ReformattingStore(new MemoryDataStore(), new Set());
    context = harnessContext(store);
    const seed = await seedDemo(context);
    const identity = new IdentityService(context);

    const verified = await identity.verifyCredential(seed.polishCompany.principal, {
      credentialId: seed.polishCompany.credentialId,
    });
    expect(verified.result.checks['signatureValid']).toBe(false);
  });

  it('completes both journeys against a reformatting store', async () => {
    context = harnessContext(new ReformattingStore(new MemoryDataStore()));
    const app = await buildApp({ context, logger: false });
    try {
      const result = await runWalkthrough(context);
      expect(result.journeys).toHaveLength(2);
      for (const journey of result.journeys) {
        expect(journey.settlementTransactionId).toMatch(/^[A-Z2-7]{52}$/u);
        expect(journey.fabricTxId).toMatch(/^FABRIC-DECIDE-/u);
      }
      expect(await context.ledger.bookIsBalanced('PL-IN-INWARD')).toBe(true);
      expect(await context.ledger.bookIsBalanced('IN-GB-OUTWARD')).toBe(true);
    } finally {
      await app.close();
    }
  });
});

/** Fails a chosen insert, to prove a partial journal entry never survives. */
class FailingStore extends ReformattingStore {
  failures = 0;

  constructor(inner: DataStore, private readonly failOnOrdinal: number) {
    super(inner);
  }

  override async insert<T extends Table>(table: T, row: Insert<T>): Promise<Select<T>> {
    const record = row as Record<string, unknown>;
    if (record['ordinal'] === this.failOnOrdinal && typeof record['side'] === 'string') {
      this.failures += 1;
      throw new Error('The database rejected the line.');
    }
    return super.insert(table, row);
  }
}

describe('a journal entry is written atomically', () => {
  it('leaves no entry behind when a line cannot be written', async () => {
    const inner = new MemoryDataStore();
    const store = new FailingStore(inner, 2);
    context = harnessContext(store);
    const ledger = new Ledger(store, new FixedClock(new Date('2026-09-03T09:00:00.000Z')), new SequentialIds());

    const spec = {
      bookId: 'PL-IN-INWARD',
      direction: 'INWARD' as const,
      ownerKind: 'ORGANIZATION' as const,
      currency: 'PLN',
      scale: 2,
    };
    const debit = await ledger.account({ ...spec, ownerId: 'ORG-A', accountType: 'CUSTOMER_FUNDING' });
    const credit = await ledger.account({ ...spec, ownerId: 'ORG-B', accountType: 'PROVIDER_SETTLEMENT' });

    await expect(ledger.post({
      bookId: 'PL-IN-INWARD',
      direction: 'INWARD',
      reference: 'PARTIAL-1',
      memo: 'The second line will fail.',
      lines: [
        { accountId: debit, side: 'DEBIT', amount: money('1000', 'PLN', 2) },
        { accountId: credit, side: 'CREDIT', amount: money('1000', 'PLN', 2) },
      ],
    })).rejects.toThrow(/rejected the line/u);
    expect(store.failures).toBe(1);

    // Neither the entry nor its first line may remain: an entry with one line
    // is an unbalanced entry, which the database refuses at commit anyway.
    expect(await inner.findMany(journalEntries, { reference: 'PARTIAL-1' })).toEqual([]);
    expect(await inner.findMany(journalLines, { bookId: 'PL-IN-INWARD' })).toEqual([]);
    expect(await ledger.bookIsBalanced('PL-IN-INWARD')).toBe(true);
  });
});
