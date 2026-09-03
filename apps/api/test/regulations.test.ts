import { describe, expect, it, vi } from 'vitest';
import { APPROVED_REGULATION_SOURCES } from '../src/regulations/catalog.js';
import {
  explainRegulationRefresh,
  refreshOfficialRegulations,
} from '../src/regulations/refresh.js';
import { retrieveRegulations } from '../src/regulations/retrieval.js';

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
