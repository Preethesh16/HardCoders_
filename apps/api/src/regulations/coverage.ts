import { APPROVED_REGULATION_SOURCES, approvedCorpusHash } from './catalog.js';
import type {
  ApprovedRegulationSource,
  RegulationCorridor,
  RegulationRefreshReport,
} from './types.js';
import { REGULATION_CORRIDOR_MATRIX } from './types.js';

export const REQUIRED_OBLIGATION_CATEGORIES = [
  'SANCTIONS_AML',
  'PAYMENT_CONTROLS',
  'TAX',
  'INVOICING_REPORTING',
  'PURPOSE',
] as const;

export type ObligationCategory = typeof REQUIRED_OBLIGATION_CATEGORIES[number];

export interface CoverageSourceReference {
  readonly sourceId: string;
  readonly sourceVersion: string;
  readonly chunkIds: readonly string[];
}

export interface ObligationCoverage {
  readonly category: ObligationCategory;
  readonly disposition?: 'COVERED' | 'MISSING' | 'BLOCKED';
  readonly rationale: string;
  readonly sourceReferences: readonly CoverageSourceReference[];
}

export interface CorridorCoverageProfile {
  readonly bookId: RegulationCorridor;
  readonly disposition: 'EXECUTABLE' | 'MANUAL_REVIEW' | 'BLOCKED';
  readonly dispositionReason?: string;
  readonly coverageVersion: string;
  readonly reviewedAt: string;
  readonly effectiveFrom: string;
  readonly reviewBy: string;
  readonly obligations: readonly ObligationCoverage[];
}

const reference = (
  sourceId: string,
  sourceVersion: string,
  ...chunkIds: readonly string[]
): CoverageSourceReference => ({ sourceId, sourceVersion, chunkIds });

const RBI_PA_CB = (chunks: readonly string[]): CoverageSourceReference =>
  reference('rbi-pa-cb-2023-10-31', 'RBI-2023-24-80', ...chunks);
const RBI_IMPORT = reference(
  'rbi-import-goods-services-2024-08-29',
  'RBI-FED-2016-17-12@2024-08-29',
  'rbi-import-introduction',
);
const INDIA_TAX = reference(
  'india-income-tax-form-15ca',
  'INCOME-TAX-FORM-15CA-OBSERVED-2026-09-04',
  'income-tax-15ca-purpose',
);
const EU_TFR = (chunks: readonly string[]): CoverageSourceReference => reference(
  'eu-transfer-of-funds-2023-1113',
  'CELEX-32023R1113@observed-2026-09-04',
  ...chunks,
);
const PL_AML = reference(
  'poland-aml-act-landing-2025-04-17',
  'PL-MOF-AML-LEGISLATION@2025-04-17',
  'poland-aml-act-status',
);
const PL_CESOP = reference(
  'poland-cesop-cross-border-payments',
  'PL-CESOP-PSP-2024',
  'poland-cesop-records',
);
const EU_VAT = reference(
  'eu-vat-place-of-supply',
  'EU-VAT-ARTICLES-44-45@2026-09-04',
  'eu-vat-b2b-place',
);
const EU_INVOICE = reference(
  'eu-vat-invoicing',
  'EU-VAT-INVOICING@2026-09-04',
  'eu-vat-reverse-charge-invoice',
);
const EU_SANCTIONS = reference(
  'eu-financial-sanctions-overview',
  'EU-FINANCIAL-SANCTIONS@2026-09-04',
  'eu-sanctions-listed-parties',
);
const EU_DPRK = reference(
  'eu-dprk-financial-restrictions',
  'EU-DPRK-SANCTIONS@2026-09-04',
  'eu-dprk-fund-transfer',
);
const UK_SANCTIONS = reference(
  'uk-financial-sanctions-guidance',
  'UK-OFSI-GENERAL-GUIDANCE@2026-05-12',
  'uk-ofsi-screening-scope',
);
const UK_PAYMENTS = reference(
  'uk-payment-services-conduct',
  'UK-FCA-PSR-CONDUCT@2026-09-04',
  'uk-psr-payment-information',
);
const UK_SERVICES_VAT = reference(
  'uk-vat-export-services',
  'UK-HMRC-VAT-NOTICE-741A@2022-09-29',
  'uk-services-place-of-supply',
);
const UK_INVOICE = reference(
  'uk-invoice-requirements',
  'UK-GOV-INVOICE-CONTENTS@2026-09-04',
  'uk-invoice-contents',
);
const UN_DPRK = reference(
  'un-security-council-dprk-1718',
  'UNSC-DPRK-1718@OBSERVED-2026-09-04',
  'un-dprk-assets-financial-measures',
);
const GERMANY_PAYMENTS = reference(
  'germany-payment-services-supervision',
  'BAFIN-ZAG-AUTHORISATION@2026-09-04',
  'bafin-zag-provider-boundary',
);
const RUSSIA_TRANSFERS = reference(
  'russia-cross-border-transfers-2026',
  'CBR-CROSS-BORDER-TRANSFERS@2026-09-04',
  'cbr-cross-border-current-controls',
);

const RUSSIA_BOOKS = [
  'PL-RU-OUTWARD', 'IN-RU-OUTWARD', 'GB-RU-OUTWARD', 'DE-RU-OUTWARD',
  'RU-PL-OUTWARD', 'RU-IN-INWARD', 'RU-GB-OUTWARD', 'RU-DE-OUTWARD',
] as const satisfies readonly RegulationCorridor[];

// The deterministic acceptance clock starts on 2026-09-03; profiles are
// effective for that run and must be re-reviewed within the declared window.
const REVIEWED_AT = '2026-09-03T00:00:00.000Z';
const REVIEW_BY = '2026-10-04T00:00:00.000Z';

const ADDITIONAL_EXECUTABLE_BOOKS = [
  'PL-DE-OUTWARD', 'IN-PL-OUTWARD', 'IN-DE-OUTWARD', 'GB-PL-OUTWARD',
  'GB-IN-INWARD', 'GB-DE-OUTWARD', 'DE-IN-INWARD', 'DE-GB-OUTWARD',
] as const satisfies readonly RegulationCorridor[];

function serviceCoverage(bookId: RegulationCorridor): readonly ObligationCoverage[] {
  const [origin, destination] = bookId.split('-');
  const hasEuMember = [origin, destination].some((country) => country === 'PL' || country === 'DE');
  const hasGermany = origin === 'DE' || destination === 'DE';
  const hasUk = origin === 'GB' || destination === 'GB';
  const indiaInward = destination === 'IN';
  const indiaOutward = origin === 'IN';
  const indiaAml = indiaInward
    ? RBI_PA_CB(['rbi-pa-cb-5.3-5.4'])
    : RBI_PA_CB(['rbi-pa-cb-4.3', 'rbi-pa-cb-4.4']);
  const indiaPurpose = indiaInward ? RBI_PA_CB(['rbi-pa-cb-5.3-5.4']) : RBI_IMPORT;
  const references = (category: ObligationCategory): readonly CoverageSourceReference[] => {
    const values: CoverageSourceReference[] = [];
    if (category === 'SANCTIONS_AML') {
      if (hasEuMember) values.push(EU_SANCTIONS, EU_TFR(['eu-tfr-article-4']));
      if (hasUk) values.push(UK_SANCTIONS);
      if (indiaInward || indiaOutward) values.push(indiaAml);
    } else if (category === 'PAYMENT_CONTROLS') {
      if (hasEuMember) values.push(EU_TFR(['eu-tfr-article-4']));
      if (hasGermany) values.push(GERMANY_PAYMENTS);
      if (hasUk) values.push(UK_PAYMENTS);
      if (indiaInward || indiaOutward) values.push(RBI_PA_CB(['rbi-pa-cb-6.1', 'rbi-pa-cb-8.2']));
    } else if (category === 'TAX') {
      if (hasEuMember) values.push(EU_VAT);
      if (hasUk) values.push(UK_SERVICES_VAT);
      if (indiaOutward) values.push(INDIA_TAX);
    } else if (category === 'INVOICING_REPORTING') {
      if (hasEuMember) values.push(EU_INVOICE);
      if (hasUk) values.push(UK_INVOICE);
      if (indiaInward || indiaOutward) values.push(RBI_PA_CB(['rbi-pa-cb-6.1']));
    } else {
      if (hasEuMember) values.push(EU_VAT);
      if (hasUk) values.push(UK_SERVICES_VAT);
      if (indiaInward || indiaOutward) values.push(indiaPurpose);
    }
    return values;
  };
  return REQUIRED_OBLIGATION_CATEGORIES.map((category) => ({
    category,
    rationale: `Reviewed ${category.toLowerCase().replaceAll('_', ' ')} controls for the selected B2B service route ${bookId}.`,
    sourceReferences: references(category),
  }));
}

function russiaReviewCoverage(bookId: RegulationCorridor): readonly ObligationCoverage[] {
  return REQUIRED_OBLIGATION_CATEGORIES.map((category) => ({
    category,
    rationale: category === 'SANCTIONS_AML'
      ? `Current party, ownership, beneficiary-bank and sanctions screening is required for ${bookId}.`
      : category === 'PAYMENT_CONTROLS'
        ? `Residency, counterparty, provider and temporary currency-control facts must be reviewed for ${bookId}.`
        : category === 'TAX'
          ? `The payer and payee tax treatment must be determined from the parties, service and treaty facts for ${bookId}.`
          : category === 'INVOICING_REPORTING'
            ? `The invoice, service evidence, payment purpose and currency-control records must be reviewed for ${bookId}.`
            : `The declared service, sector and payment purpose must be checked against current restrictions for ${bookId}.`,
    sourceReferences: category === 'SANCTIONS_AML' || category === 'PURPOSE'
      ? [RUSSIA_TRANSFERS, EU_SANCTIONS]
      : [RUSSIA_TRANSFERS],
  }));
}

/**
 * Coverage is scoped to Anchor's five demo obligation categories. It is not a
 * representation that every law applicable to either party has been encoded.
 */
const REVIEWED_COVERAGE_PROFILES: readonly CorridorCoverageProfile[] = [
  {
    bookId: 'PL-IN-INWARD',
    disposition: 'EXECUTABLE',
    coverageVersion: 'PL-IN-COVERAGE-2026-09-04',
    reviewedAt: REVIEWED_AT,
    effectiveFrom: '2026-09-03T00:00:00.000Z',
    reviewBy: REVIEW_BY,
    obligations: [
      { category: 'SANCTIONS_AML', rationale: 'Polish AML baseline and transfer traceability.', sourceReferences: [PL_AML, EU_TFR(['eu-tfr-article-4'])] },
      { category: 'PAYMENT_CONTROLS', rationale: 'EU transfer information and Indian PA-CB settlement controls.', sourceReferences: [EU_TFR(['eu-tfr-article-4']), RBI_PA_CB(['rbi-pa-cb-6.1', 'rbi-pa-cb-8.2'])] },
      { category: 'TAX', rationale: 'Polish PSP cross-border reporting coverage for the origin leg.', sourceReferences: [PL_CESOP] },
      { category: 'INVOICING_REPORTING', rationale: 'Cross-border PSP reporting and Indian export collection separation.', sourceReferences: [PL_CESOP, RBI_PA_CB(['rbi-pa-cb-6.1'])] },
      { category: 'PURPOSE', rationale: 'The reviewed corridor is limited to permissible exported services.', sourceReferences: [RBI_PA_CB(['rbi-pa-cb-8.2'])] },
    ],
  },
  {
    bookId: 'IN-GB-OUTWARD',
    disposition: 'EXECUTABLE',
    coverageVersion: 'IN-GB-COVERAGE-2026-09-04',
    reviewedAt: REVIEWED_AT,
    effectiveFrom: '2026-09-03T00:00:00.000Z',
    reviewBy: REVIEW_BY,
    obligations: [
      { category: 'SANCTIONS_AML', rationale: 'PA-CB merchant and threshold-triggered buyer due diligence.', sourceReferences: [RBI_PA_CB(['rbi-pa-cb-4.4'])] },
      { category: 'PAYMENT_CONTROLS', rationale: 'FEMA import-payment context and PA-CB value/account controls.', sourceReferences: [RBI_IMPORT, RBI_PA_CB(['rbi-pa-cb-6.1', 'rbi-pa-cb-8.2'])] },
      { category: 'TAX', rationale: 'Form 15CA/15CB applicability is held for the reviewed tax path.', sourceReferences: [INDIA_TAX] },
      { category: 'INVOICING_REPORTING', rationale: 'Import evidence and Authorised Dealer reporting context.', sourceReferences: [RBI_IMPORT] },
      { category: 'PURPOSE', rationale: 'The payment must be a permissible import of goods or services.', sourceReferences: [RBI_IMPORT] },
    ],
  },
  {
    bookId: 'PL-GB-OUTWARD',
    disposition: 'EXECUTABLE',
    coverageVersion: 'PL-GB-COVERAGE-2026-09-04',
    reviewedAt: REVIEWED_AT,
    effectiveFrom: '2026-09-04T00:00:00.000Z',
    reviewBy: REVIEW_BY,
    obligations: [
      { category: 'SANCTIONS_AML', rationale: 'Polish/EU origin screening and UK payee ownership/control screening.', sourceReferences: [PL_AML, EU_TFR(['eu-tfr-article-4']), EU_SANCTIONS, UK_SANCTIONS] },
      { category: 'PAYMENT_CONTROLS', rationale: 'EU transfer traceability and UK destination transaction-information controls.', sourceReferences: [EU_TFR(['eu-tfr-article-4']), UK_PAYMENTS] },
      { category: 'TAX', rationale: 'Polish PSP reporting and UK service place-of-supply assessment.', sourceReferences: [PL_CESOP, EU_VAT, UK_SERVICES_VAT] },
      { category: 'INVOICING_REPORTING', rationale: 'Polish PSP records and the UK service invoice evidence.', sourceReferences: [PL_CESOP, EU_INVOICE, UK_INVOICE] },
      { category: 'PURPOSE', rationale: 'The executable route is limited to the reviewed B2B digital-services scope.', sourceReferences: [EU_VAT, UK_SERVICES_VAT] },
    ],
  },
  ...ADDITIONAL_EXECUTABLE_BOOKS.map((bookId): CorridorCoverageProfile => ({
    bookId,
    disposition: 'EXECUTABLE',
    coverageVersion: `${bookId}-COVERAGE-2026-09-04`,
    reviewedAt: REVIEWED_AT,
    effectiveFrom: '2026-09-04T00:00:00.000Z',
    reviewBy: REVIEW_BY,
    obligations: serviceCoverage(bookId),
  })),
  {
    bookId: 'DE-PL-OUTWARD',
    disposition: 'EXECUTABLE',
    coverageVersion: 'DE-PL-COVERAGE-2026-09-04',
    reviewedAt: REVIEWED_AT,
    effectiveFrom: '2026-09-03T00:00:00.000Z',
    reviewBy: REVIEW_BY,
    obligations: [
      { category: 'SANCTIONS_AML', rationale: 'EU transfer traceability and Polish AML baseline.', sourceReferences: [EU_TFR(['eu-tfr-article-4']), PL_AML] },
      { category: 'PAYMENT_CONTROLS', rationale: 'EU payer/payee information requirements.', sourceReferences: [EU_TFR(['eu-tfr-article-4'])] },
      { category: 'TAX', rationale: 'B2B service place-of-supply analysis.', sourceReferences: [EU_VAT] },
      { category: 'INVOICING_REPORTING', rationale: 'VAT identifiers and reverse-charge invoice requirements.', sourceReferences: [EU_INVOICE] },
      { category: 'PURPOSE', rationale: 'The reviewed purpose is a B2B service under the stated VAT scope.', sourceReferences: [EU_VAT] },
    ],
  },
  ...RUSSIA_BOOKS.map((bookId): CorridorCoverageProfile => ({
    bookId,
    disposition: 'MANUAL_REVIEW',
    dispositionReason: 'Current Russian residency, counterparty, beneficiary-bank, sector, purpose and temporary-control facts require qualified human/provider review before FX or signing.',
    coverageVersion: `${bookId}-COVERAGE-2026-09-04`,
    reviewedAt: REVIEWED_AT,
    effectiveFrom: '2026-09-04T00:00:00.000Z',
    reviewBy: REVIEW_BY,
    obligations: russiaReviewCoverage(bookId),
  })),
  {
    bookId: 'PL-KP-OUTWARD',
    disposition: 'BLOCKED',
    coverageVersion: 'PL-KP-COVERAGE-2026-09-04',
    reviewedAt: REVIEWED_AT,
    effectiveFrom: '2026-09-03T00:00:00.000Z',
    reviewBy: REVIEW_BY,
    obligations: [
      { category: 'SANCTIONS_AML', disposition: 'BLOCKED', rationale: 'DPRK-specific UN and EU restrictions cannot be resolved by the demo.', sourceReferences: [UN_DPRK, EU_DPRK, PL_AML] },
      { category: 'PAYMENT_CONTROLS', disposition: 'BLOCKED', rationale: 'The demo has no competent-authority approval or sanctions-exemption path.', sourceReferences: [UN_DPRK, EU_DPRK, EU_TFR(['eu-tfr-article-4'])] },
      { category: 'TAX', disposition: 'BLOCKED', rationale: 'Tax analysis is not reached after the source-backed DPRK product gate closes.', sourceReferences: [UN_DPRK] },
      { category: 'INVOICING_REPORTING', disposition: 'BLOCKED', rationale: 'Reporting analysis is not reached after the source-backed DPRK product gate closes.', sourceReferences: [UN_DPRK] },
      { category: 'PURPOSE', disposition: 'BLOCKED', rationale: 'Anchor has no reviewed exemption workflow for a DPRK-related purpose.', sourceReferences: [UN_DPRK, EU_DPRK] },
    ],
  },
] as const;

const isDprkRoute = (bookId: RegulationCorridor): boolean => {
  const [origin, destination] = bookId.split('-');
  return origin === 'KP' || destination === 'KP';
};

const blockedDprkObligations = (bookId: RegulationCorridor): readonly ObligationCoverage[] =>
  REQUIRED_OBLIGATION_CATEGORIES.map((category) => {
    return {
      category,
      disposition: 'BLOCKED' as const,
      rationale: `Anchor blocks ${bookId} before ${category.toLowerCase().replaceAll('_', ' ')} processing because its demo has no designation, licensing or exemption workflow for the UN DPRK sanctions regime.`,
      sourceReferences: [UN_DPRK],
    };
  });

/** Exactly one explicit coverage profile for every ordered pair in the six-country matrix. */
export const CORRIDOR_COVERAGE_PROFILES: readonly CorridorCoverageProfile[] =
  REGULATION_CORRIDOR_MATRIX.map((bookId) => {
    const reviewed = REVIEWED_COVERAGE_PROFILES.find((profile) => profile.bookId === bookId);
    if (reviewed) return reviewed;
    if (!isDprkRoute(bookId)) {
      throw new Error(`Missing explicit reviewed corridor profile for ${bookId}`);
    }
    return {
      bookId,
      disposition: 'BLOCKED',
      coverageVersion: `${bookId}-COVERAGE-2026-09-04`,
      reviewedAt: REVIEWED_AT,
      effectiveFrom: '2026-09-04T00:00:00.000Z',
      reviewBy: REVIEW_BY,
      obligations: blockedDprkObligations(bookId),
    };
  });

export type CoverageCheckStatus =
  | 'COVERED'
  | 'BLOCKED'
  | 'MISSING'
  | 'STALE'
  | 'NOT_EFFECTIVE'
  | 'SOURCE_REVIEW_REQUIRED';

export interface ObligationCoverageCheck {
  readonly category: ObligationCategory;
  readonly status: CoverageCheckStatus;
  readonly sourceReferences: readonly CoverageSourceReference[];
  readonly reason: string;
}

export interface CorridorCoverageAssessment {
  readonly bookId: RegulationCorridor;
  readonly coverageVersion?: string;
  readonly reviewedAt?: string;
  readonly effectiveFrom?: string;
  readonly reviewBy?: string;
  readonly outcome: 'PASSED' | 'MANUAL_REVIEW' | 'BLOCKED';
  readonly hardGate: {
    readonly canQuoteOrFund: boolean;
    readonly code: 'REGULATORY_COVERAGE_PASSED' | 'MANUAL_REVIEW_REQUIRED' | 'REGULATORY_BLOCKED';
  };
  readonly checks: readonly ObligationCoverageCheck[];
  readonly reasons: readonly string[];
  readonly corpusHash: string;
  readonly deterministic: true;
  readonly approvedSourcesOnly: true;
}

export interface AssessCoverageInput {
  readonly bookId: RegulationCorridor;
  readonly evaluatedAt: Date;
  readonly refreshReport?: RegulationRefreshReport;
}

export interface AssessCoverageOptions {
  readonly profiles?: readonly CorridorCoverageProfile[];
  readonly sources?: readonly ApprovedRegulationSource[];
}

function sourceReferenceIssue(
  referenceValue: CoverageSourceReference,
  bookId: RegulationCorridor,
  sources: readonly ApprovedRegulationSource[],
): string | undefined {
  const source = sources.find((candidate) => candidate.id === referenceValue.sourceId);
  if (!source) return `Approved source ${referenceValue.sourceId} is missing.`;
  if (source.approvedVersion !== referenceValue.sourceVersion) {
    return `Source ${source.id} is pinned to ${referenceValue.sourceVersion}, but the corpus contains ${source.approvedVersion}.`;
  }
  for (const chunkId of referenceValue.chunkIds) {
    const chunk = source.chunks.find((candidate) => candidate.id === chunkId);
    if (!chunk) return `Approved source chunk ${source.id}/${chunkId} is missing.`;
    if (!chunk.appliesToBooks.includes(bookId)) {
      return `Approved source chunk ${source.id}/${chunkId} is not reviewed for ${bookId}.`;
    }
  }
  if (referenceValue.chunkIds.length === 0) return `Source ${source.id} does not identify a reviewed section.`;
  return undefined;
}

/**
 * Fail-safe precondition for compliance previews and payment creation.
 * A pass means only that Anchor's declared coverage is present and current.
 */
export function assessCorridorCoverage(
  input: AssessCoverageInput,
  options: AssessCoverageOptions = {},
): CorridorCoverageAssessment {
  const profiles = options.profiles ?? CORRIDOR_COVERAGE_PROFILES;
  const sources = options.sources ?? APPROVED_REGULATION_SOURCES;
  const profile = profiles.find((candidate) => candidate.bookId === input.bookId);
  const corpusHash = approvedCorpusHash(sources);
  const changedSources = new Set(input.refreshReport?.observations
    .filter((observation) => observation.status === 'REVIEW_REQUIRED')
    .map((observation) => observation.sourceId) ?? []);

  if (!profile) {
    const checks = REQUIRED_OBLIGATION_CATEGORIES.map((category) => ({
      category,
      status: 'MISSING' as const,
      sourceReferences: [],
      reason: `No reviewed ${category} coverage is declared for ${input.bookId}.`,
    }));
    return {
      bookId: input.bookId,
      outcome: 'MANUAL_REVIEW',
      hardGate: { canQuoteOrFund: false, code: 'MANUAL_REVIEW_REQUIRED' },
      checks,
      reasons: checks.map((check) => check.reason),
      corpusHash,
      deterministic: true,
      approvedSourcesOnly: true,
    };
  }

  const evaluatedAt = input.evaluatedAt.getTime();
  const reviewedAt = Date.parse(profile.reviewedAt);
  const effectiveAt = Date.parse(profile.effectiveFrom);
  const reviewBy = Date.parse(profile.reviewBy);
  const invalidMetadata = ![evaluatedAt, reviewedAt, effectiveAt, reviewBy].every(Number.isFinite)
    || reviewBy <= reviewedAt;
  const refreshCorpusMismatch = input.refreshReport !== undefined
    && input.refreshReport.approvedCorpusHash !== corpusHash;
  const checks = REQUIRED_OBLIGATION_CATEGORIES.map((category): ObligationCoverageCheck => {
    const obligation = profile.obligations.find((candidate) => candidate.category === category);
    if (!obligation) {
      return { category, status: 'MISSING', sourceReferences: [], reason: `${category} coverage is not declared.` };
    }
    if (invalidMetadata) {
      return { category, status: 'MISSING', sourceReferences: obligation.sourceReferences, reason: `${category} coverage has invalid reviewed/effective metadata.` };
    }
    if (refreshCorpusMismatch) {
      return { category, status: 'SOURCE_REVIEW_REQUIRED', sourceReferences: obligation.sourceReferences, reason: `${category} refresh evidence was generated from a different approved corpus.` };
    }
    if (evaluatedAt < effectiveAt) {
      return { category, status: 'NOT_EFFECTIVE', sourceReferences: obligation.sourceReferences, reason: `${category} coverage is not effective until ${profile.effectiveFrom}.` };
    }
    if (evaluatedAt >= reviewBy) {
      return { category, status: 'STALE', sourceReferences: obligation.sourceReferences, reason: `${category} coverage reached its review deadline ${profile.reviewBy}.` };
    }
    if (obligation.disposition === 'MISSING') {
      return { category, status: 'MISSING', sourceReferences: obligation.sourceReferences, reason: obligation.rationale };
    }
    const issue = obligation.sourceReferences
      .map((sourceReference) => sourceReferenceIssue(sourceReference, input.bookId, sources))
      .find((candidate) => candidate !== undefined);
    if (issue !== undefined) {
      return { category, status: 'MISSING', sourceReferences: obligation.sourceReferences, reason: issue };
    }
    const pendingSource = obligation.sourceReferences.find((sourceReference) => changedSources.has(sourceReference.sourceId));
    if (pendingSource) {
      return {
        category,
        status: 'SOURCE_REVIEW_REQUIRED',
        sourceReferences: obligation.sourceReferences,
        reason: `${pendingSource.sourceId} has an observed change awaiting human approval.`,
      };
    }
    if (obligation.disposition === 'BLOCKED') {
      return { category, status: 'BLOCKED', sourceReferences: obligation.sourceReferences, reason: obligation.rationale };
    }
    return { category, status: 'COVERED', sourceReferences: obligation.sourceReferences, reason: obligation.rationale };
  });
  const reasons = checks.filter((check) => check.status !== 'COVERED').map((check) => check.reason);
  if (profile.disposition === 'MANUAL_REVIEW' && profile.dispositionReason !== undefined) {
    reasons.push(profile.dispositionReason);
  }
  const outcome: CorridorCoverageAssessment['outcome'] = profile.disposition === 'BLOCKED'
    || checks.some((check) => check.status === 'BLOCKED')
    ? 'BLOCKED'
    : profile.disposition === 'MANUAL_REVIEW' || reasons.length > 0 ? 'MANUAL_REVIEW' : 'PASSED';
  return {
    bookId: input.bookId,
    coverageVersion: profile.coverageVersion,
    reviewedAt: profile.reviewedAt,
    effectiveFrom: profile.effectiveFrom,
    reviewBy: profile.reviewBy,
    outcome,
    hardGate: {
      canQuoteOrFund: outcome === 'PASSED',
      code: outcome === 'PASSED'
        ? 'REGULATORY_COVERAGE_PASSED'
        : outcome === 'BLOCKED' ? 'REGULATORY_BLOCKED' : 'MANUAL_REVIEW_REQUIRED',
    },
    checks,
    reasons,
    corpusHash,
    deterministic: true,
    approvedSourcesOnly: true,
  };
}

/** Never downgrades an existing BLOCKED decision. */
export function applyCoverageOutcome(
  current: 'PASSED' | 'MANUAL_REVIEW' | 'BLOCKED',
  coverage: CorridorCoverageAssessment,
): 'PASSED' | 'MANUAL_REVIEW' | 'BLOCKED' {
  if (current === 'BLOCKED') return current;
  if (coverage.outcome === 'BLOCKED') return 'BLOCKED';
  return coverage.outcome === 'MANUAL_REVIEW' ? 'MANUAL_REVIEW' : current;
}
