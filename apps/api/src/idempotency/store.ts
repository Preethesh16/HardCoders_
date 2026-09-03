/**
 * Idempotency for every mutation.
 *
 * A mutation is identified by its scope, its `Idempotency-Key` and a
 * fingerprint of the exact request the caller made. Replaying the same key with
 * the same fingerprint returns the recorded response byte for byte; reusing the
 * key with a different request is a conflict. The subject is part of the record
 * so one tenant's key can never replay another tenant's response.
 */

import { canonicalHash } from '../canonical.js';
import { conflict } from '../errors.js';
import { idempotencyRecords } from '../db/schema.js';
import type { DataStore } from '../db/store.js';
import type { Clock, IdGenerator } from '../runtime.js';

export interface RequestFingerprint {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  readonly subject: string;
}

export interface ReplayedResponse {
  readonly statusCode: number;
  readonly body: unknown;
  readonly replay: true;
}

export function fingerprintOf(request: RequestFingerprint): string {
  return canonicalHash({
    method: request.method,
    path: request.path,
    subject: request.subject,
    body: request.body ?? null,
  });
}

export class IdempotencyStore {
  constructor(
    private readonly store: DataStore,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  /**
   * Returns the recorded response for an exact replay, or `null` when this is a
   * new command. Throws on a key reused with a different request.
   */
  async lookup(scope: string, key: string, request: RequestFingerprint): Promise<ReplayedResponse | null> {
    const existing = await this.store.findOne(idempotencyRecords, { scope, idempotencyKey: key });
    if (!existing) return null;
    const fingerprint = fingerprintOf(request);
    if (existing.fingerprint !== fingerprint || existing.subject !== request.subject) {
      throw conflict(
        `Idempotency-Key ${key} was already used for a different ${scope} request.`,
        { scope, idempotencyKey: key },
      );
    }
    return { statusCode: existing.statusCode, body: existing.response, replay: true };
  }

  async record(
    scope: string,
    key: string,
    request: RequestFingerprint,
    statusCode: number,
    response: unknown,
  ): Promise<void> {
    await this.store.insert(idempotencyRecords, {
      id: this.ids.next('IDEM'),
      scope,
      idempotencyKey: key,
      subject: request.subject,
      fingerprint: fingerprintOf(request),
      statusCode,
      response: response as Record<string, unknown>,
      createdAt: this.clock.now().toISOString(),
    });
  }
}
