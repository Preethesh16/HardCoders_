import type { CorridorPolicy } from '@optiwork/contracts';

const RBI_SOURCE = 'https://rbi.org.in/Scripts/NotificationUser.aspx/upload/Scripts/NotificationUser.aspx?Id=12561';
const EU_VAT_SOURCE = 'https://taxation-customs.ec.europa.eu/where-tax_en';
const EU_SANCTIONS_SOURCE = 'https://finance.ec.europa.eu/eu-and-world/sanctions-restrictive-measures/overview-sanctions-and-related-resources_en';
const EU_DPRK_SOURCE = 'https://www.consilium.europa.eu/en/policies/sanctions-against-north-korea/timeline-eu-sanctions-against-north-korea/';
const MATRIX_SOURCE = 'https://github.com/Preethesh16/Smart-Horizon/blob/main/docs/ARCHITECTURE_PLAN.md';

export const MATRIX_COUNTRIES = ['PL', 'IN', 'GB', 'DE', 'RU', 'KP'] as const;
export type MatrixCountry = typeof MATRIX_COUNTRIES[number];

export const MATRIX_CURRENCIES: Readonly<Record<MatrixCountry, string>> = {
  PL: 'PLN',
  IN: 'INR',
  GB: 'GBP',
  DE: 'EUR',
  RU: 'RUB',
  KP: 'KPW',
};

/**
 * The matrix is intentionally explicit. Adding a seventh country therefore
 * cannot silently create ten new payment routes with an inherited status.
 * DPRK always wins as BLOCKED; every Russia route is review-only; normal but
 * undeployed routes are review-only until both policy coverage and a provider
 * rail are deliberately added.
 */
const MATRIX_ROUTES = [
  ['PL', 'IN', 'ACTIVE'], ['PL', 'GB', 'ACTIVE'], ['PL', 'DE', 'ACTIVE'], ['PL', 'RU', 'MANUAL_REVIEW'], ['PL', 'KP', 'BLOCKED'],
  ['IN', 'PL', 'ACTIVE'], ['IN', 'GB', 'ACTIVE'], ['IN', 'DE', 'ACTIVE'], ['IN', 'RU', 'MANUAL_REVIEW'], ['IN', 'KP', 'BLOCKED'],
  ['GB', 'PL', 'ACTIVE'], ['GB', 'IN', 'ACTIVE'], ['GB', 'DE', 'ACTIVE'], ['GB', 'RU', 'MANUAL_REVIEW'], ['GB', 'KP', 'BLOCKED'],
  ['DE', 'PL', 'ACTIVE'], ['DE', 'IN', 'ACTIVE'], ['DE', 'GB', 'ACTIVE'], ['DE', 'RU', 'MANUAL_REVIEW'], ['DE', 'KP', 'BLOCKED'],
  ['RU', 'PL', 'MANUAL_REVIEW'], ['RU', 'IN', 'MANUAL_REVIEW'], ['RU', 'GB', 'MANUAL_REVIEW'], ['RU', 'DE', 'MANUAL_REVIEW'], ['RU', 'KP', 'BLOCKED'],
  ['KP', 'PL', 'BLOCKED'], ['KP', 'IN', 'BLOCKED'], ['KP', 'GB', 'BLOCKED'], ['KP', 'DE', 'BLOCKED'], ['KP', 'RU', 'BLOCKED'],
] as const satisfies readonly (readonly [MatrixCountry, MatrixCountry, CorridorPolicy['status']])[];

function directionFor(destinationCountry: MatrixCountry): CorridorPolicy['direction'] {
  return destinationCountry === 'IN' ? 'INWARD' : 'OUTWARD';
}

function genericPolicy(
  originCountry: MatrixCountry,
  destinationCountry: MatrixCountry,
  status: CorridorPolicy['status'],
): CorridorPolicy {
  const direction = directionFor(destinationCountry);
  const involvesIndia = originCountry === 'IN' || destinationCountry === 'IN';
  const involvesRussia = originCountry === 'RU' || destinationCountry === 'RU';
  const involvesDprk = originCountry === 'KP' || destinationCountry === 'KP';
  return {
    id: `${originCountry}-${destinationCountry}-${direction}-v1`,
    originCountry,
    destinationCountry,
    direction,
    status,
    fundingCurrency: MATRIX_CURRENCIES[originCountry],
    settlementCurrency: 'USD',
    payoutCurrency: MATRIX_CURRENCIES[destinationCountry],
    requiredProviderCapabilities: status === 'BLOCKED'
      ? []
      : status === 'ACTIVE'
        ? [`${originCountry}_ORIGIN_SETTLEMENT`, `${destinationCountry}_DESTINATION_SETTLEMENT`]
        : ['CORRIDOR_RAIL_DEPLOYMENT_REVIEW'],
    ...(involvesIndia ? { transactionCap: { amountMinor: '250000000', currency: 'INR', scale: 2 } } : {}),
    dueDiligenceRules: originCountry === 'IN' ? [{
      code: 'RBI_IMPORT_BUYER_DD',
      threshold: { amountMinor: '25000000', currency: 'INR', scale: 2 },
      appliesTo: 'BUYER',
      requiredDocuments: ['BUYER_DUE_DILIGENCE'],
      sourceSection: 'RBI PA-CB circular paragraph 4.4',
    }] : [],
    requiredDocuments: involvesDprk
      ? ['PRIOR_AUTHORIZATION']
      : involvesRussia
        ? ['SANCTIONS_SCREENING', 'BENEFICIARY_BANK_SCREENING', 'PAYMENT_PURPOSE_EVIDENCE']
        : destinationCountry === 'IN'
          ? ['INVOICE', 'SERVICE_EXPORT_DECLARATION', 'CORRIDOR_POLICY_REVIEW']
          : originCountry === 'IN'
            ? ['INVOICE', 'FORM_A2_DEMO', 'TAX_REVIEW_DEMO', 'IMPORT_EVIDENCE', 'CORRIDOR_POLICY_REVIEW']
            : ['CORRIDOR_POLICY_REVIEW'],
    purposeCodes: destinationCountry === 'IN'
      ? ['P0802']
      : originCountry === 'IN'
        ? ['S0102']
        : ['B2B_DIGITAL_SERVICES'],
    sourceUri: involvesDprk ? EU_DPRK_SOURCE : involvesRussia ? EU_SANCTIONS_SOURCE : involvesIndia ? RBI_SOURCE : MATRIX_SOURCE,
    sourceVersion: involvesDprk
      ? 'EU-DPRK-RESTRICTIONS-REVIEWED-2026-09-04'
      : involvesRussia
        ? 'SANCTIONS-CORRIDOR-REVIEW-REQUIRED-v1'
        : 'ANCHOR-CORRIDOR-MATRIX-v1',
    effectiveAt: '2026-09-04T00:00:00.000Z',
  };
}

function policyFor(
  originCountry: MatrixCountry,
  destinationCountry: MatrixCountry,
  status: CorridorPolicy['status'],
): CorridorPolicy {
  const pair = `${originCountry}-${destinationCountry}`;
  if (pair === 'PL-IN') return {
    id: 'PL-IN-INWARD-v1',
    originCountry: 'PL',
    destinationCountry: 'IN',
    direction: 'INWARD',
    status,
    fundingCurrency: 'PLN',
    settlementCurrency: 'USD',
    payoutCurrency: 'INR',
    requiredProviderCapabilities: ['EU_ORIGIN_FX', 'INDIA_PA_CB_INWARD'],
    transactionCap: { amountMinor: '250000000', currency: 'INR', scale: 2 },
    dueDiligenceRules: [],
    requiredDocuments: ['INVOICE', 'SERVICE_EXPORT_DECLARATION'],
    purposeCodes: ['P0802'],
    sourceUri: RBI_SOURCE,
    sourceVersion: 'RBI-PA-CB-2023-10-31',
    effectiveAt: '2023-10-31T00:00:00.000Z',
  };
  if (pair === 'IN-GB') return {
    id: 'IN-GB-OUTWARD-v1',
    originCountry: 'IN',
    destinationCountry: 'GB',
    direction: 'OUTWARD',
    status,
    fundingCurrency: 'INR',
    settlementCurrency: 'USD',
    payoutCurrency: 'GBP',
    requiredProviderCapabilities: ['INDIA_PA_CB_OUTWARD', 'UK_DESTINATION_OFFRAMP'],
    transactionCap: { amountMinor: '250000000', currency: 'INR', scale: 2 },
    dueDiligenceRules: [{
      code: 'RBI_IMPORT_BUYER_DD',
      threshold: { amountMinor: '25000000', currency: 'INR', scale: 2 },
      appliesTo: 'BUYER',
      requiredDocuments: ['BUYER_DUE_DILIGENCE'],
      sourceSection: 'RBI PA-CB circular paragraph 4.4',
    }],
    requiredDocuments: ['INVOICE', 'FORM_A2_DEMO', 'TAX_REVIEW_DEMO', 'IMPORT_EVIDENCE'],
    purposeCodes: ['S0102'],
    sourceUri: RBI_SOURCE,
    sourceVersion: 'RBI-PA-CB-2023-10-31',
    effectiveAt: '2023-10-31T00:00:00.000Z',
  };
  if (pair === 'PL-GB') return {
    id: 'PL-GB-OUTWARD-v1',
    originCountry: 'PL',
    destinationCountry: 'GB',
    direction: 'OUTWARD',
    status,
    fundingCurrency: 'PLN',
    settlementCurrency: 'USD',
    payoutCurrency: 'GBP',
    requiredProviderCapabilities: ['EU_ORIGIN_FX', 'UK_DESTINATION_OFFRAMP'],
    dueDiligenceRules: [],
    requiredDocuments: [
      'INVOICE',
      'B2B_CUSTOMER_STATUS',
      'SERVICE_PLACE_OF_SUPPLY_ASSESSMENT',
      'PAYER_PAYEE_TRANSFER_DATA',
    ],
    purposeCodes: ['B2B_DIGITAL_SERVICES'],
    sourceUri: EU_VAT_SOURCE,
    sourceVersion: 'EU-UK-B2B-SERVICES-REVIEWED-2026-09-04',
    effectiveAt: '2026-09-04T00:00:00.000Z',
  };
  if (pair === 'GB-IN') return {
    id: 'GB-IN-INWARD-v1',
    originCountry: 'GB',
    destinationCountry: 'IN',
    direction: 'INWARD',
    // The policy can be resolved for a selected deal, but settlement remains
    // held until a reviewed UK origin provider rail is deployed.
    status,
    fundingCurrency: 'GBP',
    settlementCurrency: 'USD',
    payoutCurrency: 'INR',
    requiredProviderCapabilities: ['UK_ORIGIN_FX', 'INDIA_PA_CB_INWARD'],
    transactionCap: { amountMinor: '250000000', currency: 'INR', scale: 2 },
    dueDiligenceRules: [],
    requiredDocuments: ['INVOICE', 'SERVICE_EXPORT_DECLARATION'],
    purposeCodes: ['P0802'],
    sourceUri: RBI_SOURCE,
    sourceVersion: 'RBI-PA-CB-2023-10-31',
    effectiveAt: '2023-10-31T00:00:00.000Z',
  };
  if (pair === 'DE-PL') return {
    id: 'DE-PL-EU-B2B-v1',
    originCountry: 'DE',
    destinationCountry: 'PL',
    direction: 'OUTWARD',
    status,
    fundingCurrency: 'EUR',
    settlementCurrency: 'USD',
    payoutCurrency: 'PLN',
    requiredProviderCapabilities: ['EU_B2B_SETTLEMENT_PREVIEW'],
    dueDiligenceRules: [],
    requiredDocuments: ['EU_VAT_IDS', 'B2B_SERVICE_CLASSIFICATION', 'REVERSE_CHARGE_INVOICE'],
    purposeCodes: ['B2B_DIGITAL_SERVICES'],
    sourceUri: EU_VAT_SOURCE,
    sourceVersion: 'EU-VAT-DIRECTIVE-ART44-196-v1',
    effectiveAt: '2026-09-04T00:00:00.000Z',
  };
  return genericPolicy(originCountry, destinationCountry, status);
}

export const corridorPolicies: readonly CorridorPolicy[] = MATRIX_ROUTES.map(
  ([originCountry, destinationCountry, status]) => policyFor(originCountry, destinationCountry, status),
);

const matrixKeys = new Set(corridorPolicies.map((policy) => `${policy.originCountry}-${policy.destinationCountry}`));
if (corridorPolicies.length !== 30 || matrixKeys.size !== 30) {
  throw new Error('The six-country corridor matrix must contain exactly 30 unique directed non-self pairs.');
}

export class CorridorResolutionError extends Error {
  constructor(readonly code: 'UNSUPPORTED_CORRIDOR' | 'BLOCKED_CORRIDOR', message: string) {
    super(message);
    this.name = 'CorridorResolutionError';
  }
}

/** Returns configured policy, including a policy that intentionally blocks settlement. */
export function findCorridorPolicy(originCountry: string, destinationCountry: string): CorridorPolicy {
  const policy = corridorPolicies.find(
    (candidate) => candidate.originCountry === originCountry && candidate.destinationCountry === destinationCountry,
  );
  if (!policy) throw new CorridorResolutionError('UNSUPPORTED_CORRIDOR', `Corridor ${originCountry}-${destinationCountry} is not configured.`);
  return structuredClone(policy);
}

/** Resolves only corridors that may proceed into the payment orchestration path. */
export function resolveCorridor(originCountry: string, destinationCountry: string): CorridorPolicy {
  const policy = findCorridorPolicy(originCountry, destinationCountry);
  if (policy.status === 'BLOCKED') throw new CorridorResolutionError('BLOCKED_CORRIDOR', `Corridor ${originCountry}-${destinationCountry} is blocked by policy.`);
  return policy;
}
