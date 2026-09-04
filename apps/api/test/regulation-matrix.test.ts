import { describe, expect, it } from 'vitest';
import {
  assessCorridorCoverage,
  CORRIDOR_COVERAGE_PROFILES,
  REQUIRED_OBLIGATION_CATEGORIES,
} from '../src/regulations/coverage.js';
import { APPROVED_REGULATION_SOURCES } from '../src/regulations/catalog.js';
import { planDealRegulations } from '../src/regulations/planner.js';
import { retrieveRegulations } from '../src/regulations/retrieval.js';
import {
  REGULATION_CORRIDOR_MATRIX,
  REGULATION_COUNTRIES,
  type RegulationCorridor,
} from '../src/regulations/types.js';

const evaluatedAt = new Date('2026-09-04T12:00:00.000Z');
const executable = new Set<RegulationCorridor>([
  'PL-IN-INWARD', 'PL-GB-OUTWARD', 'PL-DE-OUTWARD',
  'IN-PL-OUTWARD', 'IN-GB-OUTWARD', 'IN-DE-OUTWARD',
  'GB-PL-OUTWARD', 'GB-IN-INWARD', 'GB-DE-OUTWARD',
  'DE-PL-OUTWARD', 'DE-IN-INWARD', 'DE-GB-OUTWARD',
]);

const isDprk = (bookId: RegulationCorridor): boolean => {
  const [origin, destination] = bookId.split('-');
  return origin === 'KP' || destination === 'KP';
};

const isRussia = (bookId: RegulationCorridor): boolean => {
  const [origin, destination] = bookId.split('-');
  return origin === 'RU' || destination === 'RU';
};

describe('six-country ordered regulation matrix', () => {
  it('contains every directed non-self pair exactly once', () => {
    expect(REGULATION_COUNTRIES).toHaveLength(6);
    expect(REGULATION_CORRIDOR_MATRIX).toHaveLength(30);
    expect(new Set(REGULATION_CORRIDOR_MATRIX).size).toBe(30);

    const pairs = new Set(REGULATION_CORRIDOR_MATRIX.map((bookId) => {
      const [origin, destination, direction] = bookId.split('-');
      expect(REGULATION_COUNTRIES).toContain(origin);
      expect(REGULATION_COUNTRIES).toContain(destination);
      expect(origin).not.toBe(destination);
      expect(direction).toBe(destination === 'IN' ? 'INWARD' : 'OUTWARD');
      return `${origin}-${destination}`;
    }));
    for (const origin of REGULATION_COUNTRIES) {
      for (const destination of REGULATION_COUNTRIES) {
        if (origin !== destination) expect(pairs).toContain(`${origin}-${destination}`);
      }
    }
  });

  it('has one explicit five-category profile and exact hard gate per matrix route', () => {
    expect(CORRIDOR_COVERAGE_PROFILES).toHaveLength(30);
    expect(new Set(CORRIDOR_COVERAGE_PROFILES.map((profile) => profile.bookId)).size).toBe(30);

    for (const bookId of REGULATION_CORRIDOR_MATRIX) {
      const profile = CORRIDOR_COVERAGE_PROFILES.find((candidate) => candidate.bookId === bookId);
      expect(profile).toBeDefined();
      expect(profile?.obligations.map((item) => item.category).sort())
        .toEqual([...REQUIRED_OBLIGATION_CATEGORIES].sort());
      for (const obligation of profile?.obligations ?? []) {
        expect(obligation.sourceReferences.length, `${bookId}/${obligation.category}`).toBeGreaterThan(0);
        for (const sourceReference of obligation.sourceReferences) {
          const source = APPROVED_REGULATION_SOURCES.find((candidate) => candidate.id === sourceReference.sourceId);
          expect(source, `${bookId}/${sourceReference.sourceId}`).toBeDefined();
          expect(source?.approvedVersion).toBe(sourceReference.sourceVersion);
          for (const chunkId of sourceReference.chunkIds) {
            const chunk = source?.chunks.find((candidate) => candidate.id === chunkId);
            expect(chunk, `${bookId}/${sourceReference.sourceId}/${chunkId}`).toBeDefined();
            expect(chunk?.appliesToBooks, `${bookId}/${sourceReference.sourceId}/${chunkId}`).toContain(bookId);
          }
        }
      }

      const retrieved = retrieveRegulations({ query: '', bookId, limit: 20 });
      expect(retrieved.results.length, `${bookId} RAG`).toBeGreaterThan(0);
      expect(retrieved.results.every((result) => result.citation.sourceUri.startsWith('https://'))).toBe(true);

      const assessment = assessCorridorCoverage({ bookId, evaluatedAt });
      if (isDprk(bookId)) {
        expect(assessment.outcome).toBe('BLOCKED');
        expect(assessment.hardGate).toEqual({ canQuoteOrFund: false, code: 'REGULATORY_BLOCKED' });
        expect(assessment.checks.some((check) => check.status === 'BLOCKED')).toBe(true);
      } else if (executable.has(bookId)) {
        expect(assessment.outcome).toBe('PASSED');
        expect(assessment.hardGate).toEqual({ canQuoteOrFund: true, code: 'REGULATORY_COVERAGE_PASSED' });
      } else {
        expect(assessment.outcome).toBe('MANUAL_REVIEW');
        expect(assessment.hardGate).toEqual({ canQuoteOrFund: false, code: 'MANUAL_REVIEW_REQUIRED' });
      }
    }
  });

  it('blocks every DPRK-involved fact plan using the source-backed product gate', () => {
    for (const bookId of REGULATION_CORRIDOR_MATRIX.filter(isDprk)) {
      const [originCountry, destinationCountry, direction] = bookId.split('-') as [string, string, 'INWARD' | 'OUTWARD'];
      const plan = planDealRegulations({
        originCountry,
        destinationCountry,
        direction,
        purposeCode: 'GENERIC_DEMO',
        purposeType: 'GOODS',
        originPartyType: 'COMPANY',
        destinationPartyType: 'SUPPLIER',
        evaluatedAt,
      });
      expect(plan.outcome).toBe('BLOCKED');
      expect(plan.hardGate).toMatchObject({ canQuoteOrFund: false, code: 'REGULATORY_BLOCKED' });
      expect(plan.applicableSourceIds).toContain('un-security-council-dprk-1718');
    }
  });

  it('composes reviewed service controls for every deployed PL/IN/GB/DE route', () => {
    for (const bookId of executable) {
      const [originCountry, destinationCountry, direction] = bookId.split('-') as [string, string, 'INWARD' | 'OUTWARD'];
      const purposeCode = destinationCountry === 'IN'
        ? 'P0802'
        : originCountry === 'IN' ? 'S0102' : 'B2B_DIGITAL_SERVICES';
      const plan = planDealRegulations({
        originCountry,
        destinationCountry,
        direction,
        purposeCode,
        purposeType: 'SERVICES',
        originPartyType: 'COMPANY',
        destinationPartyType: 'FREELANCER',
        evaluatedAt,
      });
      expect(plan.outcome, bookId).toBe('PASSED');
      expect(plan.uncoveredJurisdictions, bookId).toEqual([]);
      expect(plan.categories.every((category) => category.status === 'COVERED'), bookId).toBe(true);
      expect(plan.hardGate.canQuoteOrFund, bookId).toBe(true);
    }
  });

  it('holds all eight Russia routes using source-backed five-category modules', () => {
    const books = REGULATION_CORRIDOR_MATRIX.filter(isRussia).filter((bookId) => !isDprk(bookId));
    expect(books).toHaveLength(8);
    for (const bookId of books) {
      const [originCountry, destinationCountry, direction] = bookId.split('-') as [string, string, 'INWARD' | 'OUTWARD'];
      const plan = planDealRegulations({
        originCountry,
        destinationCountry,
        direction,
        purposeCode: destinationCountry === 'IN' ? 'P0802' : originCountry === 'IN' ? 'S0102' : 'B2B_DIGITAL_SERVICES',
        purposeType: 'SERVICES',
        originPartyType: 'COMPANY',
        destinationPartyType: 'FREELANCER',
        evaluatedAt,
      });
      expect(plan.outcome, bookId).toBe('MANUAL_REVIEW');
      expect(plan.hardGate, bookId).toMatchObject({ canQuoteOrFund: false, code: 'MANUAL_REVIEW_REQUIRED' });
      expect(plan.applicableSourceIds, bookId).toContain('russia-cross-border-transfers-2026');
      for (const category of plan.categories) {
        expect(category.status, `${bookId}/${category.category}`).toBe('MANUAL_REVIEW');
        expect(category.sourceReferences.length, `${bookId}/${category.category}`).toBeGreaterThan(0);
      }
    }
  });
});
