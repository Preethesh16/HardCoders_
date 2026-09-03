import { canonicalHash } from '../canonical.js';
import type { ApprovedRegulationSource } from './types.js';

const BOTH = ['PL-IN-INWARD', 'IN-GB-OUTWARD'] as const;

/**
 * Human-reviewed, compact extracts from official primary sources.
 *
 * These records are intentionally source controlled. Refresh observations do
 * not update this array and therefore cannot change a compliance outcome.
 */
export const APPROVED_REGULATION_SOURCES: readonly ApprovedRegulationSource[] = [
  {
    id: 'rbi-pa-cb-2023-10-31',
    title: 'Regulation of Payment Aggregator – Cross Border (PA-CB)',
    authority: 'RBI',
    jurisdiction: 'IN',
    sourceUri: 'https://www.rbi.org.in/Scripts/NotificationUser.aspx?Id=12561&Mode=0',
    officialDocumentDate: '2023-10-31',
    approvedVersion: 'RBI-2023-24-80',
    approvedAt: '2026-09-04',
    allowedHosts: ['www.rbi.org.in', 'rbi.org.in'],
    approvedMarkers: [
      'Regulation of Payment Aggregator – Cross Border (PA - Cross Border)',
      'CO.DPSS.POLC.No.S-786/02-14-008/2023-24',
      'In case per unit goods / services imported is more than ₹2,50,000',
      'the maximum value per unit of goods / services sold / purchased shall be ₹25,00,000',
      'Separate collection accounts – ICA and ECA – shall be maintained',
    ],
    chunks: [
      {
        id: 'rbi-pa-cb-4.4',
        section: 'Annex paragraph 4.4',
        summary: 'For PA-CB import transactions above ₹2.5 lakh per unit, the PA-CB must also perform buyer due diligence.',
        quote: 'the concerned PA-CB shall undertake due diligence of buyer also',
        tags: ['india', 'import', 'outward', 'buyer', 'due diligence', 'kyc', 'threshold'],
        appliesToBooks: ['IN-GB-OUTWARD'],
      },
      {
        id: 'rbi-pa-cb-6.1',
        section: 'Annex paragraph 6.1',
        summary: 'A PA-CB handling imports and exports must keep the import and export collection accounts separate.',
        quote: 'Separate collection accounts – ICA and ECA – shall be maintained',
        tags: ['india', 'inward', 'outward', 'ledger', 'separation', 'ica', 'eca'],
        appliesToBooks: BOTH,
      },
      {
        id: 'rbi-pa-cb-8.2',
        section: 'Annex paragraph 8.2',
        summary: 'A PA-CB may process at most ₹25 lakh per unit of goods or services.',
        quote: 'the maximum value per unit of goods / services sold / purchased shall be ₹25,00,000',
        tags: ['india', 'import', 'export', 'cap', 'threshold', 'goods', 'services'],
        appliesToBooks: BOTH,
      },
    ],
  },
  {
    id: 'rbi-import-goods-services-2024-08-29',
    title: 'Master Direction – Import of Goods and Services',
    authority: 'RBI',
    jurisdiction: 'IN',
    sourceUri: 'https://www.rbi.org.in/Scripts/BS_ViewMasDirections.aspx?id=10201',
    officialDocumentDate: '2024-08-29',
    approvedVersion: 'RBI-FED-2016-17-12@2024-08-29',
    approvedAt: '2026-09-04',
    allowedHosts: ['www.rbi.org.in', 'rbi.org.in'],
    approvedMarkers: [
      'Master Direction – Import of Goods and Services',
      'Updated as on August 29, 2024',
      'Import of Goods and Services into India is being allowed in terms of Section 5',
    ],
    chunks: [{
      id: 'rbi-import-introduction',
      section: 'Introduction',
      summary: 'Indian import payments operate under FEMA current-account rules and through Authorised Dealer Category-I banks.',
      quote: 'Import of Goods and Services into India is being allowed in terms of Section 5',
      tags: ['india', 'import', 'outward', 'fema', 'authorised dealer', 'supplier'],
      appliesToBooks: ['IN-GB-OUTWARD'],
    }],
  },
  {
    id: 'rbi-other-remittance-2024-09-06',
    title: 'Master Direction – Other Remittance Facilities',
    authority: 'RBI',
    jurisdiction: 'IN',
    sourceUri: 'https://www.rbi.org.in/Scripts/BS_ViewMasDirections.aspx?id=10193',
    officialDocumentDate: '2024-09-06',
    approvedVersion: 'RBI-FED-MD-8-2015-16@2024-09-06',
    approvedAt: '2026-09-04',
    allowedHosts: ['www.rbi.org.in', 'rbi.org.in'],
    approvedMarkers: [
      'Master Direction - Other Remittance Facilities',
      'Updated as on September 06, 2024',
      'For payments other than imports and remittances covering intermediary trade transactions',
    ],
    chunks: [{
      id: 'rbi-other-remittance-6.4-6.5',
      section: 'Paragraphs 6.4–6.5',
      summary: 'Form A2 applies to covered cross-border remittances, but paragraph 6.4 expressly distinguishes imports and intermediary trade.',
      quote: 'For payments other than imports and remittances covering intermediary trade transactions',
      tags: ['india', 'outward', 'form a2', 'fema', 'remittance', 'documents'],
      appliesToBooks: ['IN-GB-OUTWARD'],
    }],
  },
  {
    id: 'india-income-tax-form-15ca',
    title: 'Form 15CA FAQs',
    authority: 'INDIA_INCOME_TAX',
    jurisdiction: 'IN',
    sourceUri: 'https://www.incometax.gov.in/iec/foportal/help/statutory-forms/popular-forms/form-15ca-faq',
    approvedVersion: 'INCOME-TAX-FORM-15CA-OBSERVED-2026-09-04',
    approvedAt: '2026-09-04',
    allowedHosts: ['www.incometax.gov.in', 'incometax.gov.in'],
    approvedMarkers: [
      'Form 15CA FAQs',
      'before remitting the payment',
      'In certain cases, a Certificate from Chartered Accountant in form 15CB is required',
    ],
    chunks: [{
      id: 'income-tax-15ca-purpose',
      section: 'FAQs 1–4',
      summary: 'Form 15CA reports qualifying payments to a non-resident or foreign company; some taxable remittances require a Form 15CB accountant certificate.',
      quote: 'A person responsible for making such remittance has to submit the form 15CA',
      tags: ['india', 'outward', 'tax', 'form 15ca', 'form 15cb', 'non-resident'],
      appliesToBooks: ['IN-GB-OUTWARD'],
    }],
  },
  {
    id: 'eu-transfer-of-funds-2023-1113',
    title: 'Regulation (EU) 2023/1113 on information accompanying transfers of funds and certain crypto-assets',
    authority: 'EU',
    jurisdiction: 'EU',
    sourceUri: 'https://eur-lex.europa.eu/legal-content/EN/ALL/?uri=CELEX%3A32023R1113',
    refreshUri: 'https://publications.europa.eu/resource/cellar/48eca7a6-0660-11ee-b12e-01aa75ed71a1/rdf/object/full',
    officialDocumentDate: '2023-05-31',
    approvedVersion: 'CELEX-32023R1113@observed-2026-09-04',
    approvedAt: '2026-09-04',
    allowedHosts: ['eur-lex.europa.eu', 'publications.europa.eu'],
    approvedMarkers: [
      'http://publications.europa.eu/resource/celex/32023R1113',
      'http://publications.europa.eu/resource/eli/reg/2023/1113/oj',
      'http://publications.europa.eu/resource/consolidation/2023R1113%2F20230609',
    ],
    chunks: [
      {
        id: 'eu-tfr-article-4',
        section: 'Article 4',
        summary: 'An EU payer PSP must ensure a transfer carries specified payer and payee information or a traceable unique transaction identifier.',
        quote: 'Information accompanying transfers of funds',
        tags: ['eu', 'poland', 'payer', 'payee', 'payment service provider', 'traceability'],
        appliesToBooks: ['PL-IN-INWARD'],
      },
      {
        id: 'eu-tfr-articles-25-26',
        section: 'Articles 25–26',
        summary: 'Transfer information is subject to GDPR purpose limitation and generally a five-year regulatory retention period.',
        quote: 'Personal data shall be processed ... only for the purposes of the prevention of money laundering',
        tags: ['eu', 'poland', 'privacy', 'gdpr', 'retention', 'aml'],
        appliesToBooks: ['PL-IN-INWARD'],
      },
    ],
  },
  {
    id: 'poland-aml-act-landing-2025-04-17',
    title: 'Polish Ministry of Finance AML/CFT legislation',
    authority: 'POLAND_MINISTRY_OF_FINANCE',
    jurisdiction: 'PL',
    sourceUri: 'https://www.gov.pl/web/finance/legislation-aml-ctf',
    officialDocumentDate: '2025-04-17',
    approvedVersion: 'PL-MOF-AML-LEGISLATION@2025-04-17',
    approvedAt: '2026-09-04',
    allowedHosts: ['www.gov.pl', 'gov.pl'],
    approvedMarkers: [
      'Act of 1 March 2018 on counteracting money laundering and financing of terrorism',
      'The only binding text is the Polish text of these documents',
      '17.04.2025',
    ],
    chunks: [{
      id: 'poland-aml-act-status',
      section: 'Legislation notice',
      summary: 'The Polish AML/CFT Act is the national legal baseline; the Ministry warns that its English translation is informational and the Polish text is binding.',
      quote: 'The only binding text is the Polish text of these documents',
      tags: ['poland', 'aml', 'cft', 'customer due diligence', 'binding language'],
      appliesToBooks: ['PL-IN-INWARD'],
    }],
  },
  {
    id: 'poland-cesop-cross-border-payments',
    title: 'Poland: Payment Services Providers – cross-border transaction records',
    authority: 'POLAND_MINISTRY_OF_FINANCE',
    jurisdiction: 'PL',
    sourceUri: 'https://www.gov.pl/web/national-revenue-administration/payment-services-providers',
    approvedVersion: 'PL-CESOP-PSP-2024',
    approvedAt: '2026-09-04',
    allowedHosts: ['www.gov.pl', 'gov.pl'],
    approvedMarkers: [
      'From 1 January 2024, Payment Service Providers have new obligations',
      'more than 25 payments to the same payment recipient',
      'The period for which the records are kept by payment service providers is 3 years',
    ],
    chunks: [{
      id: 'poland-cesop-records',
      section: 'Obligation to keep records',
      summary: 'Polish CESOP reporting may apply when a PSP makes more than 25 cross-border payments to the same recipient in a calendar quarter; records are retained for three years.',
      quote: 'more than 25 payments to the same payment recipient in a given Member State during a calendar quarter',
      tags: ['poland', 'cesop', 'cross-border', 'records', 'reporting', 'payment service provider'],
      appliesToBooks: ['PL-IN-INWARD'],
    }],
  },
] as const;

export function approvedCorpusHash(sources: readonly ApprovedRegulationSource[] = APPROVED_REGULATION_SOURCES): string {
  return canonicalHash(sources.map((source) => ({
    id: source.id,
    approvedVersion: source.approvedVersion,
    chunks: source.chunks,
  })));
}
