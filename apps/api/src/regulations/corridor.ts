import { APPROVED_REGULATION_SOURCES, approvedCorpusHash } from './catalog.js';
import {
  assessCorridorCoverage,
  CORRIDOR_COVERAGE_PROFILES,
  type CorridorCoverageAssessment,
} from './coverage.js';
import { refreshOfficialRegulations } from './refresh.js';
import type {
  ApprovedRegulationSource,
  RegulationCorridor,
  RegulationRefreshReport,
} from './types.js';

export interface CorridorRegulationCheck {
  readonly mode: 'fixture' | 'live';
  readonly report: RegulationRefreshReport;
  readonly coverage: CorridorCoverageAssessment;
}

/** Only fetch publishers that contain a reviewed section for this ordered book. */
export function regulationSourcesForBook(
  bookId: RegulationCorridor,
  sources: readonly ApprovedRegulationSource[] = APPROVED_REGULATION_SOURCES,
): readonly ApprovedRegulationSource[] {
  const profile = CORRIDOR_COVERAGE_PROFILES.find((candidate) => candidate.bookId === bookId);
  if (!profile) return [];
  const requiredSourceIds = new Set(profile.obligations.flatMap((obligation) =>
    obligation.sourceReferences.map((reference) => reference.sourceId)));
  return sources.filter((source) => requiredSourceIds.has(source.id));
}

function fixtureReport(
  sources: readonly ApprovedRegulationSource[],
  checkedAt: Date,
): RegulationRefreshReport {
  return {
    schemaVersion: '1.0',
    checkedAt: checkedAt.toISOString(),
    approvedCorpusHash: approvedCorpusHash(sources),
    observations: sources.map((source) => ({
      sourceId: source.id,
      approvedVersion: source.approvedVersion,
      sourceUri: source.sourceUri,
      checkedAt: checkedAt.toISOString(),
      status: 'UNCHANGED' as const,
      missingMarkers: [],
      note: 'Deterministic offline acceptance used the reviewed local source record.',
      advisoryOnly: true as const,
    })),
    requiresHumanReview: false,
    rulesChanged: false,
  };
}

/**
 * Runs the regulation precondition used by both previews and actual payments.
 * A network observation is evidence, not executable law: changed markers hold
 * the transaction until a human approves a new source-controlled ruleset.
 */
export async function checkCorridorRegulations(input: {
  readonly bookId: RegulationCorridor;
  readonly mode: 'fixture' | 'live';
  readonly checkedAt: Date;
}): Promise<CorridorRegulationCheck> {
  const sources = regulationSourcesForBook(input.bookId);
  const report = input.mode === 'live'
    ? await refreshOfficialRegulations({ sources, checkedAt: input.checkedAt })
    : fixtureReport(sources, input.checkedAt);
  return {
    mode: input.mode,
    report,
    coverage: assessCorridorCoverage(
      { bookId: input.bookId, evaluatedAt: input.checkedAt, refreshReport: report },
      { sources },
    ),
  };
}
