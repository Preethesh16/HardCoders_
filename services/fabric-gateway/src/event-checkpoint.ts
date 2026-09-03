import type { EvidenceEventSource } from './event-source.js';

export interface EventCheckpoint {
  readonly blockNumber: bigint;
  readonly transactionId: string;
}

export interface CommittedEvidenceEvent {
  readonly blockNumber: bigint;
  readonly transactionId: string;
  readonly eventName: 'fabric.work_submitted' | 'fabric.work_decided';
  readonly payload: Uint8Array;
}

export type CheckpointResult = 'processed' | 'duplicate';

export interface EvidenceEventCheckpointStore {
  checkpoint(): Promise<EventCheckpoint | undefined>;
  process(event: CommittedEvidenceEvent): Promise<CheckpointResult>;
}

export class MemoryEvidenceEventCheckpointStore implements EvidenceEventCheckpointStore {
  readonly #processed = new Set<string>();
  #checkpoint?: EventCheckpoint;

  public async checkpoint(): Promise<EventCheckpoint | undefined> {
    return this.#checkpoint === undefined ? undefined : { ...this.#checkpoint };
  }

  public async process(event: CommittedEvidenceEvent): Promise<CheckpointResult> {
    validateEvidenceEvent(event);
    const key = `${event.transactionId}\0${event.eventName}`;
    if (this.#processed.has(key)) return 'duplicate';
    this.#processed.add(key);
    if (this.#checkpoint === undefined
      || event.blockNumber > this.#checkpoint.blockNumber
      || (event.blockNumber === this.#checkpoint.blockNumber
        && event.transactionId.localeCompare(this.#checkpoint.transactionId) > 0)) {
      this.#checkpoint = { blockNumber: event.blockNumber, transactionId: event.transactionId };
    }
    return 'processed';
  }
}

export interface ConsumeEvidenceEventsResult {
  readonly reason: 'ended' | 'bounded' | 'aborted';
  readonly eventsSeen: number;
}

export async function consumeEvidenceEvents(
  source: EvidenceEventSource,
  store: EvidenceEventCheckpointStore,
  signal: AbortSignal,
  maxEvents = 1_000,
): Promise<ConsumeEvidenceEventsResult> {
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > 10_000) {
    throw new Error('Event session bound is invalid.');
  }
  if (signal.aborted) return { reason: 'aborted', eventsSeen: 0 };
  const stream = await source.open(await store.checkpoint());
  let eventsSeen = 0;
  try {
    for await (const event of stream) {
      if (signal.aborted) return { reason: 'aborted', eventsSeen };
      validateEvidenceEvent(event);
      await store.process(event);
      eventsSeen += 1;
      if (eventsSeen >= maxEvents) return { reason: 'bounded', eventsSeen };
    }
    return { reason: 'ended', eventsSeen };
  } finally {
    await stream.close();
  }
}

export function validateEvidenceEvent(event: CommittedEvidenceEvent): void {
  if (event.blockNumber < 0n
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(event.transactionId)
    || !['fabric.work_submitted', 'fabric.work_decided'].includes(event.eventName)
    || event.payload.byteLength === 0
    || event.payload.byteLength > 16 * 1024) throw new Error('Fabric evidence event is invalid.');
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(event.payload)) as unknown;
  } catch {
    throw new Error('Fabric evidence event payload is invalid.');
  }
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
    throw new Error('Fabric evidence event payload is invalid.');
  }
  const record = decoded as Record<string, unknown>;
  if (record['type'] !== event.eventName
    || typeof record['evidenceId'] !== 'string'
    || typeof record['fileHash'] !== 'string'
    || !/^sha256:[a-f0-9]{64}$/u.test(record['fileHash'])
    || record['fabricTxId'] !== event.transactionId) {
    throw new Error('Fabric evidence event payload does not match its commit metadata.');
  }
}
