export type RegulationAuthority =
  | 'RBI'
  | 'INDIA_INCOME_TAX'
  | 'EU'
  | 'POLAND_MINISTRY_OF_FINANCE';

export type RegulationCorridor = 'PL-IN-INWARD' | 'IN-GB-OUTWARD';

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
  readonly jurisdiction: 'IN' | 'EU' | 'PL';
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
