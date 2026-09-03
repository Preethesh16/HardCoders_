import { createHash, randomUUID } from 'node:crypto';

/**
 * Deterministic time and identity.
 *
 * Tests and the recorded demo need reproducible identifiers and timestamps, and
 * every hash that reaches a ledger must be reproducible from stored data alone.
 */
export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(prefix: string): string;
}

export const systemClock: Clock = { now: () => new Date() };

export class FixedClock implements Clock {
  #current: number;
  constructor(start: Date, private readonly stepMs = 1_000) {
    this.#current = start.getTime();
  }
  now(): Date {
    const value = new Date(this.#current);
    this.#current += this.stepMs;
    return value;
  }
  advance(ms: number): void {
    this.#current += ms;
  }
}

export const randomIds: IdGenerator = { next: (prefix) => `${prefix}-${randomUUID()}` };

/** Sequential identifiers keep demo transcripts and test failures readable. */
export class SequentialIds implements IdGenerator {
  readonly #counters = new Map<string, number>();
  next(prefix: string): string {
    const value = (this.#counters.get(prefix) ?? 0) + 1;
    this.#counters.set(prefix, value);
    return `${prefix}-${String(value).padStart(6, '0')}`;
  }
}

export function sha256Text(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

export function sha256Bytes(value: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
