import { createHash } from 'node:crypto';
import { canonicalize } from 'json-canonicalize';
import type { AuthenticatedActor } from './types.js';

export function sha256(value: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function canonicalHash(value: unknown): `sha256:${string}` {
  return sha256(canonicalize(value));
}

export function opaqueSellerIdentityRef(actor: AuthenticatedActor): string {
  const digest = createHash('sha256')
    .update('optiwork.fabric.seller-ref.v1\0', 'utf8')
    .update(actor.organizationId, 'utf8')
    .update('\0', 'utf8')
    .update(actor.subject, 'utf8')
    .digest('hex');
  return `seller:${digest}`;
}
