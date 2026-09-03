import type { CorridorPolicy } from '@optiwork/contracts';

const RBI_SOURCE = 'https://rbi.org.in/Scripts/NotificationUser.aspx/upload/Scripts/NotificationUser.aspx?Id=12561';
const EU_SOURCE = 'https://eur-lex.europa.eu/eli/reg/2023/1113/oj';

export const corridorPolicies: readonly CorridorPolicy[] = [
  {
    id: 'PL-IN-INWARD-v1',
    originCountry: 'PL',
    destinationCountry: 'IN',
    direction: 'INWARD',
    status: 'ACTIVE',
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
  },
  {
    id: 'IN-GB-OUTWARD-v1',
    originCountry: 'IN',
    destinationCountry: 'GB',
    direction: 'OUTWARD',
    status: 'ACTIVE',
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
  },
  {
    id: 'PL-RU-BLOCKED-v1',
    originCountry: 'PL',
    destinationCountry: 'RU',
    direction: 'OUTWARD',
    status: 'BLOCKED',
    fundingCurrency: 'PLN',
    settlementCurrency: 'USD',
    payoutCurrency: 'RUB',
    requiredProviderCapabilities: [],
    dueDiligenceRules: [],
    requiredDocuments: [],
    purposeCodes: [],
    sourceUri: EU_SOURCE,
    sourceVersion: 'DEMO-SANCTIONS-POLICY-v1',
    effectiveAt: '2026-09-03T00:00:00.000Z',
  },
] as const;

export class CorridorResolutionError extends Error {
  constructor(readonly code: 'UNSUPPORTED_CORRIDOR' | 'BLOCKED_CORRIDOR', message: string) {
    super(message);
    this.name = 'CorridorResolutionError';
  }
}

export function resolveCorridor(originCountry: string, destinationCountry: string): CorridorPolicy {
  const policy = corridorPolicies.find(
    (candidate) => candidate.originCountry === originCountry && candidate.destinationCountry === destinationCountry,
  );
  if (!policy) throw new CorridorResolutionError('UNSUPPORTED_CORRIDOR', `Corridor ${originCountry}-${destinationCountry} is not configured.`);
  if (policy.status === 'BLOCKED') throw new CorridorResolutionError('BLOCKED_CORRIDOR', `Corridor ${originCountry}-${destinationCountry} is blocked by policy.`);
  return structuredClone(policy);
}
