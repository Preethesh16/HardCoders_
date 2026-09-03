import { TextEncoder } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  consumeEvidenceEvents,
  MemoryEvidenceEventCheckpointStore,
  type CommittedEvidenceEvent,
} from '../src/event-checkpoint.js';
import type { CloseableEvidenceEventStream, EvidenceEventSource } from '../src/event-source.js';

function event(blockNumber: bigint, transactionId: string): CommittedEvidenceEvent {
  return {
    blockNumber,
    transactionId,
    eventName: 'fabric.work_submitted',
    payload: new TextEncoder().encode(JSON.stringify({
      type: 'fabric.work_submitted',
      evidenceId: 'EVID-PLIN-001',
      fileHash: `sha256:${'a'.repeat(64)}`,
      version: 1,
      buyerDecision: 'PENDING',
      fabricTxId: transactionId,
      occurredAt: '2026-09-03T10:00:00.000Z',
    })),
  };
}

class ArraySource implements EvidenceEventSource {
  public requestedCheckpoint: { readonly blockNumber: bigint; readonly transactionId: string } | undefined;

  public constructor(private readonly events: readonly CommittedEvidenceEvent[]) {}

  public async open(checkpoint: { readonly blockNumber: bigint; readonly transactionId: string } | undefined) {
    this.requestedCheckpoint = checkpoint;
    const events = this.events;
    const stream: CloseableEvidenceEventStream = {
      async *[Symbol.asyncIterator]() { yield* events; },
      close: async () => undefined,
    };
    return stream;
  }
}

describe('checkpointed Fabric evidence events', () => {
  it('advances a bounded checkpoint and deduplicates exact committed events', async () => {
    const store = new MemoryEvidenceEventCheckpointStore();
    const first = event(7n, 'a'.repeat(64));
    const source = new ArraySource([first, first, event(8n, 'b'.repeat(64))]);
    const result = await consumeEvidenceEvents(source, store, new AbortController().signal, 3);
    expect(result).toEqual({ reason: 'bounded', eventsSeen: 3 });
    expect(await store.checkpoint()).toEqual({ blockNumber: 8n, transactionId: 'b'.repeat(64) });

    const resumed = new ArraySource([]);
    await consumeEvidenceEvents(resumed, store, new AbortController().signal);
    expect(resumed.requestedCheckpoint).toEqual({ blockNumber: 8n, transactionId: 'b'.repeat(64) });
  });

  it('fails closed for event metadata that disagrees with the payload', async () => {
    const invalid = event(1n, 'c'.repeat(64));
    const changed = { ...invalid, transactionId: 'd'.repeat(64) };
    await expect(new MemoryEvidenceEventCheckpointStore().process(changed)).rejects.toThrow(/does not match/u);
  });
});
