import { createHash, timingSafeEqual } from "node:crypto";

import { canonicalize } from "json-canonicalize";

export function sha256(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
}

export function sha256Text(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export function digestBytes(value: string): Uint8Array {
  return createHash("sha256").update(value, "utf8").digest();
}

export function parseSha256(value: string): Uint8Array {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) throw new Error("invalid SHA-256 commitment");
  return Buffer.from(value.slice(7), "hex");
}

export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
