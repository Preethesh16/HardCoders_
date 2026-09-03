import type { BuyerDecision, WorkEvidence } from '@optiwork/contracts';
import { canonicalHash } from './canonical.js';

export function createWorkEvidence(input: Omit<WorkEvidence, 'buyerDecision' | 'buyerDecisionHash' | 'decidedAt' | 'fabricTxId'>): WorkEvidence {
  return { ...input, buyerDecision: 'PENDING' };
}

export function decideWorkEvidence(
  evidence: WorkEvidence,
  decision: Exclude<BuyerDecision, 'PENDING'>,
  buyerReference: string,
  decidedAt = new Date(),
): WorkEvidence {
  if (evidence.buyerDecision !== 'PENDING') throw new Error('This evidence version already has a buyer decision.');
  const buyerDecisionHash = canonicalHash({
    evidenceId: evidence.evidenceId,
    fileHash: evidence.fileHash,
    version: evidence.version,
    decision,
    buyerReference,
    decidedAt: decidedAt.toISOString(),
  });
  return { ...evidence, buyerDecision: decision, buyerDecisionHash, decidedAt: decidedAt.toISOString() };
}

export function assertReleaseableEvidence(evidence: WorkEvidence): void {
  if (evidence.buyerDecision !== 'APPROVED' || !evidence.buyerDecisionHash || !evidence.fabricTxId) {
    throw new Error('A current Fabric-confirmed buyer approval is required for release.');
  }
}
