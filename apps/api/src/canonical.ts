import { createHash } from 'node:crypto';
import { canonicalize } from 'json-canonicalize';

/**
 * RFC 8785 canonical hashing.
 *
 * Every cross-boundary commitment — escrow bindings, release authorizations,
 * compliance results, FX quotes, work evidence — is hashed this way so the API,
 * the executor and the Fabric workstream all produce identical bytes.
 */
export function canonicalJson(value: unknown): string {
  return canonicalize(value);
}

export function canonicalHash(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalize(value), 'utf8').digest('hex')}`;
}
