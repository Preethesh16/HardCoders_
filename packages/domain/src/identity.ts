import { createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import type { VerifiableCredential } from '@optiwork/contracts';
import { canonicalize, sha256 } from './canonical.js';

type CredentialClaims = Omit<VerifiableCredential, 'signature'>;

export function createDemoIssuer(): { issuerDid: string; privateKeyPem: string; publicKeyPem: string } {
  const pair = generateKeyPairSync('ed25519');
  const publicDer = pair.publicKey.export({ type: 'spki', format: 'der' });
  return {
    issuerDid: `did:key:z${publicDer.toString('base64url')}`,
    privateKeyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
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
  return verify(null, Buffer.from(canonicalize(claims)), createPublicKey(publicKeyPem), Buffer.from(signature, 'base64url'));
}
