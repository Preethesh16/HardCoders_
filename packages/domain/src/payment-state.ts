import type { PaymentState } from '@optiwork/contracts';

const transitions: Readonly<Record<PaymentState, readonly PaymentState[]>> = {
  DRAFT: ['COMPLIANCE_PENDING'],
  COMPLIANCE_PENDING: ['QUOTED', 'MANUAL_REVIEW', 'EXPIRED'],
  MANUAL_REVIEW: ['QUOTED', 'EXPIRED', 'REFUNDED'],
  QUOTED: ['FIAT_FUNDED', 'EXPIRED'],
  FIAT_FUNDED: ['ESCROW_CREATED', 'REFUNDED'],
  ESCROW_CREATED: ['USDC_LOCKED', 'REFUNDED'],
  USDC_LOCKED: ['WORK_PENDING', 'REFUNDED'],
  WORK_PENDING: ['RELEASE_AUTHORIZED', 'REFUNDED'],
  RELEASE_AUTHORIZED: ['USDC_RELEASED', 'FAILED_RECONCILIATION'],
  USDC_RELEASED: ['PAYOUT_CREDITED', 'FAILED_RECONCILIATION'],
  PAYOUT_CREDITED: ['COMPLETED', 'FAILED_RECONCILIATION'],
  COMPLETED: [],
  REFUNDED: [],
  EXPIRED: [],
  FAILED_RECONCILIATION: ['USDC_RELEASED', 'PAYOUT_CREDITED', 'COMPLETED'],
};

export function canTransitionPayment(from: PaymentState, to: PaymentState): boolean {
  return transitions[from].includes(to);
}

export function assertPaymentTransition(from: PaymentState, to: PaymentState): void {
  if (!canTransitionPayment(from, to)) throw new Error(`Invalid payment transition: ${from} -> ${to}.`);
}
