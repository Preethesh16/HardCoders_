import { createHash, randomUUID } from 'node:crypto';
import { canonicalize } from 'json-canonicalize';
import { AppError } from './errors.js';
import type { AuthenticatedActor } from './types.js';

const LEDGER_IDEMPOTENCY_DOMAIN = 'optiwork.gateway.ledger-idempotency.v1';
const STORAGE_SCOPE_DOMAIN = 'optiwork.gateway.idempotency-storage-scope.v1';
const STORAGE_KEY_DOMAIN = 'optiwork.gateway.idempotency-storage-key.v1';

export function authenticatedActorScope(actor: AuthenticatedActor): string {
  return canonicalize({
    subject: actor.subject,
    organizationId: actor.organizationId,
    mspId: actor.mspId,
    fabricIdentityId: actor.fabricIdentityId,
    roles: [...actor.roles].sort(),
  });
}

export function deriveLedgerIdempotencyKey(actor: AuthenticatedActor, clientKey: string): string {
  const digest = createHash('sha256')
    .update(LEDGER_IDEMPOTENCY_DOMAIN, 'utf8')
    .update('\0', 'utf8')
    .update(authenticatedActorScope(actor), 'utf8')
    .update('\0', 'utf8')
    .update(clientKey, 'utf8')
    .digest('hex');
  return `GW1-${digest}`;
}

export interface IdempotencyStorageKey {
  readonly actorScopeHash: string;
  readonly idempotencyKeyHash: string;
}

export type IdempotencyClaim =
  | { readonly kind: 'acquired' }
  | { readonly kind: 'completed'; readonly result: unknown }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'pending'; readonly retryAfterMs: number };

export interface IdempotencyStore {
  initialize(): Promise<void>;
  readiness(): Promise<boolean>;
  claim(
    key: IdempotencyStorageKey,
    fingerprint: string,
    ownerToken: string,
    leaseMs: number,
    ttlMs: number,
  ): Promise<IdempotencyClaim>;
  renew(
    key: IdempotencyStorageKey,
    fingerprint: string,
    ownerToken: string,
    leaseMs: number,
  ): Promise<boolean>;
  complete(
    key: IdempotencyStorageKey,
    fingerprint: string,
    ownerToken: string,
    result: unknown,
    ttlMs: number,
  ): Promise<boolean>;
  abandon(
    key: IdempotencyStorageKey,
    fingerprint: string,
    ownerToken: string,
    preserveFingerprint: boolean,
  ): Promise<void>;
  close(): Promise<void>;
}

interface MemoryRecord {
  readonly fingerprint: string;
  state: 'IN_PROGRESS' | 'COMPLETED';
  ownerToken?: string;
  leaseExpiresAt: number;
  expiresAt: number;
  result?: unknown;
}

/** Explicit network-free adapter for unit tests and demo mode only. */
export class MemoryIdempotencyStore implements IdempotencyStore {
  readonly #records = new Map<string, MemoryRecord>();
  readonly #maxEntries: number;
  readonly #now: () => number;

  public constructor(maxEntries: number, now: () => number = Date.now) {
    this.#maxEntries = maxEntries;
    this.#now = now;
  }

  public async initialize(): Promise<void> {}

  public async readiness(): Promise<boolean> {
    return true;
  }

  public async claim(
    key: IdempotencyStorageKey,
    fingerprint: string,
    ownerToken: string,
    leaseMs: number,
    ttlMs: number,
  ): Promise<IdempotencyClaim> {
    const now = this.#now();
    this.#purgeExpired(now);
    const storageKey = this.#storageKey(key);
    const existing = this.#records.get(storageKey);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) return { kind: 'conflict' };
      if (existing.state === 'COMPLETED') return { kind: 'completed', result: existing.result };
      if (existing.leaseExpiresAt > now && existing.ownerToken !== ownerToken) {
        return { kind: 'pending', retryAfterMs: Math.max(1, existing.leaseExpiresAt - now) };
      }
      existing.ownerToken = ownerToken;
      existing.leaseExpiresAt = now + leaseMs;
      existing.expiresAt = now + ttlMs;
      return { kind: 'acquired' };
    }

    this.#ensureCapacity();
    this.#records.set(storageKey, {
      fingerprint,
      state: 'IN_PROGRESS',
      ownerToken,
      leaseExpiresAt: now + leaseMs,
      expiresAt: now + ttlMs,
    });
    return { kind: 'acquired' };
  }

  public async renew(
    key: IdempotencyStorageKey,
    fingerprint: string,
    ownerToken: string,
    leaseMs: number,
  ): Promise<boolean> {
    const record = this.#records.get(this.#storageKey(key));
    if (record === undefined
      || record.state !== 'IN_PROGRESS'
      || record.fingerprint !== fingerprint
      || record.ownerToken !== ownerToken) return false;
    record.leaseExpiresAt = this.#now() + leaseMs;
    return true;
  }

  public async complete(
    key: IdempotencyStorageKey,
    fingerprint: string,
    ownerToken: string,
    result: unknown,
    ttlMs: number,
  ): Promise<boolean> {
    const record = this.#records.get(this.#storageKey(key));
    if (record === undefined
      || record.state !== 'IN_PROGRESS'
      || record.fingerprint !== fingerprint
      || record.ownerToken !== ownerToken) return false;
    record.state = 'COMPLETED';
    delete record.ownerToken;
    record.leaseExpiresAt = 0;
    record.expiresAt = this.#now() + ttlMs;
    record.result = structuredClone(result);
    return true;
  }

  public async abandon(
    key: IdempotencyStorageKey,
    fingerprint: string,
    ownerToken: string,
    preserveFingerprint: boolean,
  ): Promise<void> {
    const storageKey = this.#storageKey(key);
    const record = this.#records.get(storageKey);
    if (record === undefined
      || record.state !== 'IN_PROGRESS'
      || record.fingerprint !== fingerprint
      || record.ownerToken !== ownerToken) return;
    if (!preserveFingerprint) {
      this.#records.delete(storageKey);
      return;
    }
    delete record.ownerToken;
    record.leaseExpiresAt = this.#now();
  }

  public async close(): Promise<void> {}

  #storageKey(key: IdempotencyStorageKey): string {
    return `${key.actorScopeHash}\0${key.idempotencyKeyHash}`;
  }

  #purgeExpired(now: number): void {
    for (const [key, record] of this.#records) {
      if (record.expiresAt <= now
        && (record.state === 'COMPLETED' || record.leaseExpiresAt <= now)) this.#records.delete(key);
    }
  }

  #ensureCapacity(): void {
    if (this.#records.size < this.#maxEntries) return;
    for (const [key, record] of this.#records) {
      if (record.state === 'COMPLETED') {
        this.#records.delete(key);
        return;
      }
    }
    throw new AppError('LEDGER_UNAVAILABLE');
  }
}

interface InflightEntry {
  readonly fingerprint: string;
  readonly promise: Promise<unknown>;
}

export interface IdempotencyOptions {
  readonly ttlMs: number;
  readonly maxEntries: number;
  readonly leaseMs?: number;
  readonly waitTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly store?: IdempotencyStore;
  readonly now?: () => number;
  readonly sleep?: (delayMs: number) => Promise<void>;
}

export interface IdempotencyExecutionOptions<T> {
  /**
   * Limits how long a completed response remains replayable. This is used for
   * expiring authorization artifacts whose cache lifetime must never outlive
   * the artifact itself. The global coordinator TTL remains the upper bound.
   */
  readonly resultTtlMs?: (result: T, completedAtMs: number) => number;
}

function storageHash(domain: string, value: string): string {
  return createHash('sha256').update(domain, 'utf8').update('\0', 'utf8').update(value, 'utf8').digest('hex');
}

function storageKey(actorScope: string, idempotencyKey: string): IdempotencyStorageKey {
  return {
    actorScopeHash: storageHash(STORAGE_SCOPE_DOMAIN, actorScope),
    idempotencyKeyHash: storageHash(STORAGE_KEY_DOMAIN, idempotencyKey),
  };
}

function fingerprint(input: unknown): string {
  return createHash('sha256').update(canonicalize(input), 'utf8').digest('hex');
}

function ambiguousCommit(error: unknown): boolean {
  return error instanceof AppError && error.code === 'LEDGER_COMMIT_TIMEOUT';
}

function unavailable(error: unknown): AppError {
  return error instanceof AppError ? error : new AppError('LEDGER_UNAVAILABLE', { cause: error });
}

export class IdempotencyCoordinator {
  readonly #inflight = new Map<string, InflightEntry>();
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #leaseMs: number;
  readonly #waitTimeoutMs: number;
  readonly #pollIntervalMs: number;
  readonly #store: IdempotencyStore;
  readonly #now: () => number;
  readonly #sleep: (delayMs: number) => Promise<void>;

  public constructor(options: IdempotencyOptions) {
    this.#ttlMs = options.ttlMs;
    this.#maxEntries = options.maxEntries;
    this.#leaseMs = options.leaseMs ?? 120_000;
    this.#waitTimeoutMs = options.waitTimeoutMs ?? 30_000;
    this.#pollIntervalMs = options.pollIntervalMs ?? 100;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    this.#store = options.store ?? new MemoryIdempotencyStore(options.maxEntries, this.#now);
  }

  public async initialize(): Promise<void> {
    try {
      await this.#store.initialize();
    } catch (error) {
      throw unavailable(error);
    }
  }

  public async execute<T>(
    actorScope: string,
    idempotencyKey: string,
    fingerprintInput: unknown,
    operation: () => Promise<T>,
    options: IdempotencyExecutionOptions<T> = {},
  ): Promise<T> {
    const key = storageKey(actorScope, idempotencyKey);
    const localKey = `${key.actorScopeHash}\0${key.idempotencyKeyHash}`;
    const requestFingerprint = fingerprint(fingerprintInput);
    const existing = this.#inflight.get(localKey);
    if (existing !== undefined) {
      if (existing.fingerprint !== requestFingerprint) throw new AppError('IDEMPOTENCY_CONFLICT');
      return existing.promise as Promise<T>;
    }
    if (this.#inflight.size >= this.#maxEntries) throw new AppError('LEDGER_UNAVAILABLE');

    const promise = this.#executePersisted(key, requestFingerprint, operation, options);
    this.#inflight.set(localKey, { fingerprint: requestFingerprint, promise });
    try {
      return await promise;
    } finally {
      if (this.#inflight.get(localKey)?.promise === promise) this.#inflight.delete(localKey);
    }
  }

  public async readiness(): Promise<boolean> {
    try {
      return await this.#store.readiness();
    } catch {
      return false;
    }
  }

  public async close(): Promise<void> {
    this.#inflight.clear();
    await this.#store.close();
  }

  async #executePersisted<T>(
    key: IdempotencyStorageKey,
    requestFingerprint: string,
    operation: () => Promise<T>,
    options: IdempotencyExecutionOptions<T>,
  ): Promise<T> {
    const ownerToken = randomUUID();
    const deadline = this.#now() + this.#waitTimeoutMs;
    for (;;) {
      let claim: IdempotencyClaim;
      try {
        claim = await this.#store.claim(key, requestFingerprint, ownerToken, this.#leaseMs, this.#ttlMs);
      } catch (error) {
        throw unavailable(error);
      }
      if (claim.kind === 'conflict') throw new AppError('IDEMPOTENCY_CONFLICT');
      if (claim.kind === 'completed') return structuredClone(claim.result) as T;
      if (claim.kind === 'acquired') break;
      const remainingMs = deadline - this.#now();
      if (remainingMs <= 0) throw new AppError('LEDGER_UNAVAILABLE');
      await this.#sleep(Math.min(this.#pollIntervalMs, claim.retryAfterMs, remainingMs));
    }

    let operationCompleted = false;
    let ownershipLost = false;
    let renewalInFlight: Promise<void> | undefined;
    const heartbeat = setInterval(() => {
      if (renewalInFlight !== undefined || ownershipLost) return;
      const renewal = this.#store.renew(key, requestFingerprint, ownerToken, this.#leaseMs)
        .then((renewed) => {
          if (!renewed) ownershipLost = true;
        })
        // A transient store error makes ownership uncertain. The mandatory
        // post-operation renewal below is the authority check; it must succeed
        // before this coordinator is allowed to persist or return the result.
        .catch(() => undefined);
      renewalInFlight = renewal;
      void renewal.finally(() => {
        if (renewalInFlight === renewal) renewalInFlight = undefined;
      });
    }, Math.max(250, Math.floor(this.#leaseMs / 3)));
    heartbeat.unref();

    try {
      const result = await operation();
      operationCompleted = true;
      clearInterval(heartbeat);
      if (renewalInFlight !== undefined) await renewalInFlight;
      if (ownershipLost) throw new AppError('LEDGER_UNAVAILABLE');
      const stillOwned = await this.#store.renew(
        key,
        requestFingerprint,
        ownerToken,
        this.#leaseMs,
      );
      if (!stillOwned) throw new AppError('LEDGER_UNAVAILABLE');
      const requestedResultTtlMs = options.resultTtlMs?.(result, this.#now()) ?? this.#ttlMs;
      if (!Number.isSafeInteger(requestedResultTtlMs) || requestedResultTtlMs < 1) {
        throw new AppError('LEDGER_UNAVAILABLE');
      }
      const resultTtlMs = Math.min(this.#ttlMs, requestedResultTtlMs);
      const persisted = await this.#store.complete(key, requestFingerprint, ownerToken, result, resultTtlMs);
      if (!persisted) throw new AppError('LEDGER_UNAVAILABLE');
      return result;
    } catch (error) {
      try {
        await this.#store.abandon(
          key,
          requestFingerprint,
          ownerToken,
          operationCompleted || ambiguousCommit(error),
        );
      } catch (storeError) {
        throw unavailable(storeError);
      }
      throw operationCompleted ? unavailable(error) : error;
    } finally {
      clearInterval(heartbeat);
    }
  }
}
