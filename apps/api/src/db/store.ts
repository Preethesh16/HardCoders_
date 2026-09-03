/**
 * A deliberately narrow data-access port.
 *
 * The demo profile runs the whole marketplace in memory so the test suite and
 * the one-command demo need no database, while `local`/`testnet` run the exact
 * same business code against PostgreSQL 17 through Drizzle. Keeping the port
 * this small is what makes the two implementations trustworthy: there is no
 * query language to diverge, only equality filters, ordering and a limit.
 */

import { and, asc, desc, eq, getTableColumns, getTableName, type SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

export type Table = PgTable;
export type Select<T extends Table> = T['$inferSelect'];
export type Insert<T extends Table> = T['$inferInsert'];

export interface FindOptions<T extends Table> {
  readonly orderBy?: keyof Select<T> & string;
  readonly direction?: 'asc' | 'desc';
  readonly limit?: number;
}

export interface DataStore {
  insert<T extends Table>(table: T, row: Insert<T>): Promise<Select<T>>;
  findOne<T extends Table>(table: T, where: Partial<Select<T>>): Promise<Select<T> | null>;
  findMany<T extends Table>(table: T, where?: Partial<Select<T>>, options?: FindOptions<T>): Promise<Select<T>[]>;
  update<T extends Table>(table: T, where: Partial<Select<T>>, patch: Partial<Insert<T>>): Promise<Select<T>[]>;
  /**
   * Runs `work` atomically. The in-memory implementation restores its previous
   * state on failure, so a rejected mutation leaves no partial aggregate behind
   * in either profile.
   */
  transaction<R>(work: (tx: DataStore) => Promise<R>): Promise<R>;
  close(): Promise<void>;
}

function column(table: Table, name: string): never {
  const found = (getTableColumns(table) as Record<string, unknown>)[name];
  if (found === undefined) throw new Error(`${getTableName(table)} has no column ${name}.`);
  return found as never;
}

function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => row[key] === value);
}

function compare(left: unknown, right: unknown): number {
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  return String(left ?? '').localeCompare(String(right ?? ''));
}

export class MemoryDataStore implements DataStore {
  readonly #tables = new Map<string, Map<string, Record<string, unknown>>>();

  #rows(table: Table): Map<string, Record<string, unknown>> {
    const name = getTableName(table);
    let rows = this.#tables.get(name);
    if (!rows) {
      rows = new Map();
      this.#tables.set(name, rows);
    }
    return rows;
  }

  async insert<T extends Table>(table: T, row: Insert<T>): Promise<Select<T>> {
    const rows = this.#rows(table);
    const record = structuredClone(row) as Record<string, unknown>;
    const key = record['id'];
    if (typeof key !== 'string') throw new Error(`${getTableName(table)} rows require a string id.`);
    if (rows.has(key)) throw new Error(`${getTableName(table)} already contains ${key}.`);
    rows.set(key, record);
    return structuredClone(record) as Select<T>;
  }

  async findOne<T extends Table>(table: T, where: Partial<Select<T>>): Promise<Select<T> | null> {
    const [first] = await this.findMany(table, where, { limit: 1 });
    return first ?? null;
  }

  async findMany<T extends Table>(
    table: T,
    where: Partial<Select<T>> = {},
    options: FindOptions<T> = {},
  ): Promise<Select<T>[]> {
    const filter = where as Record<string, unknown>;
    let found = [...this.#rows(table).values()].filter((row) => matches(row, filter));
    if (options.orderBy) {
      const key = options.orderBy;
      const sign = options.direction === 'desc' ? -1 : 1;
      found = [...found].sort((left, right) => sign * compare(left[key], right[key]));
    }
    if (options.limit !== undefined) found = found.slice(0, options.limit);
    return found.map((row) => structuredClone(row)) as Select<T>[];
  }

  async update<T extends Table>(
    table: T,
    where: Partial<Select<T>>,
    patch: Partial<Insert<T>>,
  ): Promise<Select<T>[]> {
    const filter = where as Record<string, unknown>;
    const updated: Record<string, unknown>[] = [];
    for (const [key, row] of this.#rows(table)) {
      if (!matches(row, filter)) continue;
      const next = { ...row, ...structuredClone(patch) as Record<string, unknown> };
      this.#rows(table).set(key, next);
      updated.push(structuredClone(next));
    }
    return updated as Select<T>[];
  }

  async transaction<R>(work: (tx: DataStore) => Promise<R>): Promise<R> {
    const snapshot = new Map(
      [...this.#tables].map(([name, rows]) => [name, new Map([...rows].map(([key, row]) => [key, structuredClone(row)]))]),
    );
    try {
      return await work(this);
    } catch (error) {
      this.#tables.clear();
      for (const [name, rows] of snapshot) this.#tables.set(name, rows);
      throw error;
    }
  }

  async close(): Promise<void> {}
}

type Database = NodePgDatabase<Record<string, never>>;

export class PostgresDataStore implements DataStore {
  constructor(
    private readonly database: Database,
    private readonly shutdown: () => Promise<void> = async () => {},
  ) {}

  #where<T extends Table>(table: T, where: Partial<Select<T>>): SQL | undefined {
    const clauses = Object.entries(where).map(([key, value]) => eq(column(table, key), value as never));
    return clauses.length === 0 ? undefined : and(...clauses);
  }

  async insert<T extends Table>(table: T, row: Insert<T>): Promise<Select<T>> {
    const [inserted] = await this.database.insert(table).values(row as never).returning();
    if (!inserted) throw new Error('The insert returned no row.');
    return inserted as Select<T>;
  }

  async findOne<T extends Table>(table: T, where: Partial<Select<T>>): Promise<Select<T> | null> {
    const [first] = await this.findMany(table, where, { limit: 1 });
    return first ?? null;
  }

  async findMany<T extends Table>(
    table: T,
    where: Partial<Select<T>> = {},
    options: FindOptions<T> = {},
  ): Promise<Select<T>[]> {
    let query = this.database.select().from(table as PgTable).$dynamic();
    const clause = this.#where(table, where);
    if (clause) query = query.where(clause);
    if (options.orderBy) {
      const ordering = column(table, options.orderBy);
      query = query.orderBy(options.direction === 'desc' ? desc(ordering) : asc(ordering));
    }
    if (options.limit !== undefined) query = query.limit(options.limit);
    return await query as Select<T>[];
  }

  async update<T extends Table>(
    table: T,
    where: Partial<Select<T>>,
    patch: Partial<Insert<T>>,
  ): Promise<Select<T>[]> {
    let query = this.database.update(table).set(patch as never).$dynamic();
    const clause = this.#where(table, where);
    if (clause) query = query.where(clause);
    return await query.returning() as Select<T>[];
  }

  async transaction<R>(work: (tx: DataStore) => Promise<R>): Promise<R> {
    return this.database.transaction(async (inner) =>
      work(new PostgresDataStore(inner as unknown as Database)));
  }

  async close(): Promise<void> {
    await this.shutdown();
  }
}
