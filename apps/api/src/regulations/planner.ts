import { canonicalHash } from '../canonical.js';
import { APPROVED_REGULATION_SOURCES, approvedCorpusHash } from './catalog.js';
import {
  REQUIRED_OBLIGATION_CATEGORIES,
  type CoverageSourceReference,
  type ObligationCategory,
} from './coverage.js';
import type { ApprovedRegulationSource, RegulationRefreshReport } from './types.js';
import { refreshOfficialRegulations } from './refresh.js';

export type RegulatoryPartyType = 'COMPANY' | 'FREELANCER' | 'SUPPLIER' | 'INDIVIDUAL' | 'PROVIDER';
export type RegulatoryDirection = 'INWARD' | 'OUTWARD';
export type RegulatoryPurposeType = 'SERVICES' | 'GOODS';

export interface DealRegulatoryFacts {
  readonly originCountry: string;
  readonly destinationCountry: string;
  readonly direction: RegulatoryDirection;
  readonly purposeCode: string;
  readonly purposeType: RegulatoryPurposeType;
  readonly originPartyType: RegulatoryPartyType;
  readonly destinationPartyType: RegulatoryPartyType;
  readonly evaluatedAt: Date;
  readonly refreshReport?: RegulationRefreshReport;
}

interface ModuleSelector {
  readonly originCountries?: readonly string[];
  readonly destinationCountries?: readonly string[];
  readonly directions?: readonly RegulatoryDirection[];
  readonly purposeCodes?: readonly string[];
  readonly purposeTypes?: readonly RegulatoryPurposeType[];
  readonly originPartyTypes?: readonly RegulatoryPartyType[];
  readonly destinationPartyTypes?: readonly RegulatoryPartyType[];
}

export interface RegulatoryObligationModule {
  readonly id: string;
  readonly version: string;
  readonly jurisdiction: string;
  readonly category: ObligationCategory;
  readonly reviewedAt: string;
  readonly effectiveFrom: string;
  readonly reviewBy: string;
  readonly selector: ModuleSelector;
  readonly disposition: 'COVERED' | 'MANUAL_REVIEW' | 'BLOCKED';
  readonly controlCode: string;
  readonly responsibleParty: 'ORIGIN' | 'DESTINATION' | 'PROVIDER' | 'BOTH' | 'HUMAN_REVIEW';
  readonly requiredDocuments: readonly string[];
  readonly requirement: string;
  readonly sourceReferences: readonly CoverageSourceReference[];
}

const reference = (sourceId: string, sourceVersion: string, ...chunkIds: readonly string[]): CoverageSourceReference =>
  ({ sourceId, sourceVersion, chunkIds });
const RBI_PA_CB = (...chunks: readonly string[]): CoverageSourceReference =>
  reference('rbi-pa-cb-2023-10-31', 'RBI-2023-24-80', ...chunks);
const RBI_IMPORT = reference('rbi-import-goods-services-2024-08-29', 'RBI-FED-2016-17-12@2024-08-29', 'rbi-import-introduction');
const INDIA_TAX = reference('india-income-tax-form-15ca', 'INCOME-TAX-FORM-15CA-OBSERVED-2026-09-04', 'income-tax-15ca-purpose');
const UK_SANCTIONS = reference('uk-financial-sanctions-guidance', 'UK-OFSI-GENERAL-GUIDANCE@2026-05-12', 'uk-ofsi-screening-scope');
const UK_PAYMENTS = reference('uk-payment-services-conduct', 'UK-FCA-PSR-CONDUCT@2026-09-04', 'uk-psr-payment-information');
const UK_GOODS_VAT = reference('uk-vat-export-goods', 'UK-HMRC-VAT-EXPORT-GOODS@2020-12-31', 'uk-vat-export-evidence');
const UK_EXPORT = reference('uk-export-declaration', 'UK-HMRC-EXPORT-DECLARATION@2024-03-04', 'uk-export-declaration-evidence');
const UK_SERVICES_VAT = reference('uk-vat-export-services', 'UK-HMRC-VAT-NOTICE-741A@2022-09-29', 'uk-services-place-of-supply');
const UK_INVOICE = reference('uk-invoice-requirements', 'UK-GOV-INVOICE-CONTENTS@2026-09-04', 'uk-invoice-contents');
const EU_TFR = reference('eu-transfer-of-funds-2023-1113', 'CELEX-32023R1113@observed-2026-09-04', 'eu-tfr-article-4');
const PL_AML = reference('poland-aml-act-landing-2025-04-17', 'PL-MOF-AML-LEGISLATION@2025-04-17', 'poland-aml-act-status');
const PL_CESOP = reference('poland-cesop-cross-border-payments', 'PL-CESOP-PSP-2024', 'poland-cesop-records');
const EU_VAT = reference('eu-vat-place-of-supply', 'EU-VAT-ARTICLES-44-45@2026-09-04', 'eu-vat-b2b-place');
const EU_INVOICE = reference('eu-vat-invoicing', 'EU-VAT-INVOICING@2026-09-04', 'eu-vat-reverse-charge-invoice');
const EU_SANCTIONS = reference('eu-financial-sanctions-overview', 'EU-FINANCIAL-SANCTIONS@2026-09-04', 'eu-sanctions-listed-parties');
const EU_DPRK = reference('eu-dprk-financial-restrictions', 'EU-DPRK-SANCTIONS@2026-09-04', 'eu-dprk-fund-transfer');
const UN_DPRK = reference('un-security-council-dprk-1718', 'UNSC-DPRK-1718@OBSERVED-2026-09-04', 'un-dprk-assets-financial-measures');
const GERMANY_PAYMENTS = reference('germany-payment-services-supervision', 'BAFIN-ZAG-AUTHORISATION@2026-09-04', 'bafin-zag-provider-boundary');
const RUSSIA_TRANSFERS = reference('russia-cross-border-transfers-2026', 'CBR-CROSS-BORDER-TRANSFERS@2026-09-04', 'cbr-cross-border-current-controls');

const REVIEW = {
  reviewedAt: '2026-09-03T00:00:00.000Z',
  effectiveFrom: '2026-09-03T00:00:00.000Z',
  reviewBy: '2026-10-04T00:00:00.000Z',
} as const;
const BUSINESS = ['COMPANY', 'PROVIDER'] as const;
const PAYEE = ['COMPANY', 'FREELANCER', 'SUPPLIER', 'PROVIDER'] as const;
const DEPLOYED_EXECUTABLE_BOOKS = new Set([
  'PL-IN-INWARD', 'PL-GB-OUTWARD', 'PL-DE-OUTWARD',
  'IN-PL-OUTWARD', 'IN-GB-OUTWARD', 'IN-DE-OUTWARD',
  'GB-PL-OUTWARD', 'GB-IN-INWARD', 'GB-DE-OUTWARD',
  'DE-PL-OUTWARD', 'DE-IN-INWARD', 'DE-GB-OUTWARD',
]);

const STANDARD_DOCUMENTS: Readonly<Record<ObligationCategory, readonly string[]>> = {
  SANCTIONS_AML: ['PARTY_AND_OWNERSHIP_SCREENING'],
  PAYMENT_CONTROLS: ['PAYER_PAYEE_TRANSFER_DATA'],
  TAX: ['B2B_SERVICE_TAX_ASSESSMENT'],
  INVOICING_REPORTING: ['INVOICE'],
  PURPOSE: ['B2B_SERVICE_CLASSIFICATION'],
};

function moduleSet(args: {
  prefix: string;
  jurisdiction: string;
  selector: ModuleSelector;
  disposition: RegulatoryObligationModule['disposition'];
  responsibleParty: RegulatoryObligationModule['responsibleParty'];
  sources: Readonly<Record<ObligationCategory, readonly CoverageSourceReference[]>>;
}): readonly RegulatoryObligationModule[] {
  return REQUIRED_OBLIGATION_CATEGORIES.map((category) => ({
    id: `${args.prefix}-${category.toLowerCase().replaceAll('_', '-')}`,
    version: 'v1',
    jurisdiction: args.jurisdiction,
    category,
    ...REVIEW,
    selector: args.selector,
    disposition: args.disposition,
    controlCode: `${args.prefix}_${category}`.toUpperCase().replaceAll('-', '_'),
    responsibleParty: args.responsibleParty,
    requiredDocuments: STANDARD_DOCUMENTS[category],
    requirement: args.disposition === 'COVERED'
      ? `Apply the reviewed ${args.jurisdiction} ${category.toLowerCase().replaceAll('_', ' ')} control for this B2B service payment.`
      : `Require current human review of ${args.jurisdiction} ${category.toLowerCase().replaceAll('_', ' ')} obligations before any quote or settlement.`,
    sourceReferences: args.sources[category],
  }));
}

const EU_SERVICE_SOURCES: Readonly<Record<ObligationCategory, readonly CoverageSourceReference[]>> = {
  SANCTIONS_AML: [EU_SANCTIONS, EU_TFR],
  PAYMENT_CONTROLS: [EU_TFR],
  TAX: [EU_VAT],
  INVOICING_REPORTING: [EU_INVOICE],
  PURPOSE: [EU_VAT],
};
const GERMANY_SERVICE_SOURCES: Readonly<Record<ObligationCategory, readonly CoverageSourceReference[]>> = {
  ...EU_SERVICE_SOURCES,
  PAYMENT_CONTROLS: [GERMANY_PAYMENTS, EU_TFR],
};
const UK_SERVICE_SOURCES: Readonly<Record<ObligationCategory, readonly CoverageSourceReference[]>> = {
  SANCTIONS_AML: [UK_SANCTIONS],
  PAYMENT_CONTROLS: [UK_PAYMENTS],
  TAX: [UK_SERVICES_VAT],
  INVOICING_REPORTING: [UK_INVOICE],
  PURPOSE: [UK_SERVICES_VAT],
};
const RUSSIA_REVIEW_SOURCES: Readonly<Record<ObligationCategory, readonly CoverageSourceReference[]>> = {
  SANCTIONS_AML: [RUSSIA_TRANSFERS, EU_SANCTIONS],
  PAYMENT_CONTROLS: [RUSSIA_TRANSFERS],
  TAX: [RUSSIA_TRANSFERS],
  INVOICING_REPORTING: [RUSSIA_TRANSFERS],
  PURPOSE: [RUSSIA_TRANSFERS, EU_SANCTIONS],
};

/**
 * Modules are independently matched and composed. Their scope is deliberately
 * narrow: an absent module is a review hold, never an inferred permission.
 */
export const REGULATORY_OBLIGATION_MODULES: readonly RegulatoryObligationModule[] = [
  ...moduleSet({
    prefix: 'germany-origin', jurisdiction: 'DE',
    selector: { originCountries: ['DE'], destinationCountries: ['PL', 'IN', 'GB', 'RU'], purposeTypes: ['SERVICES'], originPartyTypes: BUSINESS },
    disposition: 'COVERED', responsibleParty: 'ORIGIN', sources: GERMANY_SERVICE_SOURCES,
  }),
  ...moduleSet({
    prefix: 'poland-destination', jurisdiction: 'PL',
    selector: { originCountries: ['IN', 'GB', 'DE', 'RU'], destinationCountries: ['PL'], purposeTypes: ['SERVICES'], destinationPartyTypes: PAYEE },
    disposition: 'COVERED', responsibleParty: 'DESTINATION', sources: EU_SERVICE_SOURCES,
  }),
  ...moduleSet({
    prefix: 'germany-destination', jurisdiction: 'DE',
    selector: { originCountries: ['PL', 'IN', 'GB', 'RU'], destinationCountries: ['DE'], purposeTypes: ['SERVICES'], destinationPartyTypes: PAYEE },
    disposition: 'COVERED', responsibleParty: 'DESTINATION', sources: GERMANY_SERVICE_SOURCES,
  }),
  ...moduleSet({
    prefix: 'uk-origin', jurisdiction: 'GB',
    selector: { originCountries: ['GB'], destinationCountries: ['PL', 'IN', 'DE', 'RU'], purposeTypes: ['SERVICES'], originPartyTypes: BUSINESS },
    disposition: 'COVERED', responsibleParty: 'ORIGIN', sources: UK_SERVICE_SOURCES,
  }),
  ...moduleSet({
    prefix: 'russia-origin-review', jurisdiction: 'RU',
    selector: { originCountries: ['RU'] },
    disposition: 'MANUAL_REVIEW', responsibleParty: 'HUMAN_REVIEW', sources: RUSSIA_REVIEW_SOURCES,
  }),
  ...moduleSet({
    prefix: 'russia-destination-review', jurisdiction: 'RU',
    selector: { destinationCountries: ['RU'] },
    disposition: 'MANUAL_REVIEW', responsibleParty: 'HUMAN_REVIEW', sources: RUSSIA_REVIEW_SOURCES,
  }),
  {
    id: 'india-export-aml', version: 'v1', jurisdiction: 'IN', category: 'SANCTIONS_AML', ...REVIEW,
    selector: { destinationCountries: ['IN'], directions: ['INWARD'], destinationPartyTypes: PAYEE },
    disposition: 'COVERED', requirement: 'CDD the Indian merchant and screen restricted or prohibited trade.',
    controlCode: 'INDIA_EXPORT_MERCHANT_CDD', responsibleParty: 'PROVIDER', requiredDocuments: ['INDIA_MERCHANT_CDD', 'RESTRICTED_TRADE_SCREENING'],
    sourceReferences: [RBI_PA_CB('rbi-pa-cb-5.3-5.4')],
  },
  {
    id: 'india-export-payment-controls', version: 'v1', jurisdiction: 'IN', category: 'PAYMENT_CONTROLS', ...REVIEW,
    selector: { destinationCountries: ['IN'], directions: ['INWARD'] },
    disposition: 'COVERED', requirement: 'Use the export collection account path and enforce the PA-CB per-unit ceiling.',
    controlCode: 'INDIA_EXPORT_COLLECTION_CONTROL', responsibleParty: 'PROVIDER', requiredDocuments: [],
    sourceReferences: [RBI_PA_CB('rbi-pa-cb-6.1', 'rbi-pa-cb-8.2')],
  },
  {
    id: 'india-export-invoicing', version: 'v1', jurisdiction: 'IN', category: 'INVOICING_REPORTING', ...REVIEW,
    selector: { destinationCountries: ['IN'], directions: ['INWARD'] },
    disposition: 'COVERED', requirement: 'Retain the commercial/export evidence used for collection and reconciliation.',
    controlCode: 'INDIA_EXPORT_EVIDENCE', responsibleParty: 'DESTINATION', requiredDocuments: ['INVOICE', 'SERVICE_EXPORT_DECLARATION'],
    sourceReferences: [RBI_PA_CB('rbi-pa-cb-5.3-5.4', 'rbi-pa-cb-6.1')],
  },
  {
    id: 'india-export-purpose', version: 'v1', jurisdiction: 'IN', category: 'PURPOSE', ...REVIEW,
    selector: { destinationCountries: ['IN'], directions: ['INWARD'], purposeCodes: ['P0802'], purposeTypes: ['SERVICES'] },
    disposition: 'COVERED', requirement: 'Treat the deal as a reviewed permissible service-export receipt.',
    controlCode: 'INDIA_EXPORT_PURPOSE', responsibleParty: 'BOTH', requiredDocuments: ['PURPOSE_CODE_P0802'],
    sourceReferences: [RBI_PA_CB('rbi-pa-cb-5.3-5.4')],
  },
  {
    id: 'india-import-aml', version: 'v1', jurisdiction: 'IN', category: 'SANCTIONS_AML', ...REVIEW,
    selector: { originCountries: ['IN'], directions: ['OUTWARD'], originPartyTypes: BUSINESS },
    disposition: 'COVERED', requirement: 'CDD the foreign merchant, screen prohibited trade and apply buyer CDD when triggered.',
    controlCode: 'INDIA_IMPORT_DUE_DILIGENCE', responsibleParty: 'PROVIDER', requiredDocuments: ['FOREIGN_MERCHANT_CDD', 'BUYER_DUE_DILIGENCE_CONDITIONAL', 'RESTRICTED_TRADE_SCREENING'],
    sourceReferences: [RBI_PA_CB('rbi-pa-cb-4.3', 'rbi-pa-cb-4.4')],
  },
  {
    id: 'india-import-payment-controls', version: 'v1', jurisdiction: 'IN', category: 'PAYMENT_CONTROLS', ...REVIEW,
    selector: { originCountries: ['IN'], directions: ['OUTWARD'] },
    disposition: 'COVERED', requirement: 'Use the FEMA/Authorised Dealer import-payment path and PA-CB value controls.',
    controlCode: 'INDIA_IMPORT_PAYMENT_CONTROL', responsibleParty: 'PROVIDER', requiredDocuments: ['AUTHORISED_DEALER_REVIEW', 'FORM_A2_DEMO'],
    sourceReferences: [RBI_IMPORT, RBI_PA_CB('rbi-pa-cb-6.1', 'rbi-pa-cb-8.2')],
  },
  {
    id: 'india-outward-tax', version: 'v1', jurisdiction: 'IN', category: 'TAX', ...REVIEW,
    selector: { originCountries: ['IN'], directions: ['OUTWARD'], originPartyTypes: BUSINESS },
    disposition: 'COVERED', requirement: 'Determine the applicable Form 15CA/15CB and tax-review path before remittance.',
    controlCode: 'INDIA_OUTWARD_TAX_REVIEW', responsibleParty: 'ORIGIN', requiredDocuments: ['TAX_REVIEW_DEMO', 'FORM_15CA_CONDITIONAL', 'FORM_15CB_CONDITIONAL'],
    sourceReferences: [INDIA_TAX],
  },
  {
    id: 'india-import-invoicing', version: 'v1', jurisdiction: 'IN', category: 'INVOICING_REPORTING', ...REVIEW,
    selector: { originCountries: ['IN'], directions: ['OUTWARD'] },
    disposition: 'COVERED', requirement: 'Retain invoice/import evidence and Authorised Dealer reporting context.',
    controlCode: 'INDIA_IMPORT_EVIDENCE', responsibleParty: 'ORIGIN', requiredDocuments: ['INVOICE', 'IMPORT_EVIDENCE'],
    sourceReferences: [RBI_IMPORT],
  },
  {
    id: 'india-import-purpose', version: 'v1', jurisdiction: 'IN', category: 'PURPOSE', ...REVIEW,
    selector: { originCountries: ['IN'], directions: ['OUTWARD'], purposeCodes: ['S0102'], purposeTypes: ['GOODS', 'SERVICES'] },
    disposition: 'COVERED', requirement: 'Treat the deal only as the reviewed permissible import purpose.',
    controlCode: 'INDIA_IMPORT_PURPOSE', responsibleParty: 'ORIGIN', requiredDocuments: ['PAYMENT_PURPOSE_DECLARATION'],
    sourceReferences: [RBI_IMPORT, RBI_PA_CB('rbi-pa-cb-4.3')],
  },
  {
    id: 'uk-destination-sanctions', version: 'v1', jurisdiction: 'GB', category: 'SANCTIONS_AML', ...REVIEW,
    selector: { originCountries: ['IN', 'PL', 'DE', 'RU'], destinationCountries: ['GB'], directions: ['OUTWARD'], destinationPartyTypes: ['SUPPLIER', 'FREELANCER'] },
    disposition: 'COVERED', requirement: 'Screen the UK supplier, beneficial ownership and destination account against the current UK Sanctions List before settlement.',
    controlCode: 'UK_SUPPLIER_SANCTIONS_SCREENING', responsibleParty: 'PROVIDER', requiredDocuments: ['UK_SANCTIONS_SCREENING'],
    sourceReferences: [UK_SANCTIONS],
  },
  {
    id: 'uk-destination-payment-information', version: 'v1', jurisdiction: 'GB', category: 'PAYMENT_CONTROLS', ...REVIEW,
    selector: { originCountries: ['IN', 'PL', 'DE', 'RU'], destinationCountries: ['GB'], directions: ['OUTWARD'], destinationPartyTypes: ['SUPPLIER', 'FREELANCER'] },
    disposition: 'COVERED', requirement: 'The UK destination provider must retain the payee-visible transaction reference, received amount/currency and applicable charge information.',
    controlCode: 'UK_PAYEE_PAYMENT_INFORMATION', responsibleParty: 'DESTINATION', requiredDocuments: ['PAYEE_TRANSACTION_RECORD', 'FX_AND_FEE_DISCLOSURE'],
    sourceReferences: [UK_PAYMENTS],
  },
  {
    id: 'uk-goods-export-tax', version: 'v1', jurisdiction: 'GB', category: 'TAX', ...REVIEW,
    selector: { originCountries: ['IN'], destinationCountries: ['GB'], directions: ['OUTWARD'], purposeCodes: ['S0102'], purposeTypes: ['GOODS'], destinationPartyTypes: ['SUPPLIER'] },
    disposition: 'COVERED', requirement: 'Assess UK export VAT treatment and retain evidence that the goods left the UK before treating the sale as zero-rated.',
    controlCode: 'UK_GOODS_EXPORT_VAT', responsibleParty: 'DESTINATION', requiredDocuments: ['UK_EXPORT_VAT_EVIDENCE'],
    sourceReferences: [UK_GOODS_VAT],
  },
  {
    id: 'uk-goods-export-reporting', version: 'v1', jurisdiction: 'GB', category: 'INVOICING_REPORTING', ...REVIEW,
    selector: { originCountries: ['IN'], destinationCountries: ['GB'], directions: ['OUTWARD'], purposeCodes: ['S0102'], purposeTypes: ['GOODS'], destinationPartyTypes: ['SUPPLIER'] },
    disposition: 'COVERED', requirement: 'Retain the commercial invoice, packing-list reference, commodity code and Great Britain export-declaration evidence.',
    controlCode: 'UK_GOODS_EXPORT_DOCUMENTS', responsibleParty: 'DESTINATION', requiredDocuments: ['INVOICE', 'PACKING_LIST', 'UK_EXPORT_DECLARATION'],
    sourceReferences: [UK_EXPORT, UK_INVOICE],
  },
  {
    id: 'uk-goods-export-purpose', version: 'v1', jurisdiction: 'GB', category: 'PURPOSE', ...REVIEW,
    selector: { originCountries: ['IN'], destinationCountries: ['GB'], directions: ['OUTWARD'], purposeCodes: ['S0102'], purposeTypes: ['GOODS'], destinationPartyTypes: ['SUPPLIER'] },
    disposition: 'COVERED', requirement: 'Confirm the declared goods classification and attach any export licence or certificate required for that classification.',
    controlCode: 'UK_GOODS_EXPORT_CLASSIFICATION', responsibleParty: 'DESTINATION', requiredDocuments: ['COMMODITY_CODE', 'EXPORT_LICENCE_IF_REQUIRED'],
    sourceReferences: [UK_EXPORT],
  },
  {
    id: 'uk-services-export-tax', version: 'v1', jurisdiction: 'GB', category: 'TAX', ...REVIEW,
    selector: { originCountries: ['IN', 'PL', 'DE', 'RU'], destinationCountries: ['GB'], directions: ['OUTWARD'], purposeCodes: ['S0102', 'B2B_DIGITAL_SERVICES'], purposeTypes: ['SERVICES'], destinationPartyTypes: ['SUPPLIER', 'FREELANCER'] },
    disposition: 'COVERED', requirement: 'Determine the service place of supply from the full facts before applying UK VAT treatment; service-specific exceptions still require review.',
    controlCode: 'UK_SERVICE_PLACE_OF_SUPPLY', responsibleParty: 'DESTINATION', requiredDocuments: ['B2B_CUSTOMER_STATUS', 'SERVICE_PLACE_OF_SUPPLY_ASSESSMENT'],
    sourceReferences: [UK_SERVICES_VAT],
  },
  {
    id: 'uk-services-export-reporting', version: 'v1', jurisdiction: 'GB', category: 'INVOICING_REPORTING', ...REVIEW,
    selector: { originCountries: ['IN', 'PL', 'DE', 'RU'], destinationCountries: ['GB'], directions: ['OUTWARD'], purposeCodes: ['S0102', 'B2B_DIGITAL_SERVICES'], purposeTypes: ['SERVICES'], destinationPartyTypes: ['SUPPLIER', 'FREELANCER'] },
    disposition: 'COVERED', requirement: 'Issue and retain an invoice identifying the parties, supplied service, dates, amounts, applicable VAT and total owed.',
    controlCode: 'UK_SERVICE_INVOICE', responsibleParty: 'DESTINATION', requiredDocuments: ['INVOICE'],
    sourceReferences: [UK_INVOICE],
  },
  {
    id: 'uk-services-export-purpose', version: 'v1', jurisdiction: 'GB', category: 'PURPOSE', ...REVIEW,
    selector: { originCountries: ['IN', 'PL', 'DE', 'RU'], destinationCountries: ['GB'], directions: ['OUTWARD'], purposeCodes: ['S0102', 'B2B_DIGITAL_SERVICES'], purposeTypes: ['SERVICES'], destinationPartyTypes: ['SUPPLIER', 'FREELANCER'] },
    disposition: 'COVERED', requirement: 'Confirm that the supplied service fits the reviewed general B2B place-of-supply scope; special-rule services require manual review.',
    controlCode: 'UK_SERVICE_PURPOSE_CLASSIFICATION', responsibleParty: 'BOTH', requiredDocuments: ['SERVICE_CLASSIFICATION'],
    sourceReferences: [UK_SERVICES_VAT],
  },
  {
    id: 'poland-origin-aml', version: 'v1', jurisdiction: 'PL', category: 'SANCTIONS_AML', ...REVIEW,
    selector: { originCountries: ['PL'], originPartyTypes: BUSINESS },
    disposition: 'COVERED', requirement: 'Apply the Polish AML baseline and EU transfer traceability.',
    controlCode: 'POLAND_ORIGIN_AML', responsibleParty: 'PROVIDER', requiredDocuments: ['EU_PARTY_SCREENING'],
    sourceReferences: [PL_AML, EU_TFR, EU_SANCTIONS],
  },
  {
    id: 'poland-origin-payment-controls', version: 'v1', jurisdiction: 'PL', category: 'PAYMENT_CONTROLS', ...REVIEW,
    selector: { originCountries: ['PL'], directions: ['INWARD', 'OUTWARD'] },
    disposition: 'COVERED', requirement: 'Carry reviewed payer/payee transfer information through the provider path.',
    controlCode: 'EU_TRANSFER_INFORMATION', responsibleParty: 'PROVIDER', requiredDocuments: ['PAYER_PAYEE_TRANSFER_DATA'],
    sourceReferences: [EU_TFR],
  },
  {
    id: 'poland-origin-tax-reporting', version: 'v1', jurisdiction: 'PL', category: 'TAX', ...REVIEW,
    selector: { originCountries: ['PL'], originPartyTypes: BUSINESS },
    disposition: 'COVERED', requirement: 'Evaluate PSP cross-border record/reporting obligations for repeated recipient payments.',
    controlCode: 'POLAND_CESOP_ASSESSMENT', responsibleParty: 'PROVIDER', requiredDocuments: ['CESOP_REPORTING_ASSESSMENT'],
    sourceReferences: [PL_CESOP],
  },
  {
    id: 'poland-origin-invoicing-reporting', version: 'v1', jurisdiction: 'PL', category: 'INVOICING_REPORTING', ...REVIEW,
    selector: { originCountries: ['PL'], originPartyTypes: BUSINESS },
    disposition: 'COVERED', requirement: 'Retain the payment and recipient evidence needed by the reviewed PSP reporting scope.',
    controlCode: 'POLAND_PAYMENT_RECORDS', responsibleParty: 'ORIGIN', requiredDocuments: ['INVOICE', 'PAYMENT_RECIPIENT_RECORD'],
    sourceReferences: [PL_CESOP],
  },
  {
    id: 'eu-intra-aml', version: 'v1', jurisdiction: 'EU', category: 'SANCTIONS_AML', ...REVIEW,
    selector: { originCountries: ['DE'], destinationCountries: ['PL'], originPartyTypes: BUSINESS, destinationPartyTypes: PAYEE },
    disposition: 'COVERED', requirement: 'Apply EU transfer traceability and the destination Polish AML baseline.',
    controlCode: 'EU_INTRA_AML', responsibleParty: 'PROVIDER', requiredDocuments: ['EU_PARTY_SCREENING'],
    sourceReferences: [EU_TFR, PL_AML],
  },
  {
    id: 'eu-intra-payment-controls', version: 'v1', jurisdiction: 'EU', category: 'PAYMENT_CONTROLS', ...REVIEW,
    selector: { originCountries: ['DE'], destinationCountries: ['PL'], directions: ['OUTWARD'] },
    disposition: 'COVERED', requirement: 'Carry payer/payee information or the traceable transaction identifier.',
    controlCode: 'EU_INTRA_TRANSFER_INFORMATION', responsibleParty: 'PROVIDER', requiredDocuments: ['PAYER_PAYEE_TRANSFER_DATA'],
    sourceReferences: [EU_TFR],
  },
  {
    id: 'eu-b2b-tax', version: 'v1', jurisdiction: 'EU', category: 'TAX', ...REVIEW,
    selector: { originCountries: ['DE'], destinationCountries: ['PL'], purposeCodes: ['B2B_DIGITAL_SERVICES'], purposeTypes: ['SERVICES'], originPartyTypes: BUSINESS, destinationPartyTypes: PAYEE },
    disposition: 'COVERED', requirement: 'Apply the reviewed B2B place-of-supply analysis.',
    controlCode: 'EU_B2B_VAT_CLASSIFICATION', responsibleParty: 'BOTH', requiredDocuments: ['EU_VAT_IDS', 'B2B_SERVICE_CLASSIFICATION'],
    sourceReferences: [EU_VAT],
  },
  {
    id: 'eu-b2b-invoicing', version: 'v1', jurisdiction: 'EU', category: 'INVOICING_REPORTING', ...REVIEW,
    selector: { originCountries: ['DE'], destinationCountries: ['PL'], purposeCodes: ['B2B_DIGITAL_SERVICES'], purposeTypes: ['SERVICES'] },
    disposition: 'COVERED', requirement: 'Collect VAT identifiers and the reviewed reverse-charge invoice evidence.',
    controlCode: 'EU_REVERSE_CHARGE_INVOICE', responsibleParty: 'ORIGIN', requiredDocuments: ['REVERSE_CHARGE_INVOICE'],
    sourceReferences: [EU_INVOICE],
  },
  {
    id: 'eu-b2b-purpose', version: 'v1', jurisdiction: 'EU', category: 'PURPOSE', ...REVIEW,
    selector: { originCountries: ['DE'], destinationCountries: ['PL'], purposeCodes: ['B2B_DIGITAL_SERVICES'], purposeTypes: ['SERVICES'] },
    disposition: 'COVERED', requirement: 'Classify the deal under the reviewed B2B digital-services scope.',
    controlCode: 'EU_B2B_SERVICE_PURPOSE', responsibleParty: 'BOTH', requiredDocuments: ['B2B_SERVICE_CLASSIFICATION'],
    sourceReferences: [EU_VAT],
  },
  {
    id: 'eu-russia-sanctions-review', version: 'v1', jurisdiction: 'EU', category: 'SANCTIONS_AML', ...REVIEW,
    selector: { originCountries: ['PL'], destinationCountries: ['RU'], directions: ['OUTWARD'] },
    disposition: 'MANUAL_REVIEW', requirement: 'Require current beneficiary, ownership, bank, sector and purpose sanctions screening.',
    controlCode: 'EU_RUSSIA_SANCTIONS_REVIEW', responsibleParty: 'HUMAN_REVIEW', requiredDocuments: ['EU_SANCTIONS_SCREENING', 'BENEFICIARY_BANK_SCREENING'],
    sourceReferences: [EU_SANCTIONS],
  },
  {
    id: 'eu-russia-purpose-review', version: 'v1', jurisdiction: 'EU', category: 'PURPOSE', ...REVIEW,
    selector: { originCountries: ['PL'], destinationCountries: ['RU'], directions: ['OUTWARD'], purposeCodes: ['B2B_SERVICES'] },
    disposition: 'MANUAL_REVIEW', requirement: 'A human must confirm that the declared service and sector are not restricted.',
    controlCode: 'EU_RUSSIA_PURPOSE_REVIEW', responsibleParty: 'HUMAN_REVIEW', requiredDocuments: ['PAYMENT_PURPOSE_EVIDENCE'],
    sourceReferences: [EU_SANCTIONS],
  },
  {
    id: 'eu-dprk-transfer-block', version: 'v1', jurisdiction: 'EU', category: 'SANCTIONS_AML', ...REVIEW,
    selector: { originCountries: ['PL'], destinationCountries: ['KP'], directions: ['OUTWARD'] },
    disposition: 'BLOCKED', requirement: 'Stop because Anchor has no prior-authorization workflow for the narrow exceptions.',
    controlCode: 'EU_DPRK_SANCTIONS_BLOCK', responsibleParty: 'HUMAN_REVIEW', requiredDocuments: ['PRIOR_AUTHORIZATION'],
    sourceReferences: [EU_DPRK],
  },
  {
    id: 'eu-dprk-payment-block', version: 'v1', jurisdiction: 'EU', category: 'PAYMENT_CONTROLS', ...REVIEW,
    selector: { originCountries: ['PL'], destinationCountries: ['KP'], directions: ['OUTWARD'] },
    disposition: 'BLOCKED', requirement: 'Do not create a quote or blockchain command without competent-authority approval.',
    controlCode: 'EU_DPRK_PAYMENT_BLOCK', responsibleParty: 'PROVIDER', requiredDocuments: ['PRIOR_AUTHORIZATION'],
    sourceReferences: [EU_DPRK],
  },
  {
    id: 'eu-dprk-purpose-block', version: 'v1', jurisdiction: 'EU', category: 'PURPOSE', ...REVIEW,
    selector: { originCountries: ['PL'], destinationCountries: ['KP'], directions: ['OUTWARD'] },
    disposition: 'BLOCKED', requirement: 'No configured purpose is treated as an authorized exception.',
    controlCode: 'EU_DPRK_PURPOSE_BLOCK', responsibleParty: 'HUMAN_REVIEW', requiredDocuments: ['PRIOR_AUTHORIZATION'],
    sourceReferences: [EU_DPRK],
  },
  {
    id: 'un-dprk-destination-sanctions-block', version: 'v1', jurisdiction: 'UN', category: 'SANCTIONS_AML', ...REVIEW,
    selector: { destinationCountries: ['KP'] },
    disposition: 'BLOCKED', requirement: 'Anchor blocks this route because it cannot resolve DPRK designations, ownership, licensing or exemptions required by the UN sanctions regime.',
    controlCode: 'UN_DPRK_DESTINATION_SANCTIONS_BLOCK', responsibleParty: 'HUMAN_REVIEW', requiredDocuments: ['SANCTIONS_EXCEPTION_AUTHORIZATION'],
    sourceReferences: [UN_DPRK],
  },
  {
    id: 'un-dprk-destination-payment-block', version: 'v1', jurisdiction: 'UN', category: 'PAYMENT_CONTROLS', ...REVIEW,
    selector: { destinationCountries: ['KP'] },
    disposition: 'BLOCKED', requirement: 'No quote or settlement command may be created for a DPRK destination in the demo product.',
    controlCode: 'UN_DPRK_DESTINATION_PAYMENT_BLOCK', responsibleParty: 'PROVIDER', requiredDocuments: ['SANCTIONS_EXCEPTION_AUTHORIZATION'],
    sourceReferences: [UN_DPRK],
  },
  {
    id: 'un-dprk-destination-purpose-block', version: 'v1', jurisdiction: 'UN', category: 'PURPOSE', ...REVIEW,
    selector: { destinationCountries: ['KP'] },
    disposition: 'BLOCKED', requirement: 'The demo has no reviewed purpose-specific sanctions exception path.',
    controlCode: 'UN_DPRK_DESTINATION_PURPOSE_BLOCK', responsibleParty: 'HUMAN_REVIEW', requiredDocuments: ['SANCTIONS_EXCEPTION_AUTHORIZATION'],
    sourceReferences: [UN_DPRK],
  },
  {
    id: 'un-dprk-origin-sanctions-block', version: 'v1', jurisdiction: 'UN', category: 'SANCTIONS_AML', ...REVIEW,
    selector: { originCountries: ['KP'] },
    disposition: 'BLOCKED', requirement: 'Anchor blocks this route because it cannot resolve DPRK designations, ownership, licensing or exemptions required by the UN sanctions regime.',
    controlCode: 'UN_DPRK_ORIGIN_SANCTIONS_BLOCK', responsibleParty: 'HUMAN_REVIEW', requiredDocuments: ['SANCTIONS_EXCEPTION_AUTHORIZATION'],
    sourceReferences: [UN_DPRK],
  },
  {
    id: 'un-dprk-origin-payment-block', version: 'v1', jurisdiction: 'UN', category: 'PAYMENT_CONTROLS', ...REVIEW,
    selector: { originCountries: ['KP'] },
    disposition: 'BLOCKED', requirement: 'No quote or settlement command may be created for a DPRK origin in the demo product.',
    controlCode: 'UN_DPRK_ORIGIN_PAYMENT_BLOCK', responsibleParty: 'PROVIDER', requiredDocuments: ['SANCTIONS_EXCEPTION_AUTHORIZATION'],
    sourceReferences: [UN_DPRK],
  },
  {
    id: 'un-dprk-origin-purpose-block', version: 'v1', jurisdiction: 'UN', category: 'PURPOSE', ...REVIEW,
    selector: { originCountries: ['KP'] },
    disposition: 'BLOCKED', requirement: 'The demo has no reviewed purpose-specific sanctions exception path.',
    controlCode: 'UN_DPRK_ORIGIN_PURPOSE_BLOCK', responsibleParty: 'HUMAN_REVIEW', requiredDocuments: ['SANCTIONS_EXCEPTION_AUTHORIZATION'],
    sourceReferences: [UN_DPRK],
  },
] as const;

export type RegulatoryCategoryStatus =
  | 'COVERED'
  | 'MISSING'
  | 'STALE'
  | 'NOT_EFFECTIVE'
  | 'SOURCE_REVIEW_REQUIRED'
  | 'MANUAL_REVIEW'
  | 'BLOCKED';

export interface RegulatoryCategoryPlan {
  readonly category: ObligationCategory;
  readonly status: RegulatoryCategoryStatus;
  readonly moduleIds: readonly string[];
  readonly requirements: readonly string[];
  readonly controls: readonly RegulatoryControlPlan[];
  readonly requiredDocuments: readonly string[];
  readonly sourceReferences: readonly CoverageSourceReference[];
  readonly reasons: readonly string[];
}

export interface RegulatoryControlPlan {
  readonly moduleId: string;
  readonly controlCode: string;
  readonly responsibleParty: RegulatoryObligationModule['responsibleParty'];
  readonly requirement: string;
  readonly requiredDocuments: readonly string[];
  readonly sourceReferences: readonly CoverageSourceReference[];
}

export interface RegulatoryHardGate {
  readonly canQuoteOrFund: boolean;
  readonly code: 'REGULATORY_PLAN_PASSED' | 'MANUAL_REVIEW_REQUIRED' | 'REGULATORY_BLOCKED';
  readonly reasons: readonly string[];
}

export interface DealRegulatoryPlan {
  readonly schemaVersion: '1.0';
  readonly facts: {
    readonly originCountry: string;
    readonly destinationCountry: string;
    readonly direction: RegulatoryDirection;
    readonly purposeCode: string;
    readonly purposeType: RegulatoryPurposeType;
    readonly originPartyType: RegulatoryPartyType;
    readonly destinationPartyType: RegulatoryPartyType;
    readonly evaluatedAt: string;
  };
  readonly bookId: string;
  readonly orderedRoute: string;
  readonly uncoveredJurisdictions: readonly { readonly country: string; readonly role: 'ORIGIN' | 'DESTINATION' }[];
  readonly outcome: 'PASSED' | 'MANUAL_REVIEW' | 'BLOCKED';
  readonly categories: readonly RegulatoryCategoryPlan[];
  readonly controls: readonly RegulatoryControlPlan[];
  readonly requiredDocuments: readonly string[];
  readonly hardGate: RegulatoryHardGate;
  readonly reasons: readonly string[];
  readonly applicableSourceIds: readonly string[];
  readonly corpusHash: string;
  readonly planHash: string;
  readonly deterministic: true;
  readonly approvedSourcesOnly: true;
  readonly coverageScope: 'ANCHOR_DEMO_OBLIGATIONS_ONLY';
}

export interface RegulatoryPlannerOptions {
  readonly modules?: readonly RegulatoryObligationModule[];
  readonly sources?: readonly ApprovedRegulationSource[];
}

export interface DealRegulationCheck {
  readonly mode: 'fixture' | 'live';
  readonly report: RegulationRefreshReport;
  readonly plan: DealRegulatoryPlan;
}

function selectorMatches(selector: ModuleSelector, facts: DealRegulatoryFacts): boolean {
  const tests: readonly [readonly string[] | undefined, string][] = [
    [selector.originCountries, facts.originCountry],
    [selector.destinationCountries, facts.destinationCountry],
    [selector.directions, facts.direction],
    [selector.purposeCodes, facts.purposeCode],
    [selector.purposeTypes, facts.purposeType],
    [selector.originPartyTypes, facts.originPartyType],
    [selector.destinationPartyTypes, facts.destinationPartyType],
  ];
  return tests.every(([allowed, value]) => allowed === undefined || allowed.includes(value));
}

function expectedDirection(facts: DealRegulatoryFacts): RegulatoryDirection {
  return facts.destinationCountry === 'IN' ? 'INWARD' : 'OUTWARD';
}

function validateReference(referenceValue: CoverageSourceReference, sources: readonly ApprovedRegulationSource[]): string | undefined {
  const source = sources.find((candidate) => candidate.id === referenceValue.sourceId);
  if (!source) return `Reviewed source ${referenceValue.sourceId} is missing.`;
  if (source.approvedVersion !== referenceValue.sourceVersion) return `Reviewed source ${source.id} version does not match the module pin.`;
  if (referenceValue.chunkIds.length === 0) return `Reviewed source ${source.id} has no pinned section.`;
  const missingChunk = referenceValue.chunkIds.find((chunkId) => !source.chunks.some((chunk) => chunk.id === chunkId));
  return missingChunk === undefined ? undefined : `Reviewed source section ${source.id}/${missingChunk} is missing.`;
}

function worstStatus(statuses: readonly RegulatoryCategoryStatus[]): RegulatoryCategoryStatus {
  const rank: Readonly<Record<RegulatoryCategoryStatus, number>> = {
    COVERED: 0, MANUAL_REVIEW: 1, SOURCE_REVIEW_REQUIRED: 2, NOT_EFFECTIVE: 3, STALE: 4, MISSING: 5, BLOCKED: 6,
  };
  return statuses.reduce((worst, status) => rank[status] > rank[worst] ? status : worst, 'COVERED');
}

/**
 * Composes a plan from deal facts. This is a coverage planner, not legal
 * advice: any absent or stale module is held for human review.
 */
export function planDealRegulations(
  facts: DealRegulatoryFacts,
  options: RegulatoryPlannerOptions = {},
): DealRegulatoryPlan {
  const modules = options.modules ?? REGULATORY_OBLIGATION_MODULES;
  const sources = options.sources ?? APPROVED_REGULATION_SOURCES;
  const bookId = `${facts.originCountry}-${facts.destinationCountry}-${facts.direction}`;
  const inputReasons: string[] = [];
  if (!/^[A-Z]{2}$/u.test(facts.originCountry) || !/^[A-Z]{2}$/u.test(facts.destinationCountry)) {
    inputReasons.push('Countries must be ISO 3166-1 alpha-2 uppercase codes.');
  }
  if (facts.originCountry === facts.destinationCountry) inputReasons.push('A cross-border plan requires two different countries.');
  if (facts.direction !== expectedDirection(facts)) {
    inputReasons.push(`Direction ${facts.direction} conflicts with ordered payer route ${facts.originCountry} → ${facts.destinationCountry}.`);
  }
  const changedSources = new Set(facts.refreshReport?.observations
    .filter((observation) => observation.status === 'REVIEW_REQUIRED')
    .map((observation) => observation.sourceId) ?? []);
  const corpusHash = approvedCorpusHash(sources);
  const refreshMismatch = facts.refreshReport !== undefined && facts.refreshReport.approvedCorpusHash !== corpusHash;
  const applicable = modules.filter((module) => selectorMatches(module.selector, facts));
  const uncoveredJurisdictions: { country: string; role: 'ORIGIN' | 'DESTINATION' }[] = [];
  if (!applicable.some((module) => module.selector.originCountries?.includes(facts.originCountry))) {
    uncoveredJurisdictions.push({ country: facts.originCountry, role: 'ORIGIN' });
  }
  if (!applicable.some((module) => module.selector.destinationCountries?.includes(facts.destinationCountry))) {
    uncoveredJurisdictions.push({ country: facts.destinationCountry, role: 'DESTINATION' });
  }
  for (const gap of uncoveredJurisdictions) {
    inputReasons.push(`No reviewed module represents the ${gap.role.toLowerCase()} jurisdiction ${gap.country}.`);
  }

  const categories = REQUIRED_OBLIGATION_CATEGORIES.map((category): RegulatoryCategoryPlan => {
    const matched = applicable.filter((module) => module.category === category);
    const reasons: string[] = [...inputReasons];
    const statuses: RegulatoryCategoryStatus[] = [];
    if (uncoveredJurisdictions.length > 0) statuses.push('MISSING');
    if (matched.length === 0) {
      statuses.push('MISSING');
      reasons.push(`No reviewed ${category} module matches these deal facts.`);
    }
    for (const module of matched) {
      const evaluatedAt = facts.evaluatedAt.getTime();
      const reviewedAt = Date.parse(module.reviewedAt);
      const effectiveAt = Date.parse(module.effectiveFrom);
      const reviewBy = Date.parse(module.reviewBy);
      if (![evaluatedAt, reviewedAt, effectiveAt, reviewBy].every(Number.isFinite) || reviewBy <= reviewedAt) {
        statuses.push('MISSING');
        reasons.push(`${module.id} has invalid reviewed/effective metadata.`);
        continue;
      }
      if (evaluatedAt < effectiveAt) {
        statuses.push('NOT_EFFECTIVE');
        reasons.push(`${module.id} is not effective until ${module.effectiveFrom}.`);
        continue;
      }
      if (evaluatedAt >= reviewBy) {
        statuses.push('STALE');
        reasons.push(`${module.id} reached its review deadline ${module.reviewBy}.`);
        continue;
      }
      const referenceIssue = module.sourceReferences
        .map((item) => validateReference(item, sources))
        .find((item) => item !== undefined);
      if (referenceIssue !== undefined) {
        statuses.push('MISSING');
        reasons.push(referenceIssue);
        continue;
      }
      if (refreshMismatch || module.sourceReferences.some((item) => changedSources.has(item.sourceId))) {
        statuses.push('SOURCE_REVIEW_REQUIRED');
        reasons.push(refreshMismatch
          ? `${module.id} refresh evidence belongs to a different approved corpus.`
          : `${module.id} references an observed source change awaiting human approval.`);
        continue;
      }
      statuses.push(module.disposition);
      if (module.disposition !== 'COVERED') reasons.push(module.requirement);
    }
    return {
      category,
      status: worstStatus(statuses),
      moduleIds: matched.map((module) => module.id),
      requirements: matched.map((module) => module.requirement),
      controls: matched.map((module) => ({
        moduleId: module.id,
        controlCode: module.controlCode,
        responsibleParty: module.responsibleParty,
        requirement: module.requirement,
        requiredDocuments: module.requiredDocuments,
        sourceReferences: module.sourceReferences,
      })),
      requiredDocuments: [...new Set(matched.flatMap((module) => module.requiredDocuments))].sort(),
      sourceReferences: matched.flatMap((module) => module.sourceReferences),
      reasons,
    };
  });

  const hasBlocked = categories.some((category) => category.status === 'BLOCKED');
  const undeployedRail = !DEPLOYED_EXECUTABLE_BOOKS.has(bookId);
  const hasReview = categories.some((category) => category.status !== 'COVERED') || undeployedRail;
  const outcome: DealRegulatoryPlan['outcome'] = hasBlocked ? 'BLOCKED' : hasReview ? 'MANUAL_REVIEW' : 'PASSED';
  const reasons = [...new Set([
    ...categories.flatMap((category) => category.reasons),
    ...(undeployedRail && !hasBlocked
      ? [`No deployed provider/Algorand rail is configured for ${bookId}.`]
      : []),
  ])];
  const controls = categories.flatMap((category) => category.controls);
  const requiredDocuments = [...new Set(categories.flatMap((category) => category.requiredDocuments))].sort();
  const hardGate: RegulatoryHardGate = {
    canQuoteOrFund: outcome === 'PASSED',
    code: outcome === 'PASSED'
      ? 'REGULATORY_PLAN_PASSED'
      : outcome === 'BLOCKED' ? 'REGULATORY_BLOCKED' : 'MANUAL_REVIEW_REQUIRED',
    reasons,
  };
  const applicableSourceIds = [...new Set(categories.flatMap((category) =>
    category.sourceReferences.map((referenceValue) => referenceValue.sourceId)))].sort();
  const unsigned = {
    schemaVersion: '1.0' as const,
    facts: {
      originCountry: facts.originCountry,
      destinationCountry: facts.destinationCountry,
      direction: facts.direction,
      purposeCode: facts.purposeCode,
      purposeType: facts.purposeType,
      originPartyType: facts.originPartyType,
      destinationPartyType: facts.destinationPartyType,
      evaluatedAt: facts.evaluatedAt.toISOString(),
    },
    bookId,
    orderedRoute: `${facts.originCountry} → ${facts.destinationCountry}`,
    uncoveredJurisdictions,
    outcome,
    categories,
    controls,
    requiredDocuments,
    hardGate,
    reasons,
    applicableSourceIds,
    corpusHash,
    deterministic: true as const,
    approvedSourcesOnly: true as const,
    coverageScope: 'ANCHOR_DEMO_OBLIGATIONS_ONLY' as const,
  };
  return { ...unsigned, planHash: canonicalHash(unsigned) };
}

/**
 * Refresh only the official sources selected by the deal facts, then compose
 * the final hard-gated plan against that exact source set.
 */
export async function checkDealRegulations(input: {
  readonly facts: Omit<DealRegulatoryFacts, 'refreshReport'>;
  readonly mode: 'fixture' | 'live';
}): Promise<DealRegulationCheck> {
  const draft = planDealRegulations(input.facts);
  const sources = regulationSourcesForPlan(draft);
  const report = input.mode === 'live'
    ? await refreshOfficialRegulations({ sources, checkedAt: input.facts.evaluatedAt })
    : {
        schemaVersion: '1.0' as const,
        checkedAt: input.facts.evaluatedAt.toISOString(),
        approvedCorpusHash: approvedCorpusHash(sources),
        observations: sources.map((source) => ({
          sourceId: source.id,
          approvedVersion: source.approvedVersion,
          sourceUri: source.sourceUri,
          checkedAt: input.facts.evaluatedAt.toISOString(),
          status: 'UNCHANGED' as const,
          missingMarkers: [],
          note: 'Deterministic offline acceptance used the reviewed deal-specific source record.',
          advisoryOnly: true as const,
        })),
        requiresHumanReview: false,
        rulesChanged: false as const,
      };
  return {
    mode: input.mode,
    report,
    plan: planDealRegulations({ ...input.facts, refreshReport: report }, { sources }),
  };
}

export function regulationSourcesForPlan(
  plan: DealRegulatoryPlan,
  sources: readonly ApprovedRegulationSource[] = APPROVED_REGULATION_SOURCES,
): readonly ApprovedRegulationSource[] {
  const ids = new Set(plan.applicableSourceIds);
  return sources.filter((source) => ids.has(source.id));
}
