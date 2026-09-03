import { TextDecoder } from 'node:util';
import { hashParts, opaqueBuyerOrganizationRef, opaqueSellerIdentityRef } from '../canonical.js';
import { AppError, asAppError } from '../errors.js';
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
import type { FabricContractLike, FabricContractProvider, SubmittedTransactionLike } from './fabric-connection.js';

const decoder = new TextDecoder('utf8', { fatal: true });
const HASH = /^sha256:[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_HISTORY_ENTRIES = 64;
const MAX_HISTORY_RESPONSE_BYTES = 512 * 1024;

function decode(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(decoder.decode(bytes)) as unknown;
  } catch (error) {
    throw new AppError('LEDGER_UNAVAILABLE', { cause: error });
  }
}

function requiredString(record: Record<string, unknown>, key: string, pattern?: RegExp): string {
  const value = record[key];
  if (typeof value !== 'string' || (pattern !== undefined && !pattern.test(value))) {
    throw new AppError('LEDGER_UNAVAILABLE');
  }
  return value;
}

export function normalizeEvidence(value: unknown): LedgerWorkEvidence {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new AppError('LEDGER_UNAVAILABLE');
  const record = value as Record<string, unknown>;
  const version = record['version'];
  const aggregateVersion = record['aggregateVersion'];
  const buyerDecision = record['buyerDecision'];
  if (!Number.isSafeInteger(version) || (version as number) < 1
    || !Number.isSafeInteger(aggregateVersion) || (aggregateVersion as number) < 1
    || !['PENDING', 'APPROVED', 'REVISION_REQUIRED', 'DISPUTED'].includes(String(buyerDecision))) {
    throw new AppError('LEDGER_UNAVAILABLE');
  }
  const result: LedgerWorkEvidence = {
    schemaVersion: '1.0',
    evidenceId: requiredString(record, 'evidenceId', ID),
    contractHash: requiredString(record, 'contractHash', HASH),
    milestoneHash: requiredString(record, 'milestoneHash', HASH),
    fileHash: requiredString(record, 'fileHash', HASH),
    sellerIdentityRef: requiredString(record, 'sellerIdentityRef', ID),
    buyerOrganizationRef: requiredString(record, 'buyerOrganizationRef', /^buyer:[a-f0-9]{64}$/u),
    version: version as number,
    submittedAt: requiredString(record, 'submittedAt'),
    buyerDecision: buyerDecision as LedgerWorkEvidence['buyerDecision'],
    fabricTxId: requiredString(record, 'fabricTxId', ID),
    aggregateVersion: aggregateVersion as number,
    ...(record['buyerDecisionHash'] === undefined
      ? {}
      : { buyerDecisionHash: requiredString(record, 'buyerDecisionHash', HASH) }),
    ...(record['decidedAt'] === undefined ? {} : { decidedAt: requiredString(record, 'decidedAt') }),
  };
  if (Number.isNaN(Date.parse(result.submittedAt))
    || (result.decidedAt !== undefined && Number.isNaN(Date.parse(result.decidedAt)))) {
    throw new AppError('LEDGER_UNAVAILABLE');
  }
  return result;
}

function normalizeHistory(value: unknown): readonly WorkEvidenceHistoryEntry[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_HISTORY_ENTRIES) {
    throw new AppError('LEDGER_UNAVAILABLE');
  }
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_HISTORY_RESPONSE_BYTES) {
    throw new AppError('LEDGER_UNAVAILABLE');
  }
  return value.map((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new AppError('LEDGER_UNAVAILABLE');
    const record = item as Record<string, unknown>;
    if (typeof record['isDelete'] !== 'boolean') throw new AppError('LEDGER_UNAVAILABLE');
    return {
      transactionId: requiredString(record, 'transactionId', ID),
      timestamp: requiredString(record, 'timestamp'),
      isDelete: record['isDelete'],
      ...(record['value'] === undefined ? {} : { value: normalizeEvidence(record['value']) }),
    };
  });
}

function requireSeller(actor: AuthenticatedActor): void {
  if (actor.role !== 'freelancer' && actor.role !== 'supplier') throw new AppError('FORBIDDEN');
}

function requireBuyer(actor: AuthenticatedActor): void {
  if (actor.role !== 'company_member') throw new AppError('FORBIDDEN');
}

function authorizeRead(actor: AuthenticatedActor, evidence: LedgerWorkEvidence): void {
  if (['payments_service', 'audit_service', 'platform_admin'].includes(actor.role)) return;
  if ((actor.role === 'freelancer' || actor.role === 'supplier')
    && opaqueSellerIdentityRef(actor) === evidence.sellerIdentityRef) return;
  if (actor.role === 'company_member'
    && opaqueBuyerOrganizationRef(actor.organizationId) === evidence.buyerOrganizationRef) return;
  throw new AppError('FORBIDDEN');
}

export interface FabricEvidenceLedgerOptions {
  readonly provider: FabricContractProvider;
  readonly channelName: string;
  readonly chaincodeName: string;
  readonly commitStatusRetries?: number;
  readonly retryDelayMs?: number;
}

export class FabricEvidenceLedger implements EvidenceLedger {
  readonly #provider: FabricContractProvider;
  readonly #channelName: string;
  readonly #chaincodeName: string;
  readonly #commitStatusRetries: number;
  readonly #retryDelayMs: number;

  public constructor(options: FabricEvidenceLedgerOptions) {
    this.#provider = options.provider;
    this.#channelName = options.channelName;
    this.#chaincodeName = options.chaincodeName;
    this.#commitStatusRetries = options.commitStatusRetries ?? 2;
    this.#retryDelayMs = options.retryDelayMs ?? 100;
  }

  public async submit(
    actor: AuthenticatedActor,
    metadata: RequestMetadata,
    input: SubmitEvidenceInput,
  ): Promise<LedgerWorkEvidence> {
    requireSeller(actor);
    const contract = await this.#provider.getContract('seller');
    return this.#submit(contract, 'submit', 'SubmitWorkEvidence', [
      input.evidenceId,
      input.contractHash,
      input.milestoneHash,
      input.fileHash,
      opaqueSellerIdentityRef(actor),
      input.buyerOrganizationRef,
      String(input.version),
      metadata.ledgerIdempotencyKey,
    ], metadata.ledgerIdempotencyKey);
  }

  public async decide(
    actor: AuthenticatedActor,
    metadata: RequestMetadata,
    input: DecideEvidenceInput,
  ): Promise<LedgerWorkEvidence> {
    requireBuyer(actor);
    const contract = await this.#provider.getContract('buyer');
    const buyerOrganizationRef = opaqueBuyerOrganizationRef(actor.organizationId);
    const decisionHash = hashParts(
      'optiwork.fabric.buyer-decision.v1', input.evidenceId, input.expectedFileHash,
      String(input.expectedVersion), input.decision, buyerOrganizationRef,
    );
    return this.#submit(contract, 'decide', 'DecideWorkEvidence', [
      input.evidenceId,
      input.decision,
      input.expectedFileHash,
      String(input.expectedVersion),
      buyerOrganizationRef,
      decisionHash,
      metadata.ledgerIdempotencyKey,
    ], metadata.ledgerIdempotencyKey);
  }

  public async get(actor: AuthenticatedActor, evidenceId: string): Promise<LedgerWorkEvidence> {
    try {
      const contract = await this.#provider.getContract('reader');
      const evidence = normalizeEvidence(decode(await contract.evaluate('GetWorkEvidence', { arguments: [evidenceId] })));
      authorizeRead(actor, evidence);
      return evidence;
    } catch (error) {
      throw asAppError(error);
    }
  }

  public async history(
    actor: AuthenticatedActor,
    evidenceId: string,
  ): Promise<readonly WorkEvidenceHistoryEntry[]> {
    try {
      const contract = await this.#provider.getContract('reader');
      const history = normalizeHistory(decode(await contract.evaluate('GetWorkEvidenceHistory', { arguments: [evidenceId] })));
      const latest = history.at(-1)?.value;
      if (latest === undefined) throw new AppError('LEDGER_UNAVAILABLE');
      authorizeRead(actor, latest);
      return history;
    } catch (error) {
      throw asAppError(error);
    }
  }

  public async readiness(): Promise<LedgerReadiness> {
    return {
      ready: await this.#provider.readiness(),
      mode: 'fabric',
      channel: this.#channelName,
      chaincode: this.#chaincodeName,
    };
  }

  public async close(): Promise<void> {
    await this.#provider.close();
  }

  async #submit(
    contract: FabricContractLike,
    operation: 'submit' | 'decide',
    transactionName: string,
    args: string[],
    ledgerIdempotencyKey: string,
  ): Promise<LedgerWorkEvidence> {
    let submitted: SubmittedTransactionLike;
    try {
      submitted = await contract.submitAsync(transactionName, { arguments: args });
    } catch (error) {
      const mapped = asAppError(error);
      if (mapped.code !== 'LEDGER_COMMIT_TIMEOUT') throw mapped;
      return this.#reconcileCommand(contract, operation, ledgerIdempotencyKey, mapped);
    }
    const result = normalizeEvidence(decode(submitted.getResult()));
    for (let attempt = 0; ; attempt += 1) {
      try {
        const status = await submitted.getStatus();
        if (!status.successful) throw new AppError('STATE_CONFLICT');
        if (status.transactionId !== submitted.getTransactionId()) throw new AppError('LEDGER_UNAVAILABLE');
        return result;
      } catch (error) {
        const mapped = asAppError(error);
        if (mapped.code !== 'LEDGER_COMMIT_TIMEOUT' || attempt >= this.#commitStatusRetries) throw mapped;
        await new Promise((resolve) => setTimeout(resolve, this.#retryDelayMs * 2 ** attempt));
      }
    }
  }

  async #reconcileCommand(
    contract: FabricContractLike,
    operation: 'submit' | 'decide',
    ledgerIdempotencyKey: string,
    original: AppError,
  ): Promise<LedgerWorkEvidence> {
    try {
      const result = await contract.evaluate('GetCommandResult', {
        arguments: [operation, ledgerIdempotencyKey],
      });
      return normalizeEvidence(decode(result));
    } catch {
      throw original;
    }
  }
}
