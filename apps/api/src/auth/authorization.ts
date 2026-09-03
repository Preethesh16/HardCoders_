/**
 * OIDC authentication and role/ownership authorization.
 *
 * Two verifiers exist. The OIDC verifier validates a Keycloak-issued JWT
 * against the realm JWKS, issuer and audience. The demo verifier accepts a
 * signed-free local principal header so the offline demo can run without an
 * identity provider; it is refused outside the demo profile.
 *
 * Authorization is always two questions, never one: does this role permit the
 * action, and does this principal own the resource?
 */

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { ActorRole } from '@optiwork/contracts';
import type { ApiConfig } from '../config.js';
import { forbidden, unauthorized } from '../errors.js';

export const ROLES: readonly ActorRole[] = [
  'company_member',
  'freelancer',
  'supplier',
  'provider_operator',
  'platform_admin',
  'compliance_service',
  'payments_service',
  'audit_service',
];

export interface Principal {
  readonly subject: string;
  readonly organizationId: string;
  readonly roles: readonly ActorRole[];
  readonly displayName: string;
}

export interface TokenVerifier {
  verify(token: string): Promise<Principal>;
}

function toRoles(value: unknown): ActorRole[] {
  const candidates = Array.isArray(value) ? value : [];
  const roles = candidates.filter((role): role is ActorRole =>
    typeof role === 'string' && (ROLES as readonly string[]).includes(role));
  if (roles.length === 0) throw forbidden('The access token carries no OptiWork role.');
  return roles;
}

function claimString(payload: JWTPayload, claim: string): string {
  const value = payload[claim];
  if (typeof value !== 'string' || value.length === 0) {
    throw forbidden(`The access token is missing the ${claim} claim.`);
  }
  return value;
}

export class OidcTokenVerifier implements TokenVerifier {
  readonly #jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(private readonly config: ApiConfig['auth']) {
    if (!config.jwksUri) throw new Error('OIDC verification requires a JWKS URI.');
    this.#jwks = createRemoteJWKSet(new URL(config.jwksUri));
  }

  async verify(token: string): Promise<Principal> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.#jwks, {
        issuer: this.config.issuer,
        audience: this.config.audience,
        clockTolerance: 5,
        requiredClaims: ['sub', 'iss', 'aud', 'exp'],
      }));
    } catch {
      throw unauthorized('The access token is invalid or expired.');
    }
    return {
      subject: claimString(payload, 'sub'),
      organizationId: claimString(payload, 'organization_id'),
      displayName: typeof payload['name'] === 'string' ? payload['name'] : claimString(payload, 'sub'),
      roles: toRoles(payload[this.config.rolesClaim]),
    };
  }
}

/**
 * Offline demo principal. The token is a base64url JSON principal, never a
 * credential: it grants nothing outside the demo profile, where the verifier is
 * not constructed at all.
 */
export class DemoTokenVerifier implements TokenVerifier {
  async verify(token: string): Promise<Principal> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    } catch {
      throw unauthorized('The demo principal token is malformed.');
    }
    if (typeof parsed !== 'object' || parsed === null) throw unauthorized('The demo principal token is malformed.');
    const record = parsed as Record<string, unknown>;
    if (typeof record['subject'] !== 'string' || typeof record['organizationId'] !== 'string') {
      throw unauthorized('The demo principal token is missing a subject or organization.');
    }
    return {
      subject: record['subject'],
      organizationId: record['organizationId'],
      displayName: typeof record['displayName'] === 'string' ? record['displayName'] : record['subject'],
      roles: toRoles(record['roles']),
    };
  }
}

export function encodeDemoPrincipal(principal: Principal): string {
  return Buffer.from(JSON.stringify(principal), 'utf8').toString('base64url');
}

export function hasRole(principal: Principal, ...allowed: readonly ActorRole[]): boolean {
  return principal.roles.some((role) => allowed.includes(role));
}

export function requireRole(principal: Principal, ...allowed: readonly ActorRole[]): void {
  if (!hasRole(principal, ...allowed)) {
    throw forbidden(`This action requires one of: ${allowed.join(', ')}.`);
  }
}

/** Platform and audit roles may read across tenants; nobody may write across them. */
export function requireOwnership(principal: Principal, organizationId: string): void {
  if (principal.organizationId === organizationId) return;
  throw forbidden('This resource belongs to another organization.');
}

export function requireReadAccess(principal: Principal, ...organizationIds: readonly string[]): void {
  if (hasRole(principal, 'platform_admin', 'audit_service', 'provider_operator')) return;
  if (organizationIds.includes(principal.organizationId)) return;
  throw forbidden('This resource belongs to another organization.');
}
