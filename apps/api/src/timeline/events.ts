/**
 * The workflow timeline.
 *
 * Every mutation appends one ordered, structured event. The timeline is what
 * the dashboards render, what the audit view reads, and what proves the order
 * in which decisions were actually made.
 *
 * Event details carry identifiers, hashes, amounts and decisions - never a
 * name, an email, a storage key or a wallet secret.
 */

import { timelineEvents } from '../db/schema.js';
import type { DataStore } from '../db/store.js';
import type { Clock, IdGenerator } from '../runtime.js';

export type TimelineKind =
  | 'COMPANY_POLICY_APPROVED'
  | 'JOB_POSTED'
  | 'APPLICATION_SUBMITTED'
  | 'APPLICATION_EVALUATED'
  | 'CONTRACT_DRAFTED'
  | 'AGREEMENT_PREPARED'
  | 'AGREEMENT_ACCESS_GRANTED'
  | 'CONTRACT_APPROVED'
  | 'CREDENTIAL_VERIFIED'
  | 'CORRIDOR_RESOLVED'
  | 'COMPLIANCE_EVALUATED'
  | 'FX_QUOTED'
  | 'REGULATIONS_REFRESHED'
  | 'PAYMENT_CREATED'
  | 'FIAT_FUNDED'
  | 'ESCROW_CREATED'
  | 'USDC_LOCKED'
  | 'WORK_SUBMITTED'
  | 'WORK_ACCESS_GRANTED'
  | 'WORK_EVALUATED'
  | 'WORK_APPROVED'
  | 'WORK_REVISION_REQUESTED'
  | 'RELEASE_AUTHORIZED'
  | 'USDC_RELEASED'
  | 'PAYOUT_CREDITED'
  | 'PAYMENT_COMPLETED'
  | 'PAYMENT_REFUNDED'
  | 'RECONCILED'
  | 'DOCUMENT_RECORDED';

export interface TimelineActor {
  readonly subject: string;
  readonly role: string;
}

export interface AppendInput {
  readonly kind: TimelineKind;
  readonly actor: TimelineActor;
  readonly contractId?: string;
  readonly paymentId?: string;
  readonly detail: Record<string, unknown>;
}

const PROHIBITED_DETAIL_KEYS = ['email', 'phone', 'passport', 'mnemonic', 'privatekey', 'secret', 'objectkey', 'signedurl'];

export class Timeline {
  constructor(
    private readonly store: DataStore,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async append(input: AppendInput): Promise<{ id: string; sequence: number }> {
    for (const key of Object.keys(input.detail)) {
      const normalized = key.toLowerCase().replaceAll(/[^a-z]/gu, '');
      if (PROHIBITED_DETAIL_KEYS.some((forbidden) => normalized.includes(forbidden))) {
        throw new Error(`Timeline details must not include "${key}".`);
      }
    }
    const scope = input.contractId
      ? { contractId: input.contractId }
      : { paymentId: input.paymentId ?? null };
    const existing = await this.store.findMany(timelineEvents, scope, { orderBy: 'sequence', direction: 'desc', limit: 1 });
    const sequence = (existing[0]?.sequence ?? 0) + 1;
    const record = await this.store.insert(timelineEvents, {
      id: this.ids.next('EVT'),
      contractId: input.contractId ?? null,
      paymentId: input.paymentId ?? null,
      sequence,
      kind: input.kind,
      actorSubject: input.actor.subject,
      actorRole: input.actor.role,
      detail: input.detail,
      occurredAt: this.clock.now().toISOString(),
    });
    return { id: record.id, sequence };
  }

  async forContract(contractId: string) {
    return this.store.findMany(timelineEvents, { contractId }, { orderBy: 'sequence' });
  }

  async forPayment(paymentId: string) {
    return this.store.findMany(timelineEvents, { paymentId }, { orderBy: 'sequence' });
  }
}
