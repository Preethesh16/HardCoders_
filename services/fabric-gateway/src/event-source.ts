import type { CommittedEvidenceEvent, EventCheckpoint } from './event-checkpoint.js';

export interface CloseableEvidenceEventStream extends AsyncIterable<CommittedEvidenceEvent> {
  close(): Promise<void>;
}

export interface EvidenceEventSource {
  open(checkpoint: EventCheckpoint | undefined): Promise<CloseableEvidenceEventStream>;
}
