import { describe, expect, it } from 'vitest';
import {
  planDealRegulations,
  regulationSourcesForPlan,
  type DealRegulatoryFacts,
} from '../src/regulations/planner.js';

const at = new Date('2026-09-04T12:00:00.000Z');
const plan = (input: Omit<DealRegulatoryFacts, 'evaluatedAt'>) =>
  planDealRegulations({ ...input, evaluatedAt: at });

describe('deal-derived regulatory planner', () => {
  it('composes the Poland to India freelancer plan from both jurisdictions', () => {
    const result = plan({
      originCountry: 'PL', destinationCountry: 'IN', direction: 'INWARD',
      purposeCode: 'P0802', purposeType: 'SERVICES',
      originPartyType: 'COMPANY', destinationPartyType: 'FREELANCER',
    });
    expect(result.bookId).toBe('PL-IN-INWARD');
    expect(result.outcome).toBe('PASSED');
    expect(result.categories.every((category) => category.status === 'COVERED')).toBe(true);
    expect(result.categories.find((category) => category.category === 'SANCTIONS_AML')?.moduleIds)
      .toEqual(expect.arrayContaining(['india-export-aml', 'poland-origin-aml']));
    expect(result.requiredDocuments).toEqual(expect.arrayContaining([
      'INVOICE', 'SERVICE_EXPORT_DECLARATION', 'PAYER_PAYEE_TRANSFER_DATA',
    ]));
    expect(result.hardGate).toMatchObject({ canQuoteOrFund: true, code: 'REGULATORY_PLAN_PASSED' });
  });

  it('passes the reviewed India to UK goods-supplier scope with exact controls and documents', () => {
    const result = plan({
      originCountry: 'IN', destinationCountry: 'GB', direction: 'OUTWARD',
      purposeCode: 'S0102', purposeType: 'GOODS',
      originPartyType: 'COMPANY', destinationPartyType: 'SUPPLIER',
    });
    expect(result.bookId).toBe('IN-GB-OUTWARD');
    expect(result.outcome).toBe('PASSED');
    expect(result.categories.find((category) => category.category === 'TAX')?.moduleIds)
      .toContain('india-outward-tax');
    expect(regulationSourcesForPlan(result).map((source) => source.id))
      .toEqual(expect.arrayContaining([
        'rbi-pa-cb-2023-10-31', 'india-income-tax-form-15ca',
        'uk-financial-sanctions-guidance', 'uk-vat-export-goods', 'uk-export-declaration',
      ]));
    expect(result.requiredDocuments).toEqual(expect.arrayContaining([
      'INVOICE', 'IMPORT_EVIDENCE', 'FORM_A2_DEMO', 'TAX_REVIEW_DEMO', 'FORM_15CA_CONDITIONAL',
      'UK_SANCTIONS_SCREENING', 'PAYEE_TRANSACTION_RECORD', 'UK_EXPORT_VAT_EVIDENCE',
      'PACKING_LIST', 'UK_EXPORT_DECLARATION', 'COMMODITY_CODE', 'EXPORT_LICENCE_IF_REQUIRED',
    ]));
    expect(result.controls.find((control) => control.controlCode === 'INDIA_OUTWARD_TAX_REVIEW'))
      .toMatchObject({ responsibleParty: 'ORIGIN' });
    expect(result.uncoveredJurisdictions).toEqual([]);
    expect(result.hardGate).toEqual({ canQuoteOrFund: true, code: 'REGULATORY_PLAN_PASSED', reasons: [] });
  });

  it('passes only the separately reviewed India to UK services-supplier scope', () => {
    const result = plan({
      originCountry: 'IN', destinationCountry: 'GB', direction: 'OUTWARD',
      purposeCode: 'S0102', purposeType: 'SERVICES',
      originPartyType: 'COMPANY', destinationPartyType: 'SUPPLIER',
    });
    expect(result.outcome).toBe('PASSED');
    expect(result.categories.find((category) => category.category === 'TAX')?.moduleIds)
      .toEqual(expect.arrayContaining(['india-outward-tax', 'uk-services-export-tax']));
    expect(result.requiredDocuments).toEqual(expect.arrayContaining([
      'B2B_CUSTOMER_STATUS', 'SERVICE_PLACE_OF_SUPPLY_ASSESSMENT', 'SERVICE_CLASSIFICATION',
    ]));
    expect(result.requiredDocuments).not.toContain('UK_EXPORT_DECLARATION');
  });

  it('composes Poland origin and UK destination controls for a UK freelancer', () => {
    const result = plan({
      originCountry: 'PL', destinationCountry: 'GB', direction: 'OUTWARD',
      purposeCode: 'B2B_DIGITAL_SERVICES', purposeType: 'SERVICES',
      originPartyType: 'COMPANY', destinationPartyType: 'FREELANCER',
    });
    expect(result.bookId).toBe('PL-GB-OUTWARD');
    expect(result.outcome).toBe('PASSED');
    expect(result.categories.every((category) => category.status === 'COVERED')).toBe(true);
    expect(result.categories.find((category) => category.category === 'SANCTIONS_AML')?.moduleIds)
      .toEqual(expect.arrayContaining(['poland-origin-aml', 'uk-destination-sanctions']));
    expect(result.categories.find((category) => category.category === 'TAX')?.moduleIds)
      .toEqual(expect.arrayContaining(['poland-origin-tax-reporting', 'uk-services-export-tax']));
    expect(result.requiredDocuments).toEqual(expect.arrayContaining([
      'INVOICE', 'PAYER_PAYEE_TRANSFER_DATA', 'UK_SANCTIONS_SCREENING',
      'B2B_CUSTOMER_STATUS', 'SERVICE_PLACE_OF_SUPPLY_ASSESSMENT', 'SERVICE_CLASSIFICATION',
    ]));
    expect(regulationSourcesForPlan(result).map((source) => source.id)).toEqual(expect.arrayContaining([
      'poland-aml-act-landing-2025-04-17', 'eu-transfer-of-funds-2023-1113',
      'uk-financial-sanctions-guidance', 'uk-vat-export-services', 'uk-invoice-requirements',
    ]));
    expect(result.hardGate).toEqual({ canQuoteOrFund: true, code: 'REGULATORY_PLAN_PASSED', reasons: [] });
  });

  it('passes UK to India after composing the reviewed UK-origin and India-destination modules', () => {
    const result = plan({
      originCountry: 'GB', destinationCountry: 'IN', direction: 'INWARD',
      purposeCode: 'P0802', purposeType: 'SERVICES',
      originPartyType: 'COMPANY', destinationPartyType: 'FREELANCER',
    });
    expect(result.bookId).toBe('GB-IN-INWARD');
    expect(result.outcome).toBe('PASSED');
    expect(result.categories.find((category) => category.category === 'TAX')).toMatchObject({ status: 'COVERED' });
    expect(result.uncoveredJurisdictions).toEqual([]);
    expect(result.hardGate).toMatchObject({ canQuoteOrFund: true, code: 'REGULATORY_PLAN_PASSED' });
  });

  it('composes EU evidence and authorizes the deployed Germany to Poland rail', () => {
    const result = plan({
      originCountry: 'DE', destinationCountry: 'PL', direction: 'OUTWARD',
      purposeCode: 'B2B_DIGITAL_SERVICES', purposeType: 'SERVICES',
      originPartyType: 'COMPANY', destinationPartyType: 'COMPANY',
    });
    expect(result.outcome).toBe('PASSED');
    expect(result.categories.find((category) => category.category === 'TAX')?.moduleIds).toContain('eu-b2b-tax');
    expect(result.categories.find((category) => category.category === 'INVOICING_REPORTING')?.moduleIds)
      .toContain('eu-b2b-invoicing');
    expect(result.hardGate).toMatchObject({ canQuoteOrFund: true, code: 'REGULATORY_PLAN_PASSED' });
  });

  it('holds Poland to Russia for current human sanctions review', () => {
    const result = plan({
      originCountry: 'PL', destinationCountry: 'RU', direction: 'OUTWARD',
      purposeCode: 'B2B_SERVICES', purposeType: 'SERVICES',
      originPartyType: 'COMPANY', destinationPartyType: 'SUPPLIER',
    });
    expect(result.outcome).toBe('MANUAL_REVIEW');
    expect(result.categories.find((category) => category.category === 'SANCTIONS_AML')).toMatchObject({ status: 'MANUAL_REVIEW' });
    expect(result.applicableSourceIds).toContain('eu-financial-sanctions-overview');
    expect(result.hardGate.canQuoteOrFund).toBe(false);
  });

  it('blocks Poland to DPRK because no prior-authorisation path is implemented', () => {
    const result = plan({
      originCountry: 'PL', destinationCountry: 'KP', direction: 'OUTWARD',
      purposeCode: 'HUMANITARIAN_DEMO', purposeType: 'GOODS',
      originPartyType: 'COMPANY', destinationPartyType: 'SUPPLIER',
    });
    expect(result.outcome).toBe('BLOCKED');
    expect(result.categories.filter((category) => category.status === 'BLOCKED').map((category) => category.category))
      .toEqual(expect.arrayContaining(['SANCTIONS_AML', 'PAYMENT_CONTROLS', 'PURPOSE']));
    expect(result.hardGate).toMatchObject({ canQuoteOrFund: false, code: 'REGULATORY_BLOCKED' });
  });

  it('never passes unknown facts or a direction that reverses the ordered route', () => {
    const unknown = plan({
      originCountry: 'CA', destinationCountry: 'BR', direction: 'OUTWARD',
      purposeCode: 'CONSULTING', purposeType: 'SERVICES',
      originPartyType: 'COMPANY', destinationPartyType: 'FREELANCER',
    });
    expect(unknown.outcome).toBe('MANUAL_REVIEW');
    expect(unknown.categories.every((category) => category.status === 'MISSING')).toBe(true);

    const reversed = plan({
      originCountry: 'GB', destinationCountry: 'IN', direction: 'OUTWARD',
      purposeCode: 'P0802', purposeType: 'SERVICES',
      originPartyType: 'COMPANY', destinationPartyType: 'FREELANCER',
    });
    expect(reversed.outcome).toBe('MANUAL_REVIEW');
    expect(reversed.reasons.some((reason) => reason.includes('conflicts with ordered payer route'))).toBe(true);
  });

  it('is deterministic and holds stale modules for manual review', () => {
    const facts = {
      originCountry: 'PL', destinationCountry: 'IN', direction: 'INWARD' as const,
      purposeCode: 'P0802', purposeType: 'SERVICES' as const,
      originPartyType: 'COMPANY' as const, destinationPartyType: 'FREELANCER' as const,
      evaluatedAt: new Date('2026-10-04T00:00:00.000Z'),
    };
    const first = planDealRegulations(facts);
    const second = planDealRegulations(facts);
    expect(first).toEqual(second);
    expect(first.outcome).toBe('MANUAL_REVIEW');
    expect(first.categories.some((category) => category.status === 'STALE')).toBe(true);
    expect(first.planHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(first.coverageScope).toBe('ANCHOR_DEMO_OBLIGATIONS_ONLY');
  });

  it('binds the exact party and purpose facts into the canonical plan hash', () => {
    const supplier = plan({
      originCountry: 'IN', destinationCountry: 'GB', direction: 'OUTWARD',
      purposeCode: 'S0102', purposeType: 'GOODS',
      originPartyType: 'COMPANY', destinationPartyType: 'SUPPLIER',
    });
    const freelancer = plan({
      originCountry: 'IN', destinationCountry: 'GB', direction: 'OUTWARD',
      purposeCode: 'S0102', purposeType: 'GOODS',
      originPartyType: 'COMPANY', destinationPartyType: 'FREELANCER',
    });
    expect(supplier.facts.destinationPartyType).toBe('SUPPLIER');
    expect(supplier.planHash).not.toBe(freelancer.planHash);
    expect(freelancer.outcome).toBe('PASSED');
  });
});
