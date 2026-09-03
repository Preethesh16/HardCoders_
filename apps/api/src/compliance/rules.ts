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

export const RULES_VERSION = 'OPTIWORK-COMPLIANCE-RULES-v1';

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
    citation: { ...RBI_PA_CB, section: 'Paragraph 4.2', quote: 'Per unit of goods or services, the value shall not exceed ₹25,00,000.' },
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
    citation: { ...RBI_PA_CB, section: 'Paragraph 4.4', quote: 'For import transactions above ₹2,50,000 per unit, due diligence of the buyer shall be undertaken.' },
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
    description: 'Simulated withholding-tax review for an outward remittance.',
    citation: { ...RBI_PA_CB, section: 'Paragraph 4.4', quote: 'Import collection services shall obtain the declarations prescribed for outward remittances.' },
  },
  {
    code: 'IMPORT_EVIDENCE',
    appliesToBooks: ['IN-GB-OUTWARD'],
    description: 'Shipping or import evidence for the goods or services received.',
    citation: { ...RBI_PA_CB, section: 'Paragraph 4.4', quote: 'Import collection services shall obtain evidence of import.' },
  },
];

export function thresholdRulesFor(bookId: string): readonly ThresholdRule[] {
  return THRESHOLD_RULES.filter((rule) => rule.appliesToBooks.includes(bookId));
}

export function documentRulesFor(bookId: string): readonly DocumentRule[] {
  return DOCUMENT_RULES.filter((rule) => rule.appliesToBooks.includes(bookId));
}
