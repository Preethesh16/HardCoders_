import type { ComplianceResult, CorridorPolicy, VerifiableCredential } from '@optiwork/contracts';
import { canonicalHash } from './canonical.js';

export interface ComplianceInput {
  readonly id: string;
  readonly policy: CorridorPolicy;
  readonly amountInInrMinor: string;
  readonly originCredential: VerifiableCredential;
  readonly destinationCredential: VerifiableCredential;
  readonly providedDocuments: readonly string[];
  readonly evaluatedAt?: Date;
}

export function evaluateCompliance(input: ComplianceInput): ComplianceResult {
  const evaluatedAt = input.evaluatedAt ?? new Date();
  const reasons: string[] = [];
  const requiredDocuments = new Set(input.policy.requiredDocuments);
  let outcome: ComplianceResult['outcome'] = input.policy.status === 'MANUAL_REVIEW' ? 'MANUAL_REVIEW' : 'PASSED';

  for (const credential of [input.originCredential, input.destinationCredential]) {
    if (credential.status !== 'ACTIVE' || Date.parse(credential.expiresAt) <= evaluatedAt.getTime()) {
      outcome = 'BLOCKED';
      reasons.push(`Credential ${credential.id} is not active at evaluation time.`);
    }
  }
  if (input.originCredential.country !== input.policy.originCountry || input.destinationCredential.country !== input.policy.destinationCountry) {
    outcome = 'BLOCKED';
    reasons.push('Credential countries do not match the ordered corridor.');
  }

  const inrAmount = BigInt(input.amountInInrMinor);
  if (input.policy.transactionCap && inrAmount > BigInt(input.policy.transactionCap.amountMinor)) {
    outcome = 'BLOCKED';
    reasons.push('Payment exceeds the configured RBI per-unit cap.');
  }
  for (const rule of input.policy.dueDiligenceRules) {
    if (inrAmount > BigInt(rule.threshold.amountMinor)) {
      for (const document of rule.requiredDocuments) requiredDocuments.add(document);
      if (rule.appliesTo === 'BUYER' && input.originCredential.assuranceLevel !== 'ENHANCED') {
        outcome = outcome === 'BLOCKED' ? outcome : 'MANUAL_REVIEW';
        reasons.push(`${rule.code} requires enhanced buyer due diligence.`);
      }
    }
  }

  const missing = [...requiredDocuments].filter((document) => !input.providedDocuments.includes(document));
  if (missing.length > 0 && outcome !== 'BLOCKED') {
    outcome = 'MANUAL_REVIEW';
    reasons.push(`Missing documents: ${missing.join(', ')}.`);
  }
  if (reasons.length === 0) reasons.push('Versioned corridor, credential, document and value rules passed.');

  const unsigned = {
    id: input.id,
    corridorId: input.policy.id,
    outcome,
    reasons,
    requiredDocuments: [...requiredDocuments].sort(),
    policyVersion: input.policy.sourceVersion,
    evaluatedAt: evaluatedAt.toISOString(),
  };
  return { ...unsigned, canonicalHash: canonicalHash(unsigned) };
}
