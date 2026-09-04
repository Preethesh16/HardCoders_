/**
 * Versioned compliance rules.
 *
 * Compliance is *configuration*, not conditionals scattered through the
 * request handlers. Each rule names the corridor directions it applies to, the
 * threshold it compares against, the documents it demands and the exact source
 * paragraph it came from. Changing policy means adding a new ruleset version,
 * never editing a route.
 *
 * This is a demonstration of a rules engine. It is not legal advice, a licensed
 * payment service, or a KYC/AML programme.
 */

import type { CorridorDirection, MoneyDto } from '@optiwork/contracts';

export const RULES_VERSION = 'ANCHOR-COMPLIANCE-RULES-v2';

export type RuleEffect = 'BLOCK' | 'MANUAL_REVIEW' | 'REQUIRE_DOCUMENTS';

export interface RuleCitation {
  readonly sourceUri: string;
  readonly sourceVersion: string;
  readonly section: string;
  readonly quote: string;
}

export interface ThresholdRule {
  readonly code: string;
  /** Corridors this rule applies to, as ordered `ORIGIN-DESTINATION-DIRECTION`. */
  readonly appliesToBooks: readonly string[];
  readonly directions: readonly CorridorDirection[];
  readonly comparison: 'GREATER_THAN';
  readonly threshold: MoneyDto;
  readonly effect: RuleEffect;
  readonly requiredDocuments: readonly string[];
  readonly requiresEnhancedAssurance: boolean;
  readonly rationale: string;
  readonly citation: RuleCitation;
}

const RBI_PA_CB: Omit<RuleCitation, 'section' | 'quote'> = {
  sourceUri: 'https://rbi.org.in/Scripts/NotificationUser.aspx/upload/Scripts/NotificationUser.aspx?Id=12561',
  sourceVersion: 'RBI-PA-CB-2023-10-31',
};

const INDIA_TAX: Omit<RuleCitation, 'section' | 'quote'> = {
  sourceUri: 'https://www.incometax.gov.in/iec/foportal/help/statutory-forms/popular-forms/form-15ca-faq',
  sourceVersion: 'INDIA-INCOME-TAX-FORM-15CA-REVIEWED-2026-09-04',
};

const EU_VAT: Omit<RuleCitation, 'section' | 'quote'> = {
  sourceUri: 'https://taxation-customs.ec.europa.eu/where-tax_en',
  sourceVersion: 'EU-VAT-DIRECTIVE-ART44-196-REVIEWED-2026-09-04',
};

const EU_INVOICING: Omit<RuleCitation, 'section' | 'quote'> = {
  sourceUri: 'https://taxation-customs.ec.europa.eu/taxation/vat/vat-businesses/invoicing_en',
  sourceVersion: 'EU-VAT-INVOICING-REVIEWED-2026-09-04',
};

const EU_SANCTIONS: Omit<RuleCitation, 'section' | 'quote'> = {
  sourceUri: 'https://finance.ec.europa.eu/eu-and-world/sanctions-restrictive-measures/overview-sanctions-and-related-resources_en',
  sourceVersion: 'EU-SANCTIONS-OVERVIEW-REVIEWED-2026-09-04',
};

const EU_DPRK: Omit<RuleCitation, 'section' | 'quote'> = {
  sourceUri: 'https://www.consilium.europa.eu/en/policies/sanctions-against-north-korea/timeline-eu-sanctions-against-north-korea/',
  sourceVersion: 'EU-DPRK-RESTRICTIONS-REVIEWED-2026-09-04',
};

export type ComplianceRiskSignal = 'SANCTIONS_PARTY_MATCH' | 'RESTRICTED_BANK_MATCH' | 'PROHIBITED_GOODS_OR_SERVICES';

export interface CorridorGateRule {
  readonly code: string;
  readonly bookId: string;
  readonly effect: Extract<RuleEffect, 'BLOCK' | 'MANUAL_REVIEW'>;
  readonly rationale: string;
  readonly citation: RuleCitation;
}

/** A policy gate is evaluated by the same engine as credentials, documents and value thresholds. */
export const CORRIDOR_GATE_RULES: readonly CorridorGateRule[] = [
  {
    code: 'EU_RUSSIA_SANCTIONS_REVIEW',
    bookId: 'PL-RU-OUTWARD',
    effect: 'MANUAL_REVIEW',
    rationale: 'This route requires current beneficiary, ownership, bank and purpose screening; country alone is not treated as a sanctions match.',
    citation: { ...EU_SANCTIONS, section: 'EU sanctions map and consolidated list', quote: 'EU sanctions may target governments, entities, groups or individuals.' },
  },
  {
    code: 'EU_DPRK_TRANSFER_RESTRICTION',
    bookId: 'PL-KP-OUTWARD',
    effect: 'BLOCK',
    rationale: 'Anchor has no prior-authorisation workflow for the narrow exceptions, so this demo rejects the transfer before quoting or signing.',
    citation: { ...EU_DPRK, section: 'Financial-sector restrictions', quote: 'prohibition of transfers of funds to and from the DPRK' },
  },
];

export interface RiskSignalRule {
  readonly signal: ComplianceRiskSignal;
  readonly code: string;
  readonly effect: 'BLOCK';
  readonly rationale: string;
  readonly citation: RuleCitation;
}

export const RISK_SIGNAL_RULES: readonly RiskSignalRule[] = [
  {
    signal: 'SANCTIONS_PARTY_MATCH',
    code: 'SANCTIONS_PARTY_MATCH',
    effect: 'BLOCK',
    rationale: 'A confirmed listed-party match prohibits making funds available; the payment is stopped before a quote can authorize settlement.',
    citation: { ...EU_SANCTIONS, section: 'Asset freezes', quote: 'It is prohibited to make funds or economic resources available to listed parties.' },
  },
  {
    signal: 'RESTRICTED_BANK_MATCH',
    code: 'RESTRICTED_BANK_MATCH',
    effect: 'BLOCK',
    rationale: 'The selected settlement bank is subject to a transaction restriction in this demonstration screening result.',
    citation: { ...EU_SANCTIONS, section: 'Financial sanctions', quote: 'Financial sanctions can include restrictions on banking and investment.' },
  },
  {
    signal: 'PROHIBITED_GOODS_OR_SERVICES',
    code: 'RBI_PROHIBITED_TRADE_PURPOSE',
    effect: 'BLOCK',
    rationale: 'The declared purpose is a prohibited or restricted import/export category and cannot enter the payment path.',
    citation: { ...RBI_PA_CB, section: 'Annex paragraph 8', quote: 'PA-CBs shall not facilitate payment for prohibited or restricted goods or services.' },
  },
];

/**
 * The two Indian value rules the demonstration encodes.
 *
 * `RBI_PER_UNIT_CAP` is a **per unit of goods or services** cap of ₹25,00,000
 * and applies to both Indian directions.
 *
 * `RBI_IMPORT_BUYER_DD` is the ₹2,50,000 buyer due-diligence threshold. It is
 * deliberately restricted to Indian **import/outward** payments: a Poland to
 * India inward freelancer payment is an export receipt for the freelancer, and
 * applying an import buyer-diligence rule to it would be wrong.
 */
export const THRESHOLD_RULES: readonly ThresholdRule[] = [
  {
    code: 'RBI_PER_UNIT_CAP',
    appliesToBooks: ['PL-IN-INWARD', 'IN-GB-OUTWARD'],
    directions: ['INWARD', 'OUTWARD'],
    comparison: 'GREATER_THAN',
    threshold: { amountMinor: '250000000', currency: 'INR', scale: 2 },
    effect: 'BLOCK',
    requiredDocuments: [],
    requiresEnhancedAssurance: false,
    rationale: 'Payments above the per-unit ceiling cannot be processed by a PA-CB in this demonstration.',
    citation: { ...RBI_PA_CB, section: 'Annex paragraph 8.2', quote: 'The maximum value per unit of goods / services sold / purchased shall be ₹25,00,000.' },
  },
  {
    code: 'RBI_IMPORT_BUYER_DD',
    appliesToBooks: ['IN-GB-OUTWARD'],
    directions: ['OUTWARD'],
    comparison: 'GREATER_THAN',
    threshold: { amountMinor: '25000000', currency: 'INR', scale: 2 },
    effect: 'REQUIRE_DOCUMENTS',
    requiredDocuments: ['BUYER_DUE_DILIGENCE'],
    requiresEnhancedAssurance: true,
    rationale: 'Import transactions above the threshold require buyer due diligence by the import collection service.',
    citation: { ...RBI_PA_CB, section: 'Annex paragraph 4.4', quote: 'In case per unit goods / services imported is more than ₹2,50,000, then the concerned PA-CB shall undertake due diligence of buyer also.' },
  },
  {
    code: 'INDIA_FORM_15CA_PART_REVIEW',
    appliesToBooks: ['IN-GB-OUTWARD'],
    directions: ['OUTWARD'],
    comparison: 'GREATER_THAN',
    threshold: { amountMinor: '50000000', currency: 'INR', scale: 2 },
    effect: 'REQUIRE_DOCUMENTS',
    requiredDocuments: ['TAX_REVIEW_DEMO'],
    requiresEnhancedAssurance: false,
    rationale: 'Above ₹5 lakh, the applicable Form 15CA part and whether Form 15CB or an Assessing Officer certificate is needed must be determined before remittance.',
    citation: { ...INDIA_TAX, section: 'FAQs 2 and 4', quote: 'Form 15CB is not mandatory in every case above five lakh rupees.' },
  },
];

export interface DocumentRule {
  readonly code: string;
  readonly appliesToBooks: readonly string[];
  readonly description: string;
  readonly citation: RuleCitation;
}

export const DOCUMENT_RULES: readonly DocumentRule[] = [
  {
    code: 'INVOICE',
    appliesToBooks: ['PL-IN-INWARD', 'IN-GB-OUTWARD'],
    description: 'A commercial invoice for the work or goods being paid for.',
    citation: { ...RBI_PA_CB, section: 'Paragraph 5', quote: 'Payment aggregators shall obtain and retain the underlying commercial documents.' },
  },
  {
    code: 'SERVICE_EXPORT_DECLARATION',
    appliesToBooks: ['PL-IN-INWARD'],
    description: 'A service-export declaration for the Indian recipient of an inward payment.',
    citation: { ...RBI_PA_CB, section: 'Paragraph 4.3', quote: 'Export collection services shall onboard merchants and collect the requisite export declarations.' },
  },
  {
    code: 'FORM_A2_DEMO',
    appliesToBooks: ['IN-GB-OUTWARD'],
    description: 'Simulated Form A2 declaration for an outward remittance.',
    citation: { ...RBI_PA_CB, section: 'Paragraph 4.4', quote: 'Import collection services shall obtain the declarations prescribed for outward remittances.' },
  },
  {
    code: 'TAX_REVIEW_DEMO',
    appliesToBooks: ['IN-GB-OUTWARD'],
    description: 'Demonstration Section 195 chargeability and Form 15CA/15CB path determination; this is not a tax filing.',
    citation: { ...INDIA_TAX, section: 'FAQs 1–4', quote: 'Form 15CA must be submitted before a qualifying remittance.' },
  },
  {
    code: 'IMPORT_EVIDENCE',
    appliesToBooks: ['IN-GB-OUTWARD'],
    description: 'Shipping or import evidence for the goods or services received.',
    citation: { ...RBI_PA_CB, section: 'Paragraph 4.4', quote: 'Import collection services shall obtain evidence of import.' },
  },
  {
    code: 'EU_VAT_IDS',
    appliesToBooks: ['DE-PL-OUTWARD'],
    description: 'Verified supplier and customer VAT identifiers for the B2B tax treatment.',
    citation: { ...EU_INVOICING, section: 'Invoice contents', quote: 'A full VAT invoice identifies the supplier and customer for the transaction.' },
  },
  {
    code: 'B2B_SERVICE_CLASSIFICATION',
    appliesToBooks: ['DE-PL-OUTWARD'],
    description: 'Evidence that the customer is a taxable business and the service falls under the B2B place-of-supply rule.',
    citation: { ...EU_VAT, section: 'Place of taxation for services', quote: 'For B2B supplies, the place of taxation is where the customer is established.' },
  },
  {
    code: 'REVERSE_CHARGE_INVOICE',
    appliesToBooks: ['DE-PL-OUTWARD'],
    description: 'A VAT invoice carrying the required reverse-charge notation when the customer is liable for VAT.',
    citation: { ...EU_INVOICING, section: 'What information must a VAT invoice contain?', quote: 'The invoice must include the words reverse charge when the customer is liable.' },
  },
  {
    code: 'EU_SANCTIONS_SCREENING',
    appliesToBooks: ['PL-RU-OUTWARD'],
    description: 'A current party, beneficial-owner and control screening result against applicable EU listings.',
    citation: { ...EU_SANCTIONS, section: 'Consolidated list', quote: 'The consolidated list contains persons, groups and entities subject to EU financial sanctions.' },
  },
  {
    code: 'BENEFICIARY_BANK_SCREENING',
    appliesToBooks: ['PL-RU-OUTWARD'],
    description: 'Evidence that the beneficiary bank and payment chain are not subject to a transaction ban.',
    citation: { ...EU_SANCTIONS, section: 'Financial sanctions', quote: 'Financial sanctions can include restrictions on banking and investment.' },
  },
  {
    code: 'PAYMENT_PURPOSE_EVIDENCE',
    appliesToBooks: ['PL-RU-OUTWARD'],
    description: 'Invoice and service-purpose evidence sufficient for a human sanctions and sectoral-restriction review.',
    citation: { ...EU_SANCTIONS, section: 'Types of sanctions', quote: 'EU restrictive measures may be diplomatic, sectoral, economic or financial.' },
  },
  {
    code: 'PRIOR_AUTHORIZATION',
    appliesToBooks: ['PL-KP-OUTWARD'],
    description: 'Prior competent-authority approval for an applicable exception; Anchor does not implement this authorization path.',
    citation: { ...EU_DPRK, section: 'Financial-sector restrictions', quote: 'Transfers may proceed only for predefined purposes and with prior authorisation.' },
  },
];

export function corridorGateRuleFor(bookId: string): CorridorGateRule | undefined {
  return CORRIDOR_GATE_RULES.find((rule) => rule.bookId === bookId);
}

export function riskSignalRuleFor(signal: ComplianceRiskSignal): RiskSignalRule {
  return RISK_SIGNAL_RULES.find((rule) => rule.signal === signal)!;
}

export function thresholdRulesFor(bookId: string): readonly ThresholdRule[] {
  return THRESHOLD_RULES.filter((rule) => rule.appliesToBooks.includes(bookId));
}

export function documentRulesFor(bookId: string): readonly DocumentRule[] {
  return DOCUMENT_RULES.filter((rule) => rule.appliesToBooks.includes(bookId));
}
