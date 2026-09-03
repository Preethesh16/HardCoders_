/**
 * The mutation envelope.
 *
 * Every state-changing route goes through here, so the guarantees are uniform
 * rather than per-handler: an `Idempotency-Key` is mandatory, an exact replay
 * returns the recorded response, and the same key with a different request is a
 * conflict rather than a second execution.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { badRequest } from '../errors.js';
import { fingerprintOf, type RequestFingerprint } from '../idempotency/store.js';
import type { Principal } from '../auth/authorization.js';

const KEY_PATTERN = /^[A-Za-z0-9._:-]{8,256}$/u;

export function idempotencyKeyOf(request: FastifyRequest): string {
  const value = request.headers['idempotency-key'];
  if (typeof value !== 'string' || !KEY_PATTERN.test(value)) {
    throw badRequest(
      'Every mutation requires an Idempotency-Key header of 8 to 256 characters from [A-Za-z0-9._:-].',
    );
  }
  return value;
}

export interface MutationOptions<T> {
  readonly scope: string;
  readonly statusCode?: number;
  run(key: string): Promise<T>;
}

/**
 * Runs a mutation exactly once per key.
 *
 * The response is recorded before it is returned, so a client that retries
 * after a dropped connection observes the original result rather than causing a
 * second payment, a second escrow or a second ledger posting.
 */
export async function mutate<T>(
  context: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
  principal: Principal,
  options: MutationOptions<T>,
): Promise<unknown> {
  const key = idempotencyKeyOf(request);
  const fingerprint: RequestFingerprint = {
    method: request.method,
    path: request.routeOptions.url ?? request.url,
    body: request.body ?? null,
    subject: principal.subject,
  };

  const replayed = await context.idempotency.lookup(options.scope, key, fingerprint);
  if (replayed) {
    void reply.status(replayed.statusCode).header('idempotent-replay', 'true');
    return replayed.body;
  }

  const result = await options.run(key);
  const statusCode = options.statusCode ?? 200;
  await context.idempotency.record(options.scope, key, fingerprint, statusCode, result);
  void reply.status(statusCode).header('idempotent-replay', 'false');
  return result;
}

export { fingerprintOf };
