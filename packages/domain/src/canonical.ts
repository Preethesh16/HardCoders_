import { createHash } from 'node:crypto';
import { canonicalize as canonicalizeJson } from 'json-canonicalize';

export function canonicalize(value: unknown): string {
  return canonicalizeJson(value);
}

export function sha256(value: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function canonicalHash(value: unknown): `sha256:${string}` {
  return sha256(canonicalize(value));
}
