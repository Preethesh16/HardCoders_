import { randomBytes } from 'node:crypto';
import { canonicalHash, opaqueSellerIdentityRef } from '../canonical.js';
import { AppError } from '../errors.js';
import type {
  AuthenticatedActor,
  DecideEvidenceInput,
  EvidenceLedger,
  LedgerReadiness,
  LedgerWorkEvidence,
  RequestMetadata,
  SubmitEvidenceInput,
  WorkEvidenceHistoryEntry,
} from '../types.js';

const MAX_HISTORY_ENTRIES = 64;
const MAX_HISTORY_RESPONSE_BYTES = 512 * 1024;

function transactionId(): string {
  return randomBytes(32).toString('hex');
}

function requireSeller(actor: AuthenticatedActor): void {
  if (actor.role !== 'freelancer' && actor.role !== 'supplier') throw new AppError('FORBIDDEN');
}

function requireBuyer(actor: AuthenticatedActor): void {
  if (actor.role !== 'company_member') throw new AppError('FORBIDDEN');
}

export class MemoryEvidenceLedger implements EvidenceLedger {
  readonly #evidence = new Map<string, LedgerWorkEvidence>();
  readonly #history = new Map<string, WorkEvidenceHistoryEntry[]>();
  readonly #now: () => Date;

  public constructor(now: () => Date = () => new Date()) {
    this.#now = now;
  }

  public async submit(
    actor: AuthenticatedActor,
    _metadata: RequestMetadata,
    input: SubmitEvidenceInput,
  ): Promise<LedgerWorkEvidence> {
    requireSeller(actor);
    const existing = this.#evidence.get(input.evidenceId);
    if (existing === undefined && input.version !== 1) throw new AppError('STATE_CONFLICT');
    if (existing !== undefined
      && (existing.buyerDecision !== 'REVISION_REQUIRED' || input.version !== existing.version + 1)) {
      throw new AppError('STATE_CONFLICT');
    }
    const submittedAt = this.#now().toISOString();
    const fabricTxId = transactionId();
    const evidence: LedgerWorkEvidence = {
      schemaVersion: '1.0',
      evidenceId: input.evidenceId,
      contractHash: input.contractHash,
      milestoneHash: input.milestoneHash,
      fileHash: input.fileHash,
      sellerIdentityRef: opaqueSellerIdentityRef(actor),
      version: input.version,
      submittedAt,
      buyerDecision: 'PENDING',
      fabricTxId,
      aggregateVersion: input.version,
    };
    this.#record(evidence, submittedAt);
    return structuredClone(evidence);
  }

  public async decide(
    actor: AuthenticatedActor,
    _metadata: RequestMetadata,
    input: DecideEvidenceInput,
  ): Promise<LedgerWorkEvidence> {
    requireBuyer(actor);
    const current = this.#evidence.get(input.evidenceId);
    if (current === undefined) throw new AppError('RESOURCE_NOT_FOUND');
    if (current.buyerDecision !== 'PENDING'
      || current.fileHash !== input.expectedFileHash
      || current.version !== input.expectedVersion) throw new AppError('STATE_CONFLICT');
    const decidedAt = this.#now().toISOString();
    const fabricTxId = transactionId();
    const buyerDecisionHash = canonicalHash({
      schemaVersion: '1.0',
      evidenceId: current.evidenceId,
      fileHash: current.fileHash,
      version: current.version,
      decision: input.decision,
      buyerIdentityRef: canonicalHash({ organizationId: actor.organizationId, subject: actor.subject }),
      decidedAt,
    });
    const decided: LedgerWorkEvidence = {
      ...current,
      buyerDecision: input.decision,
      buyerDecisionHash,
      decidedAt,
      fabricTxId,
      aggregateVersion: current.aggregateVersion + 1,
    };
    this.#record(decided, decidedAt);
    return structuredClone(decided);
  }

  public async get(_actor: AuthenticatedActor, evidenceId: string): Promise<LedgerWorkEvidence> {
    const evidence = this.#evidence.get(evidenceId);
    if (evidence === undefined) throw new AppError('RESOURCE_NOT_FOUND');
    return structuredClone(evidence);
  }

  public async history(
    _actor: AuthenticatedActor,
    evidenceId: string,
  ): Promise<readonly WorkEvidenceHistoryEntry[]> {
    const entries = this.#history.get(evidenceId);
    if (entries === undefined) throw new AppError('RESOURCE_NOT_FOUND');
    const result = structuredClone(entries);
    if (result.length > MAX_HISTORY_ENTRIES
      || Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_HISTORY_RESPONSE_BYTES) {
      throw new AppError('LEDGER_UNAVAILABLE');
    }
    return result;
  }

  public async readiness(): Promise<LedgerReadiness> {
    return { ready: true, mode: 'memory', channel: 'optiwork-demo', chaincode: 'optiwork-evidence' };
  }

  public async close(): Promise<void> {}

  #record(evidence: LedgerWorkEvidence, timestamp: string): void {
    const entries = this.#history.get(evidence.evidenceId) ?? [];
    if (entries.length >= MAX_HISTORY_ENTRIES) throw new AppError('STATE_CONFLICT');
    const entry: WorkEvidenceHistoryEntry = {
      transactionId: evidence.fabricTxId,
      timestamp,
      isDelete: false,
      value: structuredClone(evidence),
    };
    if (Buffer.byteLength(JSON.stringify([...entries, entry]), 'utf8') > MAX_HISTORY_RESPONSE_BYTES) {
      throw new AppError('STATE_CONFLICT');
    }
    entries.push(entry);
    this.#history.set(evidence.evidenceId, entries);
    this.#evidence.set(evidence.evidenceId, structuredClone(evidence));
  }
}
