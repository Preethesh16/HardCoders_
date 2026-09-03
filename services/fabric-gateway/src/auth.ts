import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { FastifyRequest } from 'fastify';
import type { ActorRole } from '@optiwork/contracts';
import { AppError } from './errors.js';
import type { AuthenticatedActor } from './types.js';

const actorRoles = new Set<ActorRole>([
  'company_member',
  'freelancer',
  'supplier',
  'provider_operator',
  'platform_admin',
  'compliance_service',
  'payments_service',
  'audit_service',
]);

export interface ActorResolver {
  resolve(request: FastifyRequest): Promise<AuthenticatedActor>;
}

export class DemoActorResolver implements ActorResolver {
  public async resolve(request: FastifyRequest): Promise<AuthenticatedActor> {
    const subject = request.headers['x-demo-subject'];
    const organizationId = request.headers['x-demo-organization'];
    const role = request.headers['x-demo-role'];
    if (typeof subject !== 'string' || typeof organizationId !== 'string' || typeof role !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(subject)
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(organizationId)
      || !actorRoles.has(role as ActorRole)) throw new AppError('UNAUTHENTICATED');
    return {
      subject,
      organizationId,
      role: role as ActorRole,
      roles: [role as ActorRole],
      mspId: role === 'freelancer' || role === 'supplier' ? 'SellerOrgMSP' : 'BuyerOrgMSP',
      fabricIdentityId: `demo-${role}`,
    };
  }
}

export interface OidcActorResolverOptions {
  readonly issuer: string;
  readonly audience: string;
  readonly jwksUrl: string;
  readonly organizationClaim?: string;
  readonly mspClaim?: string;
  readonly fabricIdentityClaim?: string;
}

export class OidcActorResolver implements ActorResolver {
  readonly #options: Required<OidcActorResolverOptions>;
  readonly #jwks: ReturnType<typeof createRemoteJWKSet>;

  public constructor(options: OidcActorResolverOptions) {
    this.#options = {
      ...options,
      organizationClaim: options.organizationClaim ?? 'organization_id',
      mspClaim: options.mspClaim ?? 'msp_id',
      fabricIdentityClaim: options.fabricIdentityClaim ?? 'fabric_identity_id',
    };
    this.#jwks = createRemoteJWKSet(new URL(options.jwksUrl), {
      timeoutDuration: 3_000,
      cooldownDuration: 30_000,
      cacheMaxAge: 600_000,
    });
  }

  public async resolve(request: FastifyRequest): Promise<AuthenticatedActor> {
    const authorization = request.headers.authorization;
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
      throw new AppError('UNAUTHENTICATED');
    }
    try {
      const verified = await jwtVerify(authorization.slice('Bearer '.length), this.#jwks, {
        issuer: this.#options.issuer,
        audience: this.#options.audience,
        algorithms: ['RS256'],
        clockTolerance: 5,
        maxTokenAge: '15m',
        requiredClaims: ['sub', 'iat', 'exp'],
      });
      const claims = verified.payload as Record<string, unknown>;
      const organizationId = claims[this.#options.organizationClaim];
      const mspId = claims[this.#options.mspClaim];
      const fabricIdentityId = claims[this.#options.fabricIdentityClaim];
      const realmAccess = claims['realm_access'];
      const realmRoles = typeof realmAccess === 'object' && realmAccess !== null && !Array.isArray(realmAccess)
        ? (realmAccess as Record<string, unknown>)['roles']
        : undefined;
      const roles = Array.isArray(realmRoles)
        ? realmRoles.filter((role): role is ActorRole => typeof role === 'string' && actorRoles.has(role as ActorRole))
        : [];
      if (typeof verified.payload.sub !== 'string'
        || typeof organizationId !== 'string'
        || typeof mspId !== 'string'
        || typeof fabricIdentityId !== 'string'
        || roles.length !== 1) throw new AppError('UNAUTHENTICATED');
      return {
        subject: verified.payload.sub,
        organizationId,
        role: roles[0]!,
        roles,
        mspId,
        fabricIdentityId,
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('UNAUTHENTICATED');
    }
  }
}
