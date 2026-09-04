export type RegulationAuthority =
  | 'RBI'
  | 'INDIA_INCOME_TAX'
  | 'EU'
  | 'EU_COUNCIL'
  | 'POLAND_MINISTRY_OF_FINANCE'
  | 'GERMAN_BAFIN'
  | 'RUSSIA_CENTRAL_BANK'
  | 'UK_FCA'
  | 'UK_GOVERNMENT'
  | 'UN_SECURITY_COUNCIL';

export const REGULATION_COUNTRIES = ['PL', 'IN', 'GB', 'DE', 'RU', 'KP'] as const;
export type RegulationCountry = typeof REGULATION_COUNTRIES[number];

/**
 * Complete ordered matrix for Anchor's six selectable countries. `INWARD` is
 * reserved for routes whose payout jurisdiction is India; every other ordered
 * payer route is represented as `OUTWARD`.
 */
export const REGULATION_CORRIDOR_MATRIX = [
  'PL-IN-INWARD', 'PL-GB-OUTWARD', 'PL-DE-OUTWARD', 'PL-RU-OUTWARD', 'PL-KP-OUTWARD',
  'IN-PL-OUTWARD', 'IN-GB-OUTWARD', 'IN-DE-OUTWARD', 'IN-RU-OUTWARD', 'IN-KP-OUTWARD',
  'GB-PL-OUTWARD', 'GB-IN-INWARD', 'GB-DE-OUTWARD', 'GB-RU-OUTWARD', 'GB-KP-OUTWARD',
  'DE-PL-OUTWARD', 'DE-IN-INWARD', 'DE-GB-OUTWARD', 'DE-RU-OUTWARD', 'DE-KP-OUTWARD',
  'RU-PL-OUTWARD', 'RU-IN-INWARD', 'RU-GB-OUTWARD', 'RU-DE-OUTWARD', 'RU-KP-OUTWARD',
  'KP-PL-OUTWARD', 'KP-IN-INWARD', 'KP-GB-OUTWARD', 'KP-DE-OUTWARD', 'KP-RU-OUTWARD',
] as const;
export type RegulationCorridor = typeof REGULATION_CORRIDOR_MATRIX[number];

export interface RegulationChunk {
  readonly id: string;
  readonly section: string;
  readonly summary: string;
  readonly quote: string;
  readonly tags: readonly string[];
  readonly appliesToBooks: readonly RegulationCorridor[];
}

/**
 * A reviewed source record. Only this local, versioned record is eligible for
 * retrieval. A network refresh can produce an observation, but never edits it.
 */
export interface ApprovedRegulationSource {
  readonly id: string;
  readonly title: string;
  readonly authority: RegulationAuthority;
  readonly jurisdiction: 'IN' | 'EU' | 'PL' | 'GB' | 'DE' | 'RU' | 'UN';
  readonly sourceUri: string;
  /** Optional official machine-readable endpoint used only for refresh. */
  readonly refreshUri?: string;
  readonly officialDocumentDate?: string;
  readonly approvedVersion: string;
  readonly approvedAt: string;
  readonly allowedHosts: readonly string[];
  /**
   * Exact, normalized phrases used to detect relevant source changes. The
   * first marker identifies the document; the remaining markers are reviewed
   * legal/version text.
   */
  readonly approvedMarkers: readonly string[];
  readonly chunks: readonly RegulationChunk[];
}

export type RefreshStatus = 'UNCHANGED' | 'REVIEW_REQUIRED' | 'UNAVAILABLE';

export interface RegulationRefreshObservation {
  readonly sourceId: string;
  readonly approvedVersion: string;
  readonly sourceUri: string;
  readonly checkedAt: string;
  readonly status: RefreshStatus;
  readonly httpStatus?: number;
  readonly observedUri?: string;
  readonly observedContentHash?: string;
  readonly missingMarkers: readonly string[];
  readonly note: string;
  readonly advisoryOnly: true;
}

export interface RegulationRefreshReport {
  readonly schemaVersion: '1.0';
  readonly checkedAt: string;
  readonly approvedCorpusHash: string;
  readonly observations: readonly RegulationRefreshObservation[];
  readonly requiresHumanReview: boolean;
  readonly rulesChanged: false;
}

export interface RegulationCitation {
  readonly sourceId: string;
  readonly sourceUri: string;
  readonly sourceVersion: string;
  readonly authority: RegulationAuthority;
  readonly section: string;
  readonly quote: string;
}

export interface RegulationRetrievalResult {
  readonly corpusHash: string;
  readonly query: string;
  readonly bookId?: RegulationCorridor;
  readonly results: readonly {
    readonly score: number;
    readonly summary: string;
    readonly citation: RegulationCitation;
  }[];
  readonly deterministic: true;
  readonly approvedSourcesOnly: true;
}
