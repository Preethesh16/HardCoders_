/**
 * Demonstration seed.
 *
 * Creates the two journeys the prototype demonstrates - a Polish company paying
 * an Indian freelancer, and an Indian company paying a United Kingdom supplier -
 * with real signed `did:key` credentials generated at run time.
 *
 * No key material is committed: the issuer keypair is generated in process on
 * every start and never written to disk or returned by a route.
 */

import type { VerifiableCredential } from '@optiwork/contracts';
import { createDemoIssuer, signCredential, subjectCommitment } from '../identity/credentials.js';
import type { AppContext } from '../context.js';
import { memberships, organizations, users } from '../db/schema.js';
import { IdentityService } from '../identity/service.js';
import { encodeDemoPrincipal, type Principal } from '../auth/authorization.js';

export interface SeededParty {
  readonly principal: Principal;
  readonly token: string;
  readonly organizationId: string;
  readonly credentialId: string;
}

export interface SeedResult {
  readonly polishCompany: SeededParty;
  readonly indianFreelancer: SeededParty;
  readonly indianCompany: SeededParty;
  readonly ukSupplier: SeededParty;
  readonly providerOperator: SeededParty;
  readonly platformAdmin: SeededParty;
  readonly issuerDid: string;
}

interface PartySpec {
  readonly organizationId: string;
  readonly legalName: string;
  readonly country: string;
  readonly kind: 'COMPANY' | 'FREELANCER' | 'SUPPLIER' | 'PROVIDER' | 'PLATFORM';
  readonly userId: string;
  readonly displayName: string;
  readonly roles: Principal['roles'];
  readonly assuranceLevel: VerifiableCredential['assuranceLevel'];
  readonly credential: boolean;
}

const PARTIES: readonly PartySpec[] = [
  {
    organizationId: 'ORG-PL-NOVA',
    legalName: 'Nova Systemy Sp. z o.o.',
    country: 'PL',
    kind: 'COMPANY',
    userId: 'USER-PL-BUYER',
    displayName: 'Warsaw engineering lead',
    roles: ['company_member'],
    assuranceLevel: 'ENHANCED',
    credential: true,
  },
  {
    organizationId: 'ORG-IN-TALENT',
    legalName: 'Meera Iyer (sole proprietor)',
    country: 'IN',
    kind: 'FREELANCER',
    userId: 'USER-IN-FREELANCER',
    displayName: 'Bengaluru contract engineer',
    roles: ['freelancer'],
    assuranceLevel: 'BASIC',
    credential: true,
  },
  {
    organizationId: 'ORG-IN-IMPORTER',
    legalName: 'Sahyadri Instruments Pvt. Ltd.',
    country: 'IN',
    kind: 'COMPANY',
    userId: 'USER-IN-BUYER',
    displayName: 'Pune procurement manager',
    roles: ['company_member'],
    assuranceLevel: 'ENHANCED',
    credential: true,
  },
  {
    organizationId: 'ORG-GB-SUPPLIER',
    legalName: 'Pennine Optics Ltd.',
    country: 'GB',
    kind: 'SUPPLIER',
    userId: 'USER-GB-SUPPLIER',
    displayName: 'Leeds account manager',
    roles: ['supplier'],
    assuranceLevel: 'ENHANCED',
    credential: true,
  },
  {
    organizationId: 'ORG-OPTIWORK-OPS',
    legalName: 'OptiWork provider operations (simulated)',
    country: 'PL',
    kind: 'PROVIDER',
    userId: 'USER-PROVIDER-OPS',
    displayName: 'Provider operations',
    roles: ['provider_operator', 'payments_service'],
    assuranceLevel: 'ENHANCED',
    credential: false,
  },
  {
    organizationId: 'ORG-OPTIWORK-ADMIN',
    legalName: 'OptiWork platform administration (simulated)',
    country: 'PL',
    kind: 'PLATFORM',
    userId: 'USER-PLATFORM-ADMIN',
    displayName: 'Platform administrator',
    roles: ['platform_admin', 'audit_service', 'compliance_service'],
    assuranceLevel: 'ENHANCED',
    credential: false,
  },
];

export async function seedDemo(context: AppContext): Promise<SeedResult> {
  const issuer = createDemoIssuer();
  const identity = new IdentityService(context);
  const now = context.clock.now();
  const seeded = new Map<string, SeededParty>();

  for (const spec of PARTIES) {
    const existingOrganization = await context.store.findOne(organizations, { id: spec.organizationId });
    if (!existingOrganization) {
      await context.store.insert(organizations, {
        id: spec.organizationId,
        legalName: spec.legalName,
        country: spec.country,
        kind: spec.kind,
        createdAt: now.toISOString(),
      });
      await context.store.insert(users, {
        id: spec.userId,
        subject: spec.userId,
        displayName: spec.displayName,
        country: spec.country,
        createdAt: now.toISOString(),
      });
      await context.store.insert(memberships, {
        id: `MEM-${spec.userId}`,
        userId: spec.userId,
        organizationId: spec.organizationId,
        role: spec.roles[0] ?? 'company_member',
        createdAt: now.toISOString(),
      });
    }

    const principal: Principal = {
      subject: spec.userId,
      organizationId: spec.organizationId,
      roles: spec.roles,
      displayName: spec.displayName,
    };

    let credentialId = '';
    if (spec.credential) {
      const credential = signCredential({
        id: `VC-${spec.organizationId}`,
        issuerDid: issuer.issuerDid,
        subjectDid: `did:key:z${Buffer.from(spec.organizationId, 'utf8').toString('base64url')}`,
        // The subject is a salted commitment: nothing personal is recoverable.
        subjectCommitment: subjectCommitment(spec.organizationId, `optiwork-demo-salt-${spec.organizationId}`),
        subjectType: spec.kind === 'FREELANCER' ? 'FREELANCER' : spec.kind === 'SUPPLIER' ? 'SUPPLIER' : 'COMPANY',
        country: spec.country,
        assuranceLevel: spec.assuranceLevel,
        issuedAt: new Date(now.getTime() - 86_400_000).toISOString(),
        expiresAt: new Date(now.getTime() + 365 * 86_400_000).toISOString(),
        status: 'ACTIVE',
      }, issuer.privateKeyPem);
      const registered = await identity.register(principal, {
        credential,
        issuerPublicKeyPem: issuer.publicKeyPem,
      });
      credentialId = registered.id;
    }

    seeded.set(spec.organizationId, {
      principal,
      token: encodeDemoPrincipal(principal),
      organizationId: spec.organizationId,
      credentialId,
    });
  }

  return {
    polishCompany: seeded.get('ORG-PL-NOVA')!,
    indianFreelancer: seeded.get('ORG-IN-TALENT')!,
    indianCompany: seeded.get('ORG-IN-IMPORTER')!,
    ukSupplier: seeded.get('ORG-GB-SUPPLIER')!,
    providerOperator: seeded.get('ORG-OPTIWORK-OPS')!,
    platformAdmin: seeded.get('ORG-OPTIWORK-ADMIN')!,
    issuerDid: issuer.issuerDid,
  };
}
