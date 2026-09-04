import { describe, expect, it, vi } from 'vitest';
import { APPROVED_REGULATION_SOURCES } from '../src/regulations/catalog.js';
import {
  explainRegulationRefresh,
  refreshOfficialRegulations,
} from '../src/regulations/refresh.js';
import { retrieveRegulations } from '../src/regulations/retrieval.js';
import { checkCorridorRegulations, regulationSourcesForBook } from '../src/regulations/corridor.js';
import {
  applyCoverageOutcome,
  assessCorridorCoverage,
  CORRIDOR_COVERAGE_PROFILES,
  REQUIRED_OBLIGATION_CATEGORIES,
} from '../src/regulations/coverage.js';

const source = APPROVED_REGULATION_SOURCES[0]!;
const checkedAt = new Date('2026-09-04T00:00:00.000Z');

describe('official regulation refresh', () => {
  it('reports unchanged only when every reviewed marker remains present', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      `<html><body>${source.approvedMarkers.join(' -- ')}</body></html>`,
      { status: 200, headers: { 'content-type': 'text/html' } },
    ));
    const report = await refreshOfficialRegulations({ sources: [source], fetchImpl, checkedAt });
    expect(report.rulesChanged).toBe(false);
    expect(report.requiresHumanReview).toBe(false);
    expect(report.observations[0]).toMatchObject({ status: 'UNCHANGED', missingMarkers: [] });
  });

  it('requires human review but never updates rules when a legal marker changes', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      `<html><body>${source.approvedMarkers[0]} replacement legal text</body></html>`,
      { status: 200 },
    ));
    const report = await refreshOfficialRegulations({ sources: [source], fetchImpl, checkedAt });
    expect(report.requiresHumanReview).toBe(true);
    expect(report.rulesChanged).toBe(false);
    expect(report.observations[0]?.status).toBe('REVIEW_REQUIRED');
    expect(report.observations[0]?.missingMarkers).toEqual(source.approvedMarkers.slice(1));
  });

  it('treats a successful anti-bot or unrelated page as unavailable, not a legal change', async () => {
    const report = await refreshOfficialRegulations({
      sources: [source],
      checkedAt,
      fetchImpl: async () => new Response('<html><body>Challenge page</body></html>', { status: 200 }),
    });
    expect(report.requiresHumanReview).toBe(false);
    expect(report.observations[0]?.status).toBe('UNAVAILABLE');
  });

  it('blocks cross-host redirects and retains the deterministic approved fallback', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: 'https://attacker.example/regulation' },
    }));
    const report = await refreshOfficialRegulations({ sources: [source], fetchImpl, checkedAt });
    expect(report.observations[0]).toMatchObject({ status: 'UNAVAILABLE', advisoryOnly: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('uses deterministic explanation when an optional AI explainer fails', async () => {
    const report = await refreshOfficialRegulations({
      sources: [source],
      checkedAt,
      fetchImpl: async () => new Response('offline', { status: 503 }),
    });
    const explanation = await explainRegulationRefresh(report, async () => { throw new Error('provider down'); });
    expect(explanation.source).toBe('DETERMINISTIC');
    expect(explanation.summary).toContain('No approved compliance rule was changed');
  });
});

describe('approved-corpus retrieval', () => {
  it('filters by corridor and ranks deterministically', () => {
    const first = retrieveRegulations({ query: 'buyer due diligence threshold import', bookId: 'IN-GB-OUTWARD' });
    const second = retrieveRegulations({ query: 'buyer due diligence threshold import', bookId: 'IN-GB-OUTWARD' });
    expect(first).toEqual(second);
    expect(first.approvedSourcesOnly).toBe(true);
    expect(first.results[0]?.citation.sourceId).toBe('rbi-pa-cb-2023-10-31');
    expect(first.results[0]?.citation.section).toBe('Annex paragraph 4.4');
    expect(first.results.every((result) => result.citation.sourceId !== 'poland-cesop-cross-border-payments')).toBe(true);
  });

  it('does not return irrelevant unapproved network text', () => {
    const result = retrieveRegulations({ query: 'totally-unknown-new-rule', bookId: 'PL-IN-INWARD' });
    expect(result.results).toEqual([]);
  });
});

describe('corridor regulation coverage gate', () => {
  it('refreshes exactly the official sources declared by the corridor coverage profile', async () => {
    const sourceIds = regulationSourcesForBook('PL-IN-INWARD').map((item) => item.id);
    expect(sourceIds).toEqual([
      'rbi-pa-cb-2023-10-31',
      'eu-transfer-of-funds-2023-1113',
      'poland-aml-act-landing-2025-04-17',
      'poland-cesop-cross-border-payments',
    ]);
    const checked = await checkCorridorRegulations({
      bookId: 'PL-IN-INWARD', mode: 'fixture', checkedAt: new Date('2026-09-03T12:00:00.000Z'),
    });
    expect(checked.coverage.outcome).toBe('PASSED');
    expect(checked.report.observations).toHaveLength(4);
  });

  it('declares every obligation category for every supported corridor', () => {
    expect(CORRIDOR_COVERAGE_PROFILES).toHaveLength(30);
    for (const profile of CORRIDOR_COVERAGE_PROFILES) {
      expect(profile.obligations.map((obligation) => obligation.category).sort())
        .toEqual([...REQUIRED_OBLIGATION_CATEGORIES].sort());
      const assessment = assessCorridorCoverage({
        bookId: profile.bookId,
        evaluatedAt: new Date('2026-09-04T12:00:00.000Z'),
      });
      expect(assessment.outcome).toBe(profile.disposition === 'EXECUTABLE'
        ? 'PASSED' : profile.disposition === 'BLOCKED' ? 'BLOCKED' : 'MANUAL_REVIEW');
      expect(assessment.hardGate.canQuoteOrFund).toBe(profile.disposition === 'EXECUTABLE');
    }
  });

  it('forces manual review when a corridor profile is missing', () => {
    const assessment = assessCorridorCoverage(
      { bookId: 'PL-IN-INWARD', evaluatedAt: new Date('2026-09-04T12:00:00.000Z') },
      { profiles: [] },
    );
    expect(assessment.outcome).toBe('MANUAL_REVIEW');
    expect(assessment.checks.every((check) => check.status === 'MISSING')).toBe(true);
  });

  it('forces manual review after the declared review deadline', () => {
    const assessment = assessCorridorCoverage({
      bookId: 'PL-IN-INWARD',
      evaluatedAt: new Date('2026-10-04T00:00:00.000Z'),
    });
    expect(assessment.outcome).toBe('MANUAL_REVIEW');
    expect(assessment.checks.every((check) => check.status === 'STALE')).toBe(true);
    expect(applyCoverageOutcome('PASSED', assessment)).toBe('MANUAL_REVIEW');
    expect(applyCoverageOutcome('BLOCKED', assessment)).toBe('BLOCKED');
  });

  it('holds a corridor when an applicable official source changed but does not mutate rules', () => {
    const assessment = assessCorridorCoverage({
      bookId: 'IN-GB-OUTWARD',
      evaluatedAt: new Date('2026-09-04T12:00:00.000Z'),
      refreshReport: {
        schemaVersion: '1.0',
        checkedAt: '2026-09-04T11:59:00.000Z',
        approvedCorpusHash: 'a'.repeat(64),
        observations: [{
          sourceId: 'rbi-pa-cb-2023-10-31',
          approvedVersion: 'RBI-2023-24-80',
          sourceUri: source.sourceUri,
          checkedAt: '2026-09-04T11:59:00.000Z',
          status: 'REVIEW_REQUIRED',
          missingMarkers: ['reviewed marker'],
          note: 'Human review required.',
          advisoryOnly: true,
        }],
        requiresHumanReview: true,
        rulesChanged: false,
      },
    });
    expect(assessment.outcome).toBe('MANUAL_REVIEW');
    expect(assessment.checks.some((check) => check.status === 'SOURCE_REVIEW_REQUIRED')).toBe(true);
  });

  it('forces manual review when a pinned source version is absent', () => {
    const assessment = assessCorridorCoverage(
      { bookId: 'PL-IN-INWARD', evaluatedAt: new Date('2026-09-04T12:00:00.000Z') },
      { sources: APPROVED_REGULATION_SOURCES.filter((candidate) => candidate.id !== 'poland-aml-act-landing-2025-04-17') },
    );
    expect(assessment.outcome).toBe('MANUAL_REVIEW');
    expect(assessment.reasons.some((reason) => reason.includes('is missing'))).toBe(true);
  });

  it('rejects malformed coverage dates and mismatched refresh evidence', () => {
    const base = CORRIDOR_COVERAGE_PROFILES[0]!;
    const malformed = assessCorridorCoverage(
      { bookId: base.bookId, evaluatedAt: new Date('2026-09-04T12:00:00.000Z') },
      { profiles: [{ ...base, reviewBy: 'not-a-date' }] },
    );
    expect(malformed.outcome).toBe('MANUAL_REVIEW');
    expect(malformed.reasons[0]).toContain('invalid reviewed/effective metadata');

    const mismatched = assessCorridorCoverage({
      bookId: base.bookId,
      evaluatedAt: new Date('2026-09-04T12:00:00.000Z'),
      refreshReport: {
        schemaVersion: '1.0',
        checkedAt: '2026-09-04T11:59:00.000Z',
        approvedCorpusHash: 'different-corpus',
        observations: [],
        requiresHumanReview: false,
        rulesChanged: false,
      },
    });
    expect(mismatched.outcome).toBe('MANUAL_REVIEW');
    expect(mismatched.checks.every((check) => check.status === 'SOURCE_REVIEW_REQUIRED')).toBe(true);
  });
});
