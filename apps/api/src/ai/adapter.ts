/**
 * The AI adapter.
 *
 * AI is advisory. It shortlists applicants, drafts contract language, explains
 * a regulatory decision that has already been made, and recommends whether
 * submitted work looks complete. It can never verify an identity, change a
 * compliance decision, approve work, or authorize or release escrow: those
 * paths do not call this module at all.
 *
 * Two backends: the OpenAI Responses API when a key is configured, and
 * deterministic recorded fixtures otherwise. The demo runs fully on fixtures.
 */

import type { ApiConfig } from '../config.js';
import { canonicalHash } from '../canonical.js';
import { unavailable } from '../errors.js';

export type AiPurpose =
  | 'APPLICATION_SCORING'
  | 'CONTRACT_DRAFTING'
  | 'REGULATORY_EXPLANATION'
  | 'WORK_VALIDATION';

export interface AiCitation {
  readonly sourceUri: string;
  readonly sourceVersion: string;
  readonly quote: string;
}

export interface AiRequest {
  readonly purpose: AiPurpose;
  /**
   * Opaque, non-identifying facts only. Callers must not place a name, email,
   * address, wallet address or raw storage key in here.
   */
  readonly facts: Record<string, string | number | boolean | readonly string[]>;
  readonly instruction: string;
}

export interface AiResult {
  readonly purpose: AiPurpose;
  readonly score: number;
  readonly summary: string;
  readonly citations: readonly AiCitation[];
  readonly source: 'FIXTURE' | 'OPENAI';
  readonly model: string;
  readonly fixtureId?: string;
  readonly promptHash: string;
  readonly advisoryOnly: true;
}

export interface AiAdapter {
  readonly mode: 'fixture' | 'openai';
  evaluate(request: AiRequest): Promise<AiResult>;
}

/** Keys whose presence in an AI request would leak personal data. */
const FORBIDDEN_FACT_KEYS = [
  'name', 'fullname', 'displayname', 'email', 'phone', 'address', 'passport',
  'taxid', 'wallet', 'address58', 'objectkey', 'storagekey', 'mnemonic', 'token',
];

export function assertNoPersonalFacts(request: AiRequest): void {
  for (const key of Object.keys(request.facts)) {
    const normalized = key.toLowerCase().replaceAll(/[^a-z]/gu, '');
    if (FORBIDDEN_FACT_KEYS.some((forbidden) => normalized.includes(forbidden))) {
      throw new Error(`AI facts must not include "${key}"; traces carry opaque values only.`);
    }
  }
}

export function promptHashOf(request: AiRequest): string {
  return canonicalHash({ purpose: request.purpose, instruction: request.instruction, facts: request.facts });
}

/**
 * Deterministic recorded analysis.
 *
 * The score is derived from the request's own facts so that the same input
 * always yields the same advisory output, which keeps a recorded demo stable
 * and makes the tests meaningful.
 */
export class FixtureAiAdapter implements AiAdapter {
  readonly mode = 'fixture' as const;

  async evaluate(request: AiRequest): Promise<AiResult> {
    assertNoPersonalFacts(request);
    const promptHash = promptHashOf(request);
    const fixture = FIXTURES[request.purpose];
    const spread = fixture.maximumScore - fixture.minimumScore + 1;
    const seed = Number.parseInt(promptHash.slice(7, 15), 16);
    const score = fixture.minimumScore + (seed % spread);
    return {
      purpose: request.purpose,
      score,
      summary: fixture.summary(request, score),
      citations: fixture.citations,
      source: 'FIXTURE',
      model: 'optiwork-recorded-fixture-v1',
      fixtureId: fixture.id,
      promptHash,
      advisoryOnly: true,
    };
  }
}

interface Fixture {
  readonly id: string;
  readonly minimumScore: number;
  readonly maximumScore: number;
  readonly citations: readonly AiCitation[];
  summary(request: AiRequest, score: number): string;
}

const RBI_CITATION: AiCitation = {
  sourceUri: 'https://rbi.org.in/Scripts/NotificationUser.aspx/upload/Scripts/NotificationUser.aspx?Id=12561',
  sourceVersion: 'RBI-PA-CB-2023-10-31',
  quote: 'Payment aggregators facilitating cross-border transactions shall comply with the value limits and due-diligence requirements set out in this circular.',
};

const FIXTURES: Readonly<Record<AiPurpose, Fixture>> = {
  APPLICATION_SCORING: {
    id: 'fixture-application-scoring-v1',
    minimumScore: 58,
    maximumScore: 94,
    citations: [{
      sourceUri: 'optiwork://fixtures/application-scoring',
      sourceVersion: 'v1',
      quote: 'Shortlisting weighs declared skill overlap, prior delivery signals and stated availability.',
    }],
    summary: (request, score) =>
      `Advisory shortlist score ${score}/100 from ${String(request.facts['skillMatches'] ?? 0)} matching skills `
      + `and ${String(request.facts['priorContracts'] ?? 0)} prior completed contracts. A human selects the applicant.`,
  },
  CONTRACT_DRAFTING: {
    id: 'fixture-contract-drafting-v1',
    minimumScore: 70,
    maximumScore: 96,
    citations: [{
      sourceUri: 'optiwork://fixtures/contract-drafting',
      sourceVersion: 'v1',
      quote: 'Draft terms restate the agreed scope, milestone, currency and acceptance criteria without adding obligations.',
    }],
    summary: (request) =>
      `Draft terms cover scope, one milestone, an agreed ${String(request.facts['currency'] ?? 'USD')} amount, `
      + 'acceptance criteria and a revision path. Both parties must approve before the terms take effect.',
  },
  REGULATORY_EXPLANATION: {
    id: 'fixture-regulatory-explanation-v1',
    minimumScore: 80,
    maximumScore: 99,
    citations: [RBI_CITATION],
    summary: (request) =>
      `The ${String(request.facts['bookId'] ?? 'corridor')} decision was ${String(request.facts['outcome'] ?? 'recorded')} `
      + 'by the versioned rules engine. This explanation restates that decision and never changes it.',
  },
  WORK_VALIDATION: {
    id: 'fixture-work-validation-v1',
    minimumScore: 55,
    maximumScore: 92,
    citations: [{
      sourceUri: 'optiwork://fixtures/work-validation',
      sourceVersion: 'v1',
      quote: 'Validation compares the declared deliverable type and size against the milestone description.',
    }],
    summary: (request, score) =>
      `Advisory completeness signal ${score}/100 for submission version ${String(request.facts['version'] ?? 1)}. `
      + 'Only the buying company can approve or request a revision.',
  },
};

interface ResponsesPayload {
  readonly output_text?: unknown;
  readonly model?: unknown;
}

/**
 * OpenAI Responses API backend. It is asked for a strict JSON object and any
 * malformed answer falls back to the deterministic fixture rather than
 * blocking a workflow on a third party.
 */
export class OpenAiAdapter implements AiAdapter {
  readonly mode = 'openai' as const;

  constructor(
    private readonly config: ApiConfig['ai'],
    private readonly fallback: AiAdapter = new FixtureAiAdapter(),
    private readonly timeoutMs = 12_000,
  ) {
    if (!config.apiKey) throw new Error('The OpenAI adapter requires an API key.');
  }

  async evaluate(request: AiRequest): Promise<AiResult> {
    assertNoPersonalFacts(request);
    const promptHash = promptHashOf(request);
    try {
      const response = await fetch(new URL('/responses', this.config.baseUrl), {
        method: 'POST',
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          instructions:
            `${request.instruction}\n\nRespond with a JSON object containing "score" (integer 0-100), `
            + '"summary" (one short paragraph) and "citations" (array of {sourceUri, sourceVersion, quote}). '
            + 'You are advisory only: never state that a payment, identity or submission is approved.',
          input: JSON.stringify({ purpose: request.purpose, facts: request.facts }),
        }),
      });
      if (!response.ok) throw unavailable('The AI provider rejected the request.');
      const payload = await response.json() as ResponsesPayload;
      const text = typeof payload.output_text === 'string' ? payload.output_text : '';
      const parsed = JSON.parse(text) as { score?: unknown; summary?: unknown; citations?: unknown };
      const score = typeof parsed.score === 'number' && Number.isInteger(parsed.score)
        ? Math.min(100, Math.max(0, parsed.score))
        : undefined;
      if (score === undefined || typeof parsed.summary !== 'string') {
        throw unavailable('The AI provider returned an unusable response.');
      }
      return {
        purpose: request.purpose,
        score,
        summary: parsed.summary,
        citations: normalizeCitations(parsed.citations),
        source: 'OPENAI',
        model: typeof payload.model === 'string' ? payload.model : this.config.model,
        promptHash,
        advisoryOnly: true,
      };
    } catch {
      const recorded = await this.fallback.evaluate(request);
      return { ...recorded, summary: `${recorded.summary} (recorded fixture; the AI provider was unavailable)` };
    }
  }
}

function normalizeCitations(value: unknown): AiCitation[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const record = entry as Record<string, unknown>;
    if (typeof record['sourceUri'] !== 'string' || typeof record['quote'] !== 'string') return [];
    return [{
      sourceUri: record['sourceUri'],
      sourceVersion: typeof record['sourceVersion'] === 'string' ? record['sourceVersion'] : 'unversioned',
      quote: record['quote'].slice(0, 512),
    }];
  }).slice(0, 8);
}

export function createAiAdapter(config: ApiConfig['ai']): AiAdapter {
  return config.mode === 'openai' ? new OpenAiAdapter(config) : new FixtureAiAdapter();
}
