/**
 * Demonstration seed.
 *
 * Creates country-matched companies and freelancers for every country in the
 * six-country policy matrix, including the two flagship executable journeys,
 * with real signed `did:key` credentials generated at run time. Review-only
 * and blocked identities exist solely to demonstrate their backend gates.
 *
 * No key material is committed: the issuer keypair is generated in process on
 * every start and never written to disk or returned by a route.
 */

import type { VerifiableCredential } from '@optiwork/contracts';
import { createDemoIssuer, signCredential, subjectCommitment } from '../identity/credentials.js';
import type { AppContext } from '../context.js';
import { companyRepresentativeMandates, memberships, organizations, users } from '../db/schema.js';
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
  readonly polishFreelancer: SeededParty;
  readonly indianFreelancer: SeededParty;
  readonly indianFreelancers: readonly SeededParty[];
  readonly indianCompany: SeededParty;
  readonly ukCompany: SeededParty;
  readonly ukFreelancer: SeededParty;
  readonly ukFreelancers: readonly SeededParty[];
  readonly ukSupplier: SeededParty;
  readonly germanCompany: SeededParty;
  readonly germanFreelancer: SeededParty;
  readonly russianCompany: SeededParty;
  readonly russianFreelancer: SeededParty;
  readonly northKoreanCompany: SeededParty;
  readonly northKoreanFreelancer: SeededParty;
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
    organizationId: 'ORG-PL-TALENT',
    legalName: 'Wisla Digital Studio',
    country: 'PL',
    kind: 'FREELANCER',
    userId: 'USER-PL-FREELANCER',
    displayName: 'Krakow contract engineer',
    roles: ['freelancer'],
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
    organizationId: 'ORG-IN-TALENT-2',
    legalName: 'Kabir Rao Digital Services',
    country: 'IN',
    kind: 'FREELANCER',
    userId: 'USER-IN-FREELANCER-2',
    displayName: 'Hyderabad full-stack specialist',
    roles: ['freelancer'],
    assuranceLevel: 'BASIC',
    credential: true,
  },
  {
    organizationId: 'ORG-IN-TALENT-3',
    legalName: 'Ananya Sen Technology Studio',
    country: 'IN',
    kind: 'FREELANCER',
    userId: 'USER-IN-FREELANCER-3',
    displayName: 'Kolkata product engineer',
    roles: ['freelancer'],
    assuranceLevel: 'ENHANCED',
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
    organizationId: 'ORG-GB-TALENT',
    legalName: 'Rowan Ellis Digital Ltd.',
    country: 'GB',
    kind: 'FREELANCER',
    userId: 'USER-GB-FREELANCER',
    displayName: 'Manchester contract engineer',
    roles: ['freelancer'],
    assuranceLevel: 'ENHANCED',
    credential: true,
  },
  {
    organizationId: 'ORG-GB-COMPANY',
    // Real public-record sample used only to demonstrate registry lookup. The
    // product and demo representative have no affiliation with this company.
    legalName: 'WISE PAYMENTS LIMITED',
    country: 'GB',
    kind: 'COMPANY',
    userId: 'USER-GB-BUYER',
    displayName: 'Anchor demo contracting representative',
    roles: ['company_member'],
    assuranceLevel: 'ENHANCED',
    credential: true,
  },
  {
    organizationId: 'ORG-GB-TALENT-2',
    legalName: 'Ada North Software Studio Ltd.',
    country: 'GB',
    kind: 'FREELANCER',
    userId: 'USER-GB-FREELANCER-2',
    displayName: 'London platform specialist',
    roles: ['freelancer'],
    assuranceLevel: 'BASIC',
    credential: true,
  },
  {
    organizationId: 'ORG-GB-TALENT-3',
    legalName: 'Caledonia Systems Consulting Ltd.',
    country: 'GB',
    kind: 'FREELANCER',
    userId: 'USER-GB-FREELANCER-3',
    displayName: 'Edinburgh distributed-systems engineer',
    roles: ['freelancer'],
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
    organizationId: 'ORG-DE-COMPANY',
    legalName: 'Rheinland Software GmbH',
    country: 'DE',
    kind: 'COMPANY',
    userId: 'USER-DE-BUYER',
    displayName: 'Cologne engineering lead',
    roles: ['company_member'],
    assuranceLevel: 'ENHANCED',
    credential: true,
  },
  {
    organizationId: 'ORG-DE-TALENT',
    legalName: 'Elbe Digital Engineering',
    country: 'DE',
    kind: 'FREELANCER',
    userId: 'USER-DE-FREELANCER',
    displayName: 'Hamburg contract engineer',
    roles: ['freelancer'],
    assuranceLevel: 'ENHANCED',
    credential: true,
  },
  {
    organizationId: 'ORG-RU-COMPANY',
    legalName: 'Northern Research Systems Demo',
    country: 'RU',
    kind: 'COMPANY',
    userId: 'USER-RU-BUYER',
    displayName: 'Russia demo company operator',
    roles: ['company_member'],
    assuranceLevel: 'ENHANCED',
    credential: true,
  },
  {
    organizationId: 'ORG-RU-TALENT',
    legalName: 'Northern Digital Services Demo',
    country: 'RU',
    kind: 'FREELANCER',
    userId: 'USER-RU-FREELANCER',
    displayName: 'Russia demo freelancer',
    roles: ['freelancer'],
    assuranceLevel: 'ENHANCED',
    credential: true,
  },
  {
    organizationId: 'ORG-KP-COMPANY',
    legalName: 'DPRK Blocked-Route Company Demo',
    country: 'KP',
    kind: 'COMPANY',
    userId: 'USER-KP-BUYER',
    displayName: 'DPRK blocked-route company',
    roles: ['company_member'],
    assuranceLevel: 'ENHANCED',
    credential: true,
  },
  {
    organizationId: 'ORG-KP-TALENT',
    legalName: 'DPRK Blocked-Route Freelancer Demo',
    country: 'KP',
    kind: 'FREELANCER',
    userId: 'USER-KP-FREELANCER',
    displayName: 'DPRK blocked-route freelancer',
    roles: ['freelancer'],
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

  const demoMandateId = 'CRM-GB-DEMO-001';
  if (!await context.store.findOne(companyRepresentativeMandates, { id: demoMandateId })) {
    await context.store.insert(companyRepresentativeMandates, {
      id: demoMandateId,
      organizationId: 'ORG-GB-COMPANY',
      subject: 'USER-GB-BUYER',
      representativeEmail: 'demo@anchor.dev',
      representativeRole: 'Anchor demo contracting representative',
      mandateReference: 'ANCHOR-DEMO-MANDATE-GB-001',
      authorityBasis: 'Tenant administrator approved this representative for the local demonstration.',
      status: 'ACTIVE',
      validFrom: new Date(now.getTime() - 86_400_000).toISOString(),
      validUntil: new Date(now.getTime() + 365 * 86_400_000).toISOString(),
      createdAt: now.toISOString(),
    });
  }

  const indianFreelancers = [
    seeded.get('ORG-IN-TALENT')!,
    seeded.get('ORG-IN-TALENT-2')!,
    seeded.get('ORG-IN-TALENT-3')!,
  ];
  const ukFreelancers = [
    seeded.get('ORG-GB-TALENT')!,
    seeded.get('ORG-GB-TALENT-2')!,
    seeded.get('ORG-GB-TALENT-3')!,
  ];
  return {
    polishCompany: seeded.get('ORG-PL-NOVA')!,
    polishFreelancer: seeded.get('ORG-PL-TALENT')!,
    indianFreelancer: indianFreelancers[0]!,
    indianFreelancers,
    indianCompany: seeded.get('ORG-IN-IMPORTER')!,
    ukCompany: seeded.get('ORG-GB-COMPANY')!,
    ukFreelancer: ukFreelancers[0]!,
    ukFreelancers,
    ukSupplier: seeded.get('ORG-GB-SUPPLIER')!,
    germanCompany: seeded.get('ORG-DE-COMPANY')!,
    germanFreelancer: seeded.get('ORG-DE-TALENT')!,
    russianCompany: seeded.get('ORG-RU-COMPANY')!,
    russianFreelancer: seeded.get('ORG-RU-TALENT')!,
    northKoreanCompany: seeded.get('ORG-KP-COMPANY')!,
    northKoreanFreelancer: seeded.get('ORG-KP-TALENT')!,
    providerOperator: seeded.get('ORG-OPTIWORK-OPS')!,
    platformAdmin: seeded.get('ORG-OPTIWORK-ADMIN')!,
    issuerDid: issuer.issuerDid,
  };
}
