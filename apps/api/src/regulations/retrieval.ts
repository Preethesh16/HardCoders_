import { APPROVED_REGULATION_SOURCES, approvedCorpusHash } from './catalog.js';
import type {
  ApprovedRegulationSource,
  RegulationCorridor,
  RegulationRetrievalResult,
} from './types.js';

export interface RegulationRetrievalQuery {
  readonly query: string;
  readonly bookId?: RegulationCorridor;
  readonly limit?: number;
}

const tokens = (value: string): readonly string[] => [
  ...new Set(value.normalize('NFKD').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []),
];

/** Deterministic retrieval over reviewed source-controlled chunks only. */
export function retrieveRegulations(
  input: RegulationRetrievalQuery,
  sources: readonly ApprovedRegulationSource[] = APPROVED_REGULATION_SOURCES,
): RegulationRetrievalResult {
  const queryTokens = tokens(input.query);
  const limit = Math.max(1, Math.min(input.limit ?? 5, 20));
  const candidates = sources.flatMap((source) => source.chunks
    .filter((chunk) => input.bookId === undefined || chunk.appliesToBooks.includes(input.bookId))
    .map((chunk) => {
      const tagTokens = new Set(tokens(chunk.tags.join(' ')));
      const bodyTokens = new Set(tokens(`${source.title} ${chunk.section} ${chunk.summary} ${chunk.quote}`));
      const score = queryTokens.reduce((sum, token) =>
        sum + (tagTokens.has(token) ? 5 : 0) + (bodyTokens.has(token) ? 1 : 0), 0);
      return { source, chunk, score };
    }))
    .filter((candidate) => queryTokens.length === 0 || candidate.score > 0)
    .sort((left, right) => right.score - left.score
      || left.chunk.id.localeCompare(right.chunk.id, 'en'))
    .slice(0, limit)
    .map(({ source, chunk, score }) => ({
      score,
      summary: chunk.summary,
      citation: {
        sourceId: source.id,
        sourceUri: source.sourceUri,
        sourceVersion: source.approvedVersion,
        authority: source.authority,
        section: chunk.section,
        quote: chunk.quote,
      },
    }));

  return {
    corpusHash: approvedCorpusHash(sources),
    query: input.query,
    ...(input.bookId === undefined ? {} : { bookId: input.bookId }),
    results: candidates,
    deterministic: true,
    approvedSourcesOnly: true,
  };
}
