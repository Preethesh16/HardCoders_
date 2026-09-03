import type { WorkContractState } from '@optiwork/contracts';

const transitions: Readonly<Record<WorkContractState, readonly WorkContractState[]>> = {
  DRAFT: ['CANDIDATE_SELECTED', 'CANCELLED'],
  CANDIDATE_SELECTED: ['PARTY_APPROVAL_PENDING', 'CANCELLED'],
  PARTY_APPROVAL_PENDING: ['RULES_VERIFIED', 'CANCELLED', 'EXPIRED'],
  RULES_VERIFIED: ['FX_LOCKED', 'CANCELLED', 'EXPIRED'],
  FX_LOCKED: ['ESCROW_CREATED', 'RULES_VERIFIED', 'CANCELLED', 'EXPIRED'],
  ESCROW_CREATED: ['ESCROW_FUNDED', 'FX_LOCKED', 'CANCELLED', 'EXPIRED'],
  ESCROW_FUNDED: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['WORK_SUBMITTED', 'CANCELLED'],
  WORK_SUBMITTED: ['VALIDATION_RECORDED', 'REVISION_REQUIRED', 'DISPUTED'],
  VALIDATION_RECORDED: ['COMPANY_APPROVED', 'REVISION_REQUIRED', 'DISPUTED'],
  COMPANY_APPROVED: ['RELEASE_AUTHORIZED', 'DISPUTED'],
  RELEASE_AUTHORIZED: ['ESCROW_RELEASED'],
  ESCROW_RELEASED: ['COMPLETED'],
  COMPLETED: [],
  REVISION_REQUIRED: ['IN_PROGRESS', 'DISPUTED', 'CANCELLED'],
  DISPUTED: ['IN_PROGRESS', 'COMPANY_APPROVED', 'CANCELLED'],
  CANCELLED: [],
  EXPIRED: [],
};

export function allowedTransitions(state: WorkContractState): readonly WorkContractState[] {
  return transitions[state]!;
}

export function canTransition(from: WorkContractState, to: WorkContractState): boolean {
  return transitions[from]!.includes(to);
}

export function assertTransition(from: WorkContractState, to: WorkContractState): void {
  if (!canTransition(from, to)) {
    throw new Error(`invalid work contract transition: ${from} -> ${to}`);
  }
}
