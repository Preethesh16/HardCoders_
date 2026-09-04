/**
 * The compliance evaluator.
 *
 * It walks the versioned ruleset for the corridor's book, compares exact
 * integer amounts against exact integer thresholds, and produces a decision
 * that carries every reason, every required document and every source citation
 * that produced it. The result is hashed canonically so a release permit can
 * commit to the exact decision that permitted it.
 */

import type {
  ComplianceDecision as ContractComplianceDecision,
  ComplianceOutcome,
  CorridorPolicy,
  VerifiableCredential,
} from '@optiwork/contracts';
import { ComplianceDecisionSchema } from '@optiwork/contracts';
import { FormatRegistry } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { canonicalHash } from '../canonical.js';
import { minorOf, type Money } from '../money.js';
import { bookIdFor } from '../corridor/service.js';
import {
  RULES_VERSION,
  corridorGateRuleFor,
  documentRulesFor,
  riskSignalRuleFor,
  thresholdRulesFor,
  type ComplianceRiskSignal,
  type RuleCitation,
} from './rules.js';
import type { CorridorCoverageAssessment } from '../regulations/coverage.js';
import { APPROVED_REGULATION_SOURCES } from '../regulations/catalog.js';
import type { DealRegulatoryPlan } from '../regulations/planner.js';

export interface CredentialSnapshot {
  readonly id: string;
  readonly country: string;
  readonly assuranceLevel: VerifiableCredential['assuranceLevel'];
  readonly status: VerifiableCredential['status'];
  readonly expiresAt: string;
  readonly signatureValid: boolean;
}

export interface ComplianceInput {
  readonly id: string;
  readonly policy: CorridorPolicy;
  /** The payment value expressed in INR minor units, for the Indian rules. */
  readonly inrEquivalent: Money;
  readonly originCredential: CredentialSnapshot;
  readonly destinationCredential: CredentialSnapshot;
  readonly providedDocuments: readonly string[];
  readonly purposeCode?: string;
  readonly riskSignals?: readonly ComplianceRiskSignal[];
  /**
   * Proof that every obligation category Anchor declares for this corridor is
   * backed by a current, reviewed source. Live source observations can hold a
   * payment for review, but can never rewrite the executable rules here.
   */
  readonly regulationCoverage?: CorridorCoverageAssessment;
  /** Fact-bound, source-pinned plan composed from the selected deal. */
  readonly regulatoryPlan?: DealRegulatoryPlan;
  readonly evaluatedAt: Date;
}

export interface RequiredDocumentDecision {
  readonly code: string;
  readonly satisfied: boolean;
  readonly reason: string;
  readonly citation: RuleCitation;
}

export type ComplianceDecision = ContractComplianceDecision;

if (!FormatRegistry.Has('date-time')) {
  FormatRegistry.Set('date-time', (value) => {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
  });
}
if (!FormatRegistry.Has('uri')) {
  FormatRegistry.Set('uri', (value) => {
    try {
      const uri = new URL(value);
      return uri.protocol === 'https:' || uri.protocol === 'http:';
    } catch {
      return false;
    }
  });
}

/** Enforces the shared boundary for newly evaluated and database-hydrated decisions. */
export function assertComplianceDecision(value: unknown): asserts value is ComplianceDecision {
  if (!Value.Check(ComplianceDecisionSchema, value)) {
    const violations = [...Value.Errors(ComplianceDecisionSchema, value)]
      .slice(0, 3)
      .map((error) => `${error.path || '/'}: ${error.message}`)
      .join('; ');
    throw new Error(`Compliance decision violated the shared runtime contract: ${violations}.`);
  }
  const { canonicalHash: expectedHash, ...committedDecision } = value;
  if (canonicalHash(committedDecision) !== expectedHash) {
    throw new Error('Compliance decision does not match its canonical commitment.');
  }
}

const SEVERITY: Readonly<Record<ComplianceOutcome, number>> = { PASSED: 0, MANUAL_REVIEW: 1, BLOCKED: 2 };
const compareCodePoints = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

function worst(left: ComplianceOutcome, right: ComplianceOutcome): ComplianceOutcome {
  return SEVERITY[right] > SEVERITY[left] ? right : left;
}

function credentialIsUsable(credential: CredentialSnapshot, at: Date): boolean {
  return credential.signatureValid
    && credential.status === 'ACTIVE'
    && Date.parse(credential.expiresAt) > at.getTime();
}

export function evaluate(input: ComplianceInput): ComplianceDecision {
  const bookId = bookIdFor(input.policy);
  const reasons: string[] = [];
  const appliedRules: string[] = [];
  const citations: RuleCitation[] = [];
  let outcome: ComplianceOutcome = 'PASSED';

  const corridorGate = corridorGateRuleFor(bookId);
  if (corridorGate) {
    outcome = worst(outcome, corridorGate.effect === 'BLOCK' ? 'BLOCKED' : 'MANUAL_REVIEW');
    appliedRules.push(corridorGate.code);
    citations.push(corridorGate.citation);
    reasons.push(`${corridorGate.code}: ${corridorGate.rationale}`);
  } else if (input.policy.status !== 'ACTIVE') {
    outcome = input.policy.status === 'BLOCKED' ? 'BLOCKED' : 'MANUAL_REVIEW';
    appliedRules.push(`CORRIDOR_STATUS_${input.policy.status}`);
    reasons.push(`The versioned corridor policy status is ${input.policy.status}.`);
  }

  if (input.regulationCoverage !== undefined) {
    if (input.regulationCoverage.bookId !== bookId) {
      outcome = worst(outcome, 'MANUAL_REVIEW');
      appliedRules.push('REGULATION_COVERAGE_BOOK_MISMATCH');
      reasons.push(`Regulation coverage for ${input.regulationCoverage.bookId} cannot authorize ${bookId}.`);
    } else {
      for (const check of input.regulationCoverage.checks) {
        appliedRules.push(`REGULATION_${check.category}_${check.status}`);
        if (check.status !== 'COVERED') reasons.push(`${check.category}: ${check.reason}`);
      }
      if (input.regulationCoverage.outcome === 'MANUAL_REVIEW') {
        outcome = worst(outcome, 'MANUAL_REVIEW');
      }
    }
  }

  if (input.regulatoryPlan !== undefined) {
    if (input.regulatoryPlan.bookId !== bookId) {
      outcome = worst(outcome, 'MANUAL_REVIEW');
      appliedRules.push('REGULATORY_PLAN_BOOK_MISMATCH');
      reasons.push(`Regulatory plan for ${input.regulatoryPlan.bookId} cannot authorize ${bookId}.`);
    } else {
      for (const category of input.regulatoryPlan.categories) {
        appliedRules.push(`REGULATORY_PLAN_${category.category}_${category.status}`);
      }
      for (const control of input.regulatoryPlan.controls) appliedRules.push(control.controlCode);
      if (input.regulatoryPlan.outcome === 'BLOCKED') outcome = worst(outcome, 'BLOCKED');
      if (input.regulatoryPlan.outcome === 'MANUAL_REVIEW') outcome = worst(outcome, 'MANUAL_REVIEW');
      if (input.regulatoryPlan.outcome !== 'PASSED') reasons.push(...input.regulatoryPlan.reasons);
    }
  }

  for (const [party, credential, expectedCountry] of [
    ['origin', input.originCredential, input.policy.originCountry],
    ['destination', input.destinationCredential, input.policy.destinationCountry],
  ] as const) {
    if (!credentialIsUsable(credential, input.evaluatedAt)) {
      outcome = worst(outcome, 'BLOCKED');
      reasons.push(`The ${party} credential ${credential.id} is not a valid, active, unexpired credential.`);
    }
    if (credential.country !== expectedCountry) {
      outcome = worst(outcome, 'BLOCKED');
      reasons.push(`The ${party} credential country ${credential.country} does not match corridor country ${expectedCountry}.`);
    }
  }

  for (const signal of [...new Set(input.riskSignals ?? [])]) {
    const rule = riskSignalRuleFor(signal);
    outcome = worst(outcome, 'BLOCKED');
    appliedRules.push(rule.code);
    citations.push(rule.citation);
    reasons.push(`${rule.code}: ${rule.rationale}`);
  }

  if (input.purposeCode !== undefined) {
    appliedRules.push('PURPOSE_CODE_ALLOWLIST');
    if (!input.policy.purposeCodes.includes(input.purposeCode)) {
      outcome = worst(outcome, 'MANUAL_REVIEW');
      reasons.push(`Purpose code ${input.purposeCode} is not in policy ${input.policy.id}'s reviewed allowlist.`);
    }
  }

  const required = new Map<string, RequiredDocumentDecision>();
  for (const rule of documentRulesFor(bookId)) {
    appliedRules.push(rule.code);
    citations.push(rule.citation);
    const satisfied = input.providedDocuments.includes(rule.code);
    required.set(rule.code, {
      code: rule.code,
      satisfied,
      reason: rule.description,
      citation: rule.citation,
    });
  }

  if (input.regulatoryPlan?.bookId === bookId) {
    for (const code of input.regulatoryPlan.requiredDocuments) {
      if (required.has(code)) continue;
      const citation = citationForPlanDocument(input.regulatoryPlan, code);
      citations.push(citation);
      const control = input.regulatoryPlan.controls.find((candidate) => candidate.requiredDocuments.includes(code));
      required.set(code, {
        code,
        satisfied: input.providedDocuments.includes(code),
        reason: control?.requirement ?? `Required by regulatory plan ${input.regulatoryPlan.planHash}.`,
        citation,
      });
    }
  }

  const amount = minorOf(input.inrEquivalent);
  for (const rule of thresholdRulesFor(bookId)) {
    if (!rule.directions.includes(input.policy.direction)) continue;
    appliedRules.push(rule.code);
    citations.push(rule.citation);
    const exceeded = amount > BigInt(rule.threshold.amountMinor);
    if (!exceeded) continue;

    if (rule.effect === 'BLOCK') {
      outcome = worst(outcome, 'BLOCKED');
      reasons.push(`${rule.code}: ${rule.rationale}`);
      continue;
    }
    for (const code of rule.requiredDocuments) {
      required.set(code, {
        code,
        satisfied: input.providedDocuments.includes(code),
        reason: `${rule.code}: ${rule.rationale}`,
        citation: rule.citation,
      });
    }
    if (rule.requiresEnhancedAssurance && input.originCredential.assuranceLevel !== 'ENHANCED') {
      outcome = worst(outcome, 'MANUAL_REVIEW');
      reasons.push(`${rule.code} requires an enhanced-assurance buyer credential.`);
    }
    if (rule.effect === 'MANUAL_REVIEW') {
      outcome = worst(outcome, 'MANUAL_REVIEW');
      reasons.push(`${rule.code}: ${rule.rationale}`);
    }
  }

  const requiredDocuments = [...required.values()].sort((left, right) => compareCodePoints(left.code, right.code));
  const missing = requiredDocuments.filter((document) => !document.satisfied).map((document) => document.code);
  if (missing.length > 0) {
    outcome = worst(outcome, 'MANUAL_REVIEW');
    reasons.push(`Missing required documents: ${missing.join(', ')}.`);
  }
  if (reasons.length === 0) {
    reasons.push(`All ${RULES_VERSION} corridor, credential, document and value rules passed.`);
  }

  const committedCitations = dedupeCitations(citations);
  const unsigned = {
    id: input.id,
    corridorId: input.policy.id,
    bookId,
    outcome,
    reasons,
    requiredDocuments,
    appliedRules: [...new Set(appliedRules)].sort(compareCodePoints),
    citations: committedCitations,
    policyVersion: input.policy.sourceVersion,
    rulesVersion: RULES_VERSION,
    evaluatedAt: input.evaluatedAt.toISOString(),
    inrEquivalent: input.inrEquivalent,
  };

  const decision = {
    ...unsigned,
    canonicalHash: canonicalHash(unsigned),
  };
  assertComplianceDecision(decision);
  return decision;
}

function dedupeCitations(citations: readonly RuleCitation[]): RuleCitation[] {
  const seen = new Map<string, RuleCitation>();
  for (const citation of citations) seen.set(`${citation.sourceVersion}#${citation.section}`, citation);
  return [...seen.values()];
}

function citationForPlanDocument(plan: DealRegulatoryPlan, code: string): RuleCitation {
  const control = plan.controls.find((candidate) => candidate.requiredDocuments.includes(code));
  const category = plan.categories.find((candidate) => candidate.requiredDocuments.includes(code));
  const reference = control?.sourceReferences[0] ?? category?.sourceReferences[0];
  const source = APPROVED_REGULATION_SOURCES.find((candidate) => candidate.id === reference?.sourceId);
  const chunk = source?.chunks.find((candidate) => reference?.chunkIds.includes(candidate.id));
  return {
    sourceUri: source?.sourceUri ?? 'https://www.rbi.org.in/',
    sourceVersion: source?.approvedVersion ?? plan.planHash,
    section: chunk?.section ?? category?.category ?? 'Deal regulatory plan',
    quote: chunk?.quote ?? category?.requirements[0] ?? `Document ${code} is required by the reviewed deal plan.`,
  };
}
