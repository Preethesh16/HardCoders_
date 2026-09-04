/**
 * Company onboarding and login-time authorization.
 *
 * The registry proves the legal entity. PostgreSQL membership plus a recorded
 * mandate proves that this subject may act for the tenant. Those are separate
 * checks on purpose: public company data is never treated as login authority.
 */

import { canonicalHash } from '../canonical.js';
import type { AppContext } from '../context.js';
import {
  companyAuthorizationDecisions,
  companyRepresentativeMandates,
  companyVerificationProfiles,
  memberships,
  organizations,
} from '../db/schema.js';
import { forbidden, notFound, unprocessable } from '../errors.js';
import { requireOwnership, requireRole, type Principal } from '../auth/authorization.js';
import type { Select } from '../db/store.js';

export type CompanyVerificationProfile = Select<typeof companyVerificationProfiles>;
export type CompanyAuthorizationDecision = Select<typeof companyAuthorizationDecisions>;

export interface CompanyOnboardingInput {
  readonly legalName: string;
  readonly country: string;
  readonly registryAuthority: string;
  readonly registrationNumber: string;
  readonly lei?: string;
  readonly taxIdentifier?: string;
  readonly registeredAddress: string;
  readonly directors: readonly string[];
  readonly beneficialOwners: ReadonlyArray<{
    readonly name: string;
    readonly ownershipPercent?: number;
    readonly controlType: string;
  }>;
  readonly representativeEmail: string;
  readonly representativeRole: string;
  readonly authorityBasis: string;
  readonly mandateReference: string;
}

interface RegistryRecord {
  readonly legalName: string;
  readonly country: string;
  readonly registrationNumber: string;
  readonly entityStatus: string;
  readonly registeredAddress: string;
  readonly directors: readonly string[];
  readonly beneficialOwners: CompanyOnboardingInput['beneficialOwners'];
  readonly sourceRecords: CompanyVerificationProfile['sourceRecords'];
}

const COMPANY_HOUSE_SAMPLE = {
  legalName: 'WISE PAYMENTS LIMITED',
  country: 'GB',
  registrationNumber: '07209813',
  entityStatus: 'ACTIVE',
  registeredAddress: '1st Floor, Worship Square, 65 Clifton Street, London, England, EC2A 4JE',
  directors: ['Jane Fahey'],
  beneficialOwners: [{ name: 'Wise Financial Holdings Ltd', controlType: 'PERSON_WITH_SIGNIFICANT_CONTROL' }],
} as const;

const SANCTIONS_SOURCES = [
  {
    name: 'UK Sanctions List',
    uri: 'https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.csv',
  },
  {
    name: 'United Nations Security Council Consolidated List',
    uri: 'https://main.un.org/securitycouncil/en/content/un-sc-consolidated-list',
  },
  {
    name: 'EU Consolidated Financial Sanctions List',
    uri: 'https://data.europa.eu/data/datasets/consolidated-list-of-persons-groups-and-entities-subject-to-eu-financial-sanctions?locale=en',
  },
  {
    name: 'OFAC Sanctions List Service',
    uri: 'https://ofac.treasury.gov/sanctions-list-service',
  },
] as const;

function normalized(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/gu, '').replace(/[^a-zA-Z0-9]+/gu, ' ').trim().toUpperCase();
}

function titleCaseName(value: string): string {
  return value.toLowerCase().replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
}

function textContent(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style[\s\S]*?<\/style>/giu, ' ')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&amp;/gu, '&')
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/\s+/gu, ' ')
    .trim();
}

function capture(html: string, pattern: RegExp): string | undefined {
  const value = pattern.exec(html)?.[1];
  return value === undefined ? undefined : textContent(value);
}

async function getText(url: string, timeoutMs: number, headers: Record<string, string> = {}): Promise<string> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`Official source returned HTTP ${response.status}.`);
  return response.text();
}

async function gleifRecord(context: AppContext, input: CompanyOnboardingInput): Promise<RegistryRecord | null> {
  if (!input.lei) return null;
  const uri = `${context.config.companyVerification.gleifBaseUrl}/lei-records/${encodeURIComponent(input.lei)}`;
  if (context.config.companyVerification.mode === 'fixture') {
    if (input.lei !== '213800U4GNTXRFYZKG18') return null;
    const retrievedAt = context.clock.now().toISOString();
    return {
      ...COMPANY_HOUSE_SAMPLE,
      directors: [...COMPANY_HOUSE_SAMPLE.directors],
      beneficialOwners: [...COMPANY_HOUSE_SAMPLE.beneficialOwners],
      sourceRecords: [{
        source: 'GLEIF Golden Copy API',
        uri,
        retrievedAt,
        status: 'RECORDED_PUBLIC_SAMPLE',
        dataHash: canonicalHash({ ...COMPANY_HOUSE_SAMPLE, lei: input.lei, registrationStatus: 'ISSUED' }),
      }],
    };
  }
  const payload = JSON.parse(await getText(uri, context.config.companyVerification.timeoutMs, {
    accept: 'application/vnd.api+json',
  })) as Record<string, any>;
  const data = payload['data'];
  const entity = data?.attributes?.entity;
  const registration = data?.attributes?.registration;
  if (!entity?.legalName?.name || !entity?.legalAddress?.country || !entity?.registeredAs) {
    throw new Error('GLEIF returned an incomplete legal-entity record.');
  }
  const address = [
    ...(Array.isArray(entity.legalAddress.addressLines) ? entity.legalAddress.addressLines : []),
    entity.legalAddress.city,
    entity.legalAddress.country,
    entity.legalAddress.postalCode,
  ].filter(Boolean).join(', ');
  const retrievedAt = context.clock.now().toISOString();
  return {
    legalName: String(entity.legalName.name),
    country: String(entity.legalAddress.country),
    registrationNumber: String(entity.registeredAs),
    entityStatus: entity.status === 'ACTIVE' && registration?.status === 'ISSUED' ? 'ACTIVE' : String(entity.status ?? registration?.status ?? 'UNKNOWN'),
    registeredAddress: address,
    directors: input.directors,
    beneficialOwners: input.beneficialOwners,
    sourceRecords: [{
      source: 'GLEIF Golden Copy API',
      uri,
      retrievedAt,
      status: 'LIVE_FETCHED',
      dataHash: canonicalHash(data),
    }],
  };
}

async function companiesHouseRecord(context: AppContext, input: CompanyOnboardingInput): Promise<RegistryRecord | null> {
  if (input.country !== 'GB') return null;
  const base = context.config.companyVerification.companiesHouseBaseUrl.replace(/\/$/u, '');
  const publicUri = `${base}/company/${encodeURIComponent(input.registrationNumber)}`;
  const retrievedAt = context.clock.now().toISOString();

  if (context.config.companyVerification.mode === 'fixture') {
    if (input.registrationNumber !== COMPANY_HOUSE_SAMPLE.registrationNumber) return null;
    return {
      ...COMPANY_HOUSE_SAMPLE,
      directors: [...COMPANY_HOUSE_SAMPLE.directors],
      beneficialOwners: [...COMPANY_HOUSE_SAMPLE.beneficialOwners],
      sourceRecords: [{
        source: 'Companies House public register',
        uri: publicUri,
        retrievedAt,
        status: 'RECORDED_PUBLIC_SAMPLE',
        dataHash: canonicalHash(COMPANY_HOUSE_SAMPLE),
      }],
    };
  }

  const [profileHtml, officersHtml, pscHtml] = await Promise.all([
    getText(publicUri, context.config.companyVerification.timeoutMs),
    getText(`${publicUri}/officers`, context.config.companyVerification.timeoutMs),
    getText(`${publicUri}/persons-with-significant-control`, context.config.companyVerification.timeoutMs),
  ]);
  const legalName = capture(profileHtml, /<h1[^>]*class="heading-xlarge"[^>]*>([\s\S]*?)<\/h1>/iu);
  const status = capture(profileHtml, /id="company-status"[^>]*>([\s\S]*?)<\/dd>/iu);
  const address = capture(profileHtml, /id="content3"[\s\S]*?<dd[^>]*>([\s\S]*?)<\/dd>/iu)
    ?? capture(profileHtml, /Registered office address[\s\S]*?<dd[^>]*>([\s\S]*?)<\/dd>/iu);
  const directors = [...officersHtml.matchAll(/id="officer-name-\d+"[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/giu)]
    .map((match) => titleCaseName(textContent(match[1] ?? ''))).filter(Boolean);
  const beneficialOwners = [...pscHtml.matchAll(/id="psc-name-\d+"[\s\S]*?<b>([\s\S]*?)<\/b>/giu)]
    .map((match) => ({ name: textContent(match[1] ?? ''), controlType: 'PERSON_WITH_SIGNIFICANT_CONTROL' }));
  if (!legalName || !status) throw new Error('Companies House returned an incomplete public company record.');
  const snapshot = { legalName, status, address, directors, beneficialOwners };
  return {
    legalName,
    country: 'GB',
    registrationNumber: input.registrationNumber,
    entityStatus: status.toUpperCase(),
    registeredAddress: address ?? input.registeredAddress,
    directors,
    beneficialOwners,
    sourceRecords: [{
      source: 'Companies House public register',
      uri: publicUri,
      retrievedAt,
      status: 'LIVE_FETCHED',
      dataHash: canonicalHash(snapshot),
    }],
  };
}

async function screenSanctions(context: AppContext, names: readonly string[]) {
  const checkedAt = context.clock.now().toISOString();
  const potentialMatches: Array<{ query: string; list: string; score: number }> = [];
  const lists: Array<{ name: string; uri: string; checkedAt: string; status: string }> = [];
  for (const source of SANCTIONS_SOURCES) {
    if (context.config.companyVerification.mode === 'fixture') {
      lists.push({ ...source, checkedAt, status: 'RECORDED_OFFICIAL_SOURCE' });
      continue;
    }
    try {
      const body = await getText(source.uri, Math.min(context.config.companyVerification.timeoutMs, 4_000), {
        accept: 'text/csv,text/html,application/xml;q=0.9,*/*;q=0.5',
      });
      const normalizedBody = normalized(textContent(body));
      for (const name of names) {
        const query = normalized(name);
        if (query.length >= 8 && normalizedBody.includes(query)) {
          potentialMatches.push({ query: name, list: source.name, score: 100 });
        }
      }
      lists.push({ ...source, checkedAt, status: 'LIVE_FETCHED' });
    } catch {
      lists.push({ ...source, checkedAt, status: 'UNAVAILABLE' });
    }
  }
  return {
    outcome: potentialMatches.length > 0 ? 'POTENTIAL_MATCH' : 'CLEAR',
    screenedNames: [...names],
    lists,
    potentialMatches,
  };
}

export class CompanyAuthorizationService {
  constructor(private readonly context: AppContext) {}

  async latestProfile(principal: Principal): Promise<CompanyVerificationProfile | null> {
    requireRole(principal, 'company_member', 'platform_admin');
    const [latest] = await this.context.store.findMany(companyVerificationProfiles, {
      organizationId: principal.organizationId,
    }, { orderBy: 'version', direction: 'desc', limit: 1 });
    return latest ?? null;
  }

  async latestDecision(principal: Principal): Promise<CompanyAuthorizationDecision | null> {
    requireRole(principal, 'company_member', 'platform_admin');
    const [latest] = await this.context.store.findMany(companyAuthorizationDecisions, {
      organizationId: principal.organizationId,
      subject: principal.subject,
    }, { orderBy: 'decidedAt', direction: 'desc', limit: 1 });
    return latest ?? null;
  }

  async evaluate(principal: Principal, input: CompanyOnboardingInput): Promise<{
    profile: CompanyVerificationProfile;
    decision: CompanyAuthorizationDecision;
  }> {
    requireRole(principal, 'company_member');
    const organization = await this.context.store.findOne(organizations, { id: principal.organizationId });
    if (!organization) throw notFound(`Unknown organization ${principal.organizationId}.`);
    requireOwnership(principal, organization.id);
    if (input.country !== organization.country) {
      throw unprocessable('The company country must match the authenticated tenant organization.');
    }
    const membership = await this.context.store.findOne(memberships, {
      userId: principal.subject,
      organizationId: principal.organizationId,
    });
    if (!membership || membership.role !== 'company_member') {
      throw forbidden('The signed-in subject is not an approved company member.');
    }
    const mandate = await this.context.store.findOne(companyRepresentativeMandates, {
      organizationId: principal.organizationId,
      subject: principal.subject,
      mandateReference: input.mandateReference,
    });

    const registryResults: RegistryRecord[] = [];
    const registryErrors: string[] = [];
    for (const reader of [companiesHouseRecord, gleifRecord]) {
      try {
        const result = await reader(this.context, input);
        if (result) registryResults.push(result);
      } catch (error) {
        registryErrors.push(String((error as Error).message ?? error));
      }
    }
    const primaryRegistry = registryResults[0];
    const registryConsistent = registryResults.length > 0 && registryResults.every((result) => (
      normalized(result.legalName) === normalized(input.legalName)
      && result.country === input.country
      && result.registrationNumber === input.registrationNumber
    ));
    let registry: RegistryRecord | null = primaryRegistry === undefined ? null : {
      ...primaryRegistry,
      sourceRecords: registryResults.flatMap((result) => result.sourceRecords),
    };
    if (!registry) {
      registry = {
        legalName: input.legalName,
        country: input.country,
        registrationNumber: input.registrationNumber,
        entityStatus: 'UNVERIFIED',
        registeredAddress: input.registeredAddress,
        directors: input.directors,
        beneficialOwners: input.beneficialOwners,
        sourceRecords: [],
      };
    }

    const owners = registry.beneficialOwners.length > 0 ? registry.beneficialOwners : input.beneficialOwners;
    const directors = registry.directors.length > 0 ? registry.directors : input.directors;
    const screenedNames = [registry.legalName, ...directors, ...owners.map((owner) => owner.name)];
    const sanctionsScreening = await screenSanctions(this.context, screenedNames);
    const unavailableLists = sanctionsScreening.lists.filter((source) => source.status === 'UNAVAILABLE').length;
    const requireAllScreeningSources = this.context.config.profile !== 'demo';
    const checks = [
      {
        code: 'REGISTRY_IDENTITY',
        status: registryConsistent ? 'PASSED' : 'FAILED',
        detail: `Submitted legal name, country and registration number compared across ${registry.sourceRecords.length} official registry record(s).`,
      },
      {
        code: 'ENTITY_STATUS',
        status: registry.entityStatus === 'ACTIVE' ? 'PASSED' : 'FAILED',
        detail: `Registry status is ${registry.entityStatus}.`,
      },
      {
        code: 'OWNERSHIP_DISCLOSURE',
        status: owners.length > 0 ? 'PASSED' : 'REVIEW_REQUIRED',
        detail: owners.length > 0 ? `${owners.length} beneficial-owner/PSC record(s) will be screened.` : 'No beneficial-owner or PSC record was supplied or returned.',
      },
      {
        code: 'SANCTIONS_SCREENING',
        status: sanctionsScreening.outcome !== 'CLEAR'
          ? 'FAILED'
          : requireAllScreeningSources && unavailableLists > 0 ? 'REVIEW_REQUIRED' : 'PASSED',
        detail: `${screenedNames.length} party names checked across ${sanctionsScreening.lists.length} official list sources; ${unavailableLists} unavailable.`,
      },
      {
        code: 'TENANT_MEMBERSHIP',
        status: 'PASSED',
        detail: `The signed-in subject has the ${membership.role} tenant membership.`,
      },
      {
        code: 'REPRESENTATIVE_MANDATE',
        status: mandate
          && mandate.status === 'ACTIVE'
          && mandate.representativeEmail.toLowerCase() === input.representativeEmail.toLowerCase()
          && mandate.representativeRole === input.representativeRole
          && new Date(mandate.validFrom).getTime() <= this.context.clock.now().getTime()
          && new Date(mandate.validUntil).getTime() > this.context.clock.now().getTime()
          ? 'PASSED' : 'FAILED',
        detail: 'Public registry data was not used as representative authority; a pre-enrolled tenant mandate was matched by tenant, subject, reference, email, role, status and validity.',
      },
    ];
    const failed = checks.some((check) => check.status === 'FAILED');
    const review = checks.some((check) => check.status === 'REVIEW_REQUIRED');
    const verificationOutcome = failed ? 'BLOCKED' : review ? 'REVIEW_REQUIRED' : 'VERIFIED';
    const reasons = [
      ...checks.filter((check) => check.status !== 'PASSED').map((check) => `${check.code}: ${check.detail}`),
      ...registryErrors.map((message) => `REGISTRY_CONNECTOR: ${message}`),
      ...(unavailableLists > 0 ? [`SANCTIONS_SOURCE_AVAILABILITY: ${unavailableLists} source(s) were unavailable; the decision records this limitation.`] : []),
    ];
    const now = this.context.clock.now();
    const expiresAt = new Date(now.getTime() + this.context.config.companyVerification.decisionTtlSeconds * 1_000).toISOString();
    const prior = await this.context.store.findMany(companyVerificationProfiles, {
      organizationId: principal.organizationId,
    }, { orderBy: 'version', direction: 'desc', limit: 1 });
    const version = (prior[0]?.version ?? 0) + 1;
    const profileCore = {
      organizationId: principal.organizationId,
      version,
      legalName: registry.legalName,
      country: registry.country,
      registryAuthority: input.registryAuthority,
      registrationNumber: registry.registrationNumber,
      lei: input.lei?.trim() || null,
      taxIdentifier: input.taxIdentifier?.trim() || null,
      registeredAddress: registry.registeredAddress,
      entityStatus: registry.entityStatus,
      directors: [...directors],
      beneficialOwners: owners.map((owner) => ({ ...owner })),
      sourceRecords: registry.sourceRecords,
      sanctionsScreening,
      verificationOutcome,
      verificationReasons: reasons,
      verifiedAt: now.toISOString(),
      expiresAt,
    };
    const profile = await this.context.store.insert(companyVerificationProfiles, {
      id: this.context.ids.next('CVP'),
      ...profileCore,
      profileHash: canonicalHash(profileCore),
      createdAt: now.toISOString(),
    });
    const outcome = verificationOutcome === 'VERIFIED' ? 'AUTHORIZED' : verificationOutcome === 'BLOCKED' ? 'DENIED' : 'REVIEW_REQUIRED';
    const citations = [
      ...registry.sourceRecords.map((source) => ({ title: source.source, uri: source.uri, retrievedAt: source.retrievedAt })),
      ...sanctionsScreening.lists.map((source) => ({ title: source.name, uri: source.uri, retrievedAt: source.checkedAt })),
    ];
    const decisionCore = {
      organizationId: principal.organizationId,
      subject: principal.subject,
      profileId: profile.id,
      representativeEmail: input.representativeEmail,
      representativeRole: input.representativeRole,
      authorityBasis: mandate?.authorityBasis ?? input.authorityBasis,
      mandateReference: input.mandateReference,
      outcome,
      checks,
      citations,
      decidedAt: now.toISOString(),
      expiresAt,
    };
    const decision = await this.context.store.insert(companyAuthorizationDecisions, {
      id: this.context.ids.next('CAD'),
      ...decisionCore,
      decisionHash: canonicalHash(decisionCore),
    });
    if (decision.outcome === 'AUTHORIZED' && organization.legalName !== profile.legalName) {
      await this.context.store.update(organizations, { id: organization.id }, { legalName: profile.legalName });
    }
    await this.context.timeline.append({
      kind: 'COMPANY_LOGIN_AUTHORIZATION_EVALUATED',
      actor: { subject: principal.subject, role: principal.roles[0] ?? 'unknown' },
      detail: {
        organizationId: principal.organizationId,
        profileId: profile.id,
        profileHash: profile.profileHash,
        decisionHash: decision.decisionHash,
        outcome: decision.outcome,
      },
    });
    return { profile, decision };
  }
}
