import { createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import type { VerifiableCredential } from '@optiwork/contracts';
import { canonicalize, sha256 } from './canonical.js';

type CredentialClaims = Omit<VerifiableCredential, 'signature'>;

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58btc(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let encoded = '';
  while (value > 0n) {
    encoded = BASE58_ALPHABET[Number(value % 58n)]! + encoded;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    encoded = `1${encoded}`;
  }
  return encoded || '1';
}

/** W3C did:key for an Ed25519 public key (multicodec 0xed + base58btc). */
export function didKeyFromPublicKey(publicKeyPem: string): string {
  const jwk = createPublicKey(publicKeyPem).export({ format: 'jwk' });
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') {
    throw new Error('An Ed25519 public key is required.');
  }
  const raw = Buffer.from(jwk.x, 'base64url');
  return `did:key:z${base58btc(Buffer.concat([Buffer.from([0xed, 0x01]), raw]))}`;
}

export function createDemoIssuer(): { issuerDid: string; privateKeyPem: string; publicKeyPem: string } {
  const pair = generateKeyPairSync('ed25519');
  const publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return {
    issuerDid: didKeyFromPublicKey(publicKeyPem),
    privateKeyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem,
  };
}

export function subjectCommitment(subjectReference: string, salt: string): `sha256:${string}` {
  if (salt.length < 16) throw new Error('Credential salt must contain at least 16 characters.');
  return sha256(`${salt}\u0000${subjectReference}`);
}

export function signCredential(claims: CredentialClaims, privateKeyPem: string): VerifiableCredential {
  const signature = sign(null, Buffer.from(canonicalize(claims)), privateKeyPem).toString('base64url');
  return { ...claims, signature };
}

export function verifyCredential(credential: VerifiableCredential, publicKeyPem: string, at = new Date()): boolean {
  const { signature, ...claims } = credential;
  if (credential.status !== 'ACTIVE' || Date.parse(credential.expiresAt) <= at.getTime()) return false;
  try {
    if (didKeyFromPublicKey(publicKeyPem) !== credential.issuerDid) return false;
    return verify(null, Buffer.from(canonicalize(claims)), createPublicKey(publicKeyPem), Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}
