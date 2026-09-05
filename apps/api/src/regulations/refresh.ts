import { createHash } from 'node:crypto';

import { resilientFetch } from '../http/resilient-fetch.js';
import { APPROVED_REGULATION_SOURCES, approvedCorpusHash } from './catalog.js';
import type {
  ApprovedRegulationSource,
  RegulationRefreshObservation,
  RegulationRefreshReport,
} from './types.js';

export interface RefreshOptions {
  readonly sources?: readonly ApprovedRegulationSource[];
  readonly fetchImpl?: typeof fetch;
  readonly checkedAt?: Date;
  readonly timeoutMs?: number;
  readonly maximumBytes?: number;
  readonly concurrency?: number;
}

const hash = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

export function normalizeOfficialText(value: string): string {
  return value
    .replaceAll(/<!--[^]*?-->/gu, ' ')
    .replaceAll(/<(script|style|svg)\b[^>]*>[^]*?<\/\1>/giu, ' ')
    .replaceAll(/<[^>]+>/gu, ' ')
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&ndash;', '–')
    .replaceAll('&mdash;', '—')
    .replaceAll(/\s+/gu, ' ')
    .trim();
}

function assertAllowedUri(uri: URL, source: ApprovedRegulationSource): void {
  if (uri.protocol !== 'https:' || !source.allowedHosts.includes(uri.hostname.toLowerCase())) {
    throw new Error(`Official-source redirect was blocked for ${source.id}.`);
  }
}

async function fetchBounded(
  source: ApprovedRegulationSource,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  maximumBytes: number,
): Promise<{ response: Response; uri: URL; body: string }> {
  let uri = new URL(source.refreshUri ?? source.sourceUri);
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    assertAllowedUri(uri, source);
    const response = await fetchImpl(uri, {
      method: 'GET',
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1' },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error('Official source returned a redirect without a location.');
      uri = new URL(location, uri);
      continue;
    }
    const declaredLength = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
      throw new Error('Official source exceeded the response-size limit.');
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maximumBytes) throw new Error('Official source exceeded the response-size limit.');
    return { response, uri, body: new TextDecoder().decode(bytes) };
  }
  throw new Error('Official source exceeded the redirect limit.');
}

async function inspectSource(
  source: ApprovedRegulationSource,
  fetchImpl: typeof fetch,
  checkedAt: string,
  timeoutMs: number,
  maximumBytes: number,
): Promise<RegulationRefreshObservation> {
  try {
    const { response, uri, body } = await fetchBounded(source, fetchImpl, timeoutMs, maximumBytes);
    if (!response.ok) {
      return {
        sourceId: source.id,
        approvedVersion: source.approvedVersion,
        sourceUri: source.sourceUri,
        checkedAt,
        status: 'UNAVAILABLE',
        httpStatus: response.status,
        observedUri: uri.href,
        missingMarkers: [],
        note: 'The approved local extract remains active because the official source was unavailable.',
        advisoryOnly: true,
      };
    }
    const normalized = normalizeOfficialText(body);
    const missingMarkers = source.approvedMarkers.filter((marker) =>
      !normalized.includes(normalizeOfficialText(marker)) && !body.includes(marker));
    const identityMarker = source.approvedMarkers[0];
    const identityVerified = identityMarker !== undefined
      && (normalized.includes(normalizeOfficialText(identityMarker)) || body.includes(identityMarker));
    const status = !identityVerified
      ? 'UNAVAILABLE'
      : missingMarkers.length === 0 ? 'UNCHANGED' : 'REVIEW_REQUIRED';
    return {
      sourceId: source.id,
      approvedVersion: source.approvedVersion,
      sourceUri: source.sourceUri,
      checkedAt,
      status,
      httpStatus: response.status,
      observedUri: uri.href,
      observedContentHash: hash(normalized),
      missingMarkers,
      note: status === 'UNCHANGED'
        ? 'All reviewed legal markers remain present; the approved local extract is unchanged.'
        : status === 'UNAVAILABLE'
          ? 'The response did not contain the document identity marker. The approved local extract remains active.'
          : 'One or more reviewed markers changed or disappeared. Human legal review is required before updating the corpus or rules.',
      advisoryOnly: true,
    };
  } catch {
    return {
      sourceId: source.id,
      approvedVersion: source.approvedVersion,
      sourceUri: source.sourceUri,
      checkedAt,
      status: 'UNAVAILABLE',
      missingMarkers: [],
      note: 'The approved local extract remains active because the official source could not be safely fetched.',
      advisoryOnly: true,
    };
  }
}

/**
 * Observes official pages without changing the reviewed corpus or compliance
 * rules. REVIEW_REQUIRED is fail-safe: it is evidence for a human, not a new
 * machine-enforced rule.
 */
export async function refreshOfficialRegulations(options: RefreshOptions = {}): Promise<RegulationRefreshReport> {
  const sources = options.sources ?? APPROVED_REGULATION_SOURCES;
  const checkedAt = (options.checkedAt ?? new Date()).toISOString();
  const fetchImpl = options.fetchImpl ?? resilientFetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maximumBytes = options.maximumBytes ?? 5_000_000;
  // The sources are independent official pages, so they are inspected
  // concurrently. Checking twenty of them one at a time took over two minutes
  // and the caller timed out before the corridor rules were ever resolved. The
  // limit keeps the burst polite to each publisher. Order is preserved so the
  // report and its corpus hash stay deterministic.
  const concurrency = options.concurrency ?? 6;
  const observations: RegulationRefreshObservation[] = new Array<RegulationRefreshObservation>(sources.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, sources.length) }, async () => {
    for (let index = next++; index < sources.length; index = next++) {
      observations[index] = await inspectSource(sources[index]!, fetchImpl, checkedAt, timeoutMs, maximumBytes);
    }
  });
  await Promise.all(workers);
  return {
    schemaVersion: '1.0',
    checkedAt,
    approvedCorpusHash: approvedCorpusHash(sources),
    observations,
    requiresHumanReview: observations.some((observation) => observation.status === 'REVIEW_REQUIRED'),
    rulesChanged: false,
  };
}

export interface RegulationChangeExplanation {
  readonly summary: string;
  readonly source: 'DETERMINISTIC' | 'AI';
  readonly advisoryOnly: true;
  readonly reportHash: string;
}

export type RegulationChangeExplainer = (report: RegulationRefreshReport) => Promise<string>;

/** Optional AI prose cannot change observations, the approved corpus, or rules. */
export async function explainRegulationRefresh(
  report: RegulationRefreshReport,
  aiExplainer?: RegulationChangeExplainer,
): Promise<RegulationChangeExplanation> {
  const reportHash = hash(JSON.stringify(report));
  if (aiExplainer !== undefined) {
    try {
      const summary = (await aiExplainer(report)).trim();
      if (summary.length > 0) return { summary, source: 'AI', advisoryOnly: true, reportHash };
    } catch {
      // Deterministic fallback below.
    }
  }
  const counts = report.observations.reduce((result, observation) => {
    result[observation.status] += 1;
    return result;
  }, { UNCHANGED: 0, REVIEW_REQUIRED: 0, UNAVAILABLE: 0 });
  return {
    summary: `${counts.UNCHANGED} official sources matched reviewed markers; `
      + `${counts.REVIEW_REQUIRED} require human review; ${counts.UNAVAILABLE} were unavailable. `
      + 'No approved compliance rule was changed.',
    source: 'DETERMINISTIC',
    advisoryOnly: true,
    reportHash,
  };
}
