/**
 * The API's Fabric boundary.
 *
 * Hyperledger Fabric is owned by a separate workstream. This module is the only
 * place the API touches it, and it deals exclusively in commitments: a work
 * submission's hashes, a version, a buyer decision and a Fabric transaction
 * reference. No name, file, contract text, payment state or wallet address ever
 * crosses this boundary.
 *
 * The in-memory implementation lets the whole demo run with no Fabric network.
 * Swapping in a Gateway-backed implementation requires no change to any route,
 * service or table - see docs/CLAUDE_INTEGRATION_NOTES.md.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { canonicalHash } from '../canonical.js';
import { conflict, forbidden, notFound, unavailable } from '../errors.js';
import { sha256Text } from '../runtime.js';

export type BuyerDecision = 'PENDING' | 'APPROVED' | 'REVISION_REQUIRED' | 'DISPUTED';

/** Exactly the projection the executor re-reads before it signs a release. */
export interface WorkEvidence {
  readonly evidenceId: string;
  readonly contractHash: string;
  readonly milestoneHash: string;
  readonly fileHash: string;
  readonly subjectRef: string;
  readonly version: number;
  readonly submittedAt: string;
  readonly buyerDecision: BuyerDecision;
  readonly buyerDecisionHash?: string;
  readonly decidedAt?: string;
  readonly fabricTxId?: string;
}

export interface SubmissionCommitment {
  readonly dealId: string;
  readonly milestoneId: string;
  readonly evidenceId: string;
  readonly contractHash: string;
  readonly milestoneHash: string;
  readonly fileHash: string;
  readonly subjectRef: string;
  readonly buyerOrganizationRef: string;
  readonly version: number;
  readonly submittedAt: string;
}

export interface FabricActorContext {
  readonly subject: string;
  readonly organizationId: string;
  readonly role: 'company_member' | 'freelancer' | 'supplier' | 'payments_service';
}

export interface DecisionCommitment {
  readonly evidenceId: string;
  readonly decision: Exclude<BuyerDecision, 'PENDING'>;
  readonly expectedFileHash: string;
  readonly expectedVersion: number;
}

export interface FabricRecord {
  readonly evidence: WorkEvidence;
  readonly fabricTxId: string;
}

export interface FabricEvidenceReader {
  readonly mode: 'gateway' | 'mock';
  recordSubmission(actor: FabricActorContext, commitment: SubmissionCommitment): Promise<FabricRecord>;
  recordDecision(actor: FabricActorContext, commitment: DecisionCommitment): Promise<FabricRecord>;
  read(evidenceId: string): Promise<WorkEvidence | null>;
}

/** The canonical hash the executor and the Gateway must both reproduce. */
export function workEvidenceHash(evidence: WorkEvidence): string {
  return canonicalHash(evidence);
}

export function fabricTransactionHash(fabricTxId: string): string {
  return sha256Text(fabricTxId);
}

/** Opaque buyer organization reference shared with the Fabric chaincode. */
export function buyerOrganizationRef(organizationId: string): string {
  return `buyer:${sha256Text(`optiwork.fabric.buyer-organization-ref.v1\0${organizationId}`).slice(7)}`;
}

/**
 * In-memory Fabric stand-in.
 *
 * It behaves like the real chaincode in the ways that matter to the rest of the
 * system: a submission creates a new immutable version, a decision is recorded
 * once and never rewritten, and every write returns a transaction reference.
 * When an evidence fixture path is configured it also mirrors approved versions
 * to disk so the Algorand executor's own re-read has something to read.
 */
export class MockFabricEvidenceReader implements FabricEvidenceReader {
  readonly mode = 'mock' as const;
  readonly #records = new Map<string, WorkEvidence>();
  readonly #owners = new Map<string, { sellerOrganizationId: string; buyerOrganizationRef: string }>();
  #sequence = 0;

  constructor(private readonly fixturePath?: string) {}

  async recordSubmission(actor: FabricActorContext, commitment: SubmissionCommitment): Promise<FabricRecord> {
    if (actor.role !== 'freelancer' && actor.role !== 'supplier') throw forbidden();
    const existing = this.#records.get(commitment.evidenceId);
    const owner = this.#owners.get(commitment.evidenceId);
    if (existing === undefined && commitment.version !== 1) {
      throw conflict('A Fabric evidence aggregate must begin at version 1.');
    }
    if (existing && (existing.buyerDecision !== 'REVISION_REQUIRED' || commitment.version !== existing.version + 1)) {
      throw conflict(`Fabric cannot accept version ${commitment.version} after ${existing.buyerDecision}.`);
    }
    if (owner && (owner.sellerOrganizationId !== actor.organizationId
      || owner.buyerOrganizationRef !== commitment.buyerOrganizationRef)) {
      throw forbidden('The Fabric evidence aggregate belongs to another organization.');
    }
    const evidence: WorkEvidence = {
      evidenceId: commitment.evidenceId,
      contractHash: commitment.contractHash,
      milestoneHash: commitment.milestoneHash,
      fileHash: commitment.fileHash,
      subjectRef: commitment.subjectRef,
      version: commitment.version,
      submittedAt: commitment.submittedAt,
      buyerDecision: 'PENDING',
    };
    this.#owners.set(commitment.evidenceId, {
      sellerOrganizationId: actor.organizationId,
      buyerOrganizationRef: commitment.buyerOrganizationRef,
    });
    return this.#write(evidence, 'SUBMIT');
  }

  async recordDecision(actor: FabricActorContext, commitment: DecisionCommitment): Promise<FabricRecord> {
    if (actor.role !== 'company_member') throw forbidden();
    const current = this.#records.get(commitment.evidenceId);
    if (!current) throw notFound('Fabric holds no submission for this milestone.');
    const owner = this.#owners.get(commitment.evidenceId);
    if (!owner || owner.buyerOrganizationRef !== buyerOrganizationRef(actor.organizationId)) throw forbidden();
    if (current.buyerDecision !== 'PENDING') {
      throw conflict(`Fabric already recorded decision ${current.buyerDecision} for this version.`);
    }
    if (current.fileHash !== commitment.expectedFileHash || current.version !== commitment.expectedVersion) {
      throw conflict('The Fabric evidence version changed before the buyer decision.');
    }
    const buyerDecisionHash = canonicalHash({
      evidenceId: current.evidenceId,
      fileHash: current.fileHash,
      version: current.version,
      decision: commitment.decision,
      buyerOrganizationRef: owner.buyerOrganizationRef,
    });
    const decidedAt = new Date().toISOString();
    const evidence: WorkEvidence = {
      ...current,
      buyerDecision: commitment.decision,
      buyerDecisionHash,
      decidedAt,
    };
    return this.#write(evidence, 'DECIDE');
  }

  async read(evidenceId: string): Promise<WorkEvidence | null> {
    const found = this.#records.get(evidenceId);
    return found ? structuredClone(found) : null;
  }

  async #write(
    evidence: WorkEvidence,
    action: 'SUBMIT' | 'DECIDE',
  ): Promise<FabricRecord> {
    this.#sequence += 1;
    // A deterministic, opaque transaction reference. It commits to the exact
    // evidence bytes, so a changed version cannot reuse an older reference.
    const fabricTxId = `FABRIC-${action}-${String(this.#sequence).padStart(6, '0')}-`
      + `${workEvidenceHash(evidence).slice(7, 19)}`;
    const stored: WorkEvidence = { ...evidence, fabricTxId };
    this.#records.set(evidence.evidenceId, stored);
    await this.#mirror();
    return { evidence: structuredClone(stored), fabricTxId };
  }

  /**
   * Mirrors approved evidence to the file the executor reads. Only approved
   * versions are published, so the executor cannot be handed an unapproved one.
   */
  async #mirror(): Promise<void> {
    if (!this.fixturePath) return;
    const evidence: Record<string, WorkEvidence> = {};
    for (const [evidenceId, record] of this.#records) {
      if (record.buyerDecision === 'APPROVED') evidence[evidenceId] = record;
    }
    try {
      await mkdir(dirname(this.fixturePath), { recursive: true });
      await writeFile(this.fixturePath, `${JSON.stringify({ schemaVersion: '1.0', evidence }, null, 2)}\n`, 'utf8');
    } catch {
      throw unavailable('The Fabric evidence fixture could not be written.');
    }
  }
}

interface Envelope {
  readonly success: true;
  readonly data: unknown;
  readonly error: null;
}

interface GatewayAuth {
  readonly mode: 'demo' | 'bearer';
  readonly bearerToken?: string;
}

/**
 * Gateway-backed reader. Writes are the Fabric workstream's responsibility, so
 * this implementation reads the same projection the executor reads and refuses
 * to fabricate a write.
 */
export class GatewayFabricEvidenceReader implements FabricEvidenceReader {
  readonly mode = 'gateway' as const;

  constructor(
    private readonly gatewayUrl: string,
    private readonly auth: GatewayAuth,
    private readonly timeoutMs = 4_000,
  ) {}

  async recordSubmission(actor: FabricActorContext, commitment: SubmissionCommitment): Promise<FabricRecord> {
    const evidence = await this.#request('/v1/evidence', 'POST', actor, {
      evidenceId: commitment.evidenceId,
      contractHash: commitment.contractHash,
      milestoneHash: commitment.milestoneHash,
      fileHash: commitment.fileHash,
      buyerOrganizationRef: commitment.buyerOrganizationRef,
      version: commitment.version,
    }, `submit-${commitment.evidenceId}-v${commitment.version}`);
    return this.#record(evidence);
  }

  async recordDecision(actor: FabricActorContext, commitment: DecisionCommitment): Promise<FabricRecord> {
    const evidence = await this.#request(
      `/v1/evidence/${encodeURIComponent(commitment.evidenceId)}/decisions`,
      'POST',
      actor,
      {
        decision: commitment.decision,
        expectedFileHash: commitment.expectedFileHash,
        expectedVersion: commitment.expectedVersion,
      },
      `decide-${commitment.evidenceId}-v${commitment.expectedVersion}-${commitment.decision}`,
    );
    return this.#record(evidence);
  }

  async read(evidenceId: string): Promise<WorkEvidence | null> {
    const serviceActor: FabricActorContext = {
      subject: 'optiwork-payments', organizationId: 'optiwork-platform', role: 'payments_service',
    };
    const result = await this.#request(
      `/v1/evidence/${encodeURIComponent(evidenceId)}/projection`, 'GET', serviceActor,
    );
    return result === null ? null : this.#project(result);
  }

  async #request(
    path: string,
    method: 'GET' | 'POST',
    actor: FabricActorContext,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<unknown | null> {
    const target = new URL(path, `${this.gatewayUrl.replace(/\/$/u, '')}/`);
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (idempotencyKey !== undefined) headers['idempotency-key'] = idempotencyKey;
    if (this.auth.mode === 'demo') {
      headers['x-demo-subject'] = actor.subject;
      headers['x-demo-organization'] = actor.organizationId;
      headers['x-demo-role'] = actor.role;
    } else if (this.auth.bearerToken !== undefined) {
      headers['authorization'] = `Bearer ${this.auth.bearerToken}`;
    }
    let response: Response;
    try {
      response = await fetch(target, {
        method,
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(this.timeoutMs),
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw unavailable('The Fabric Gateway is unreachable.');
    }
    if (response.status === 404) return null;
    if (response.status === 403) throw forbidden('The Fabric Gateway rejected the actor.');
    if (response.status === 409) throw conflict('The Fabric Gateway rejected a stale or duplicate command.');
    if (!response.ok) throw unavailable('The Fabric Gateway rejected the request.');
    const envelope = await response.json() as Envelope;
    if (envelope.success !== true || envelope.error !== null) throw unavailable('The Fabric Gateway returned an invalid envelope.');
    return envelope.data;
  }

  #record(value: unknown): FabricRecord {
    const evidence = this.#project(value);
    if (!evidence.fabricTxId) throw unavailable('The Fabric Gateway omitted the transaction identifier.');
    return { evidence, fabricTxId: evidence.fabricTxId };
  }

  #project(value: unknown): WorkEvidence {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw unavailable('The Fabric Gateway returned invalid evidence.');
    }
    const record = value as Record<string, unknown>;
    const subjectRef = typeof record['subjectRef'] === 'string'
      ? record['subjectRef']
      : record['sellerIdentityRef'];
    const required = ['evidenceId', 'contractHash', 'milestoneHash', 'fileHash', 'submittedAt', 'buyerDecision'];
    if (required.some((key) => typeof record[key] !== 'string')
      || typeof subjectRef !== 'string'
      || !Number.isSafeInteger(record['version'])) {
      throw unavailable('The Fabric Gateway returned invalid evidence.');
    }
    return {
      evidenceId: record['evidenceId'] as string,
      contractHash: record['contractHash'] as string,
      milestoneHash: record['milestoneHash'] as string,
      fileHash: record['fileHash'] as string,
      subjectRef,
      version: record['version'] as number,
      submittedAt: record['submittedAt'] as string,
      buyerDecision: record['buyerDecision'] as BuyerDecision,
      ...(typeof record['buyerDecisionHash'] === 'string' ? { buyerDecisionHash: record['buyerDecisionHash'] } : {}),
      ...(typeof record['decidedAt'] === 'string' ? { decidedAt: record['decidedAt'] } : {}),
      ...(typeof record['fabricTxId'] === 'string' ? { fabricTxId: record['fabricTxId'] } : {}),
    };
  }
}

/** Reads a fixture file written by a previous run; used by the demo seeder. */
export async function readEvidenceFixture(path: string): Promise<Record<string, WorkEvidence>> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as { evidence?: Record<string, WorkEvidence> };
    return parsed.evidence ?? {};
  } catch {
    return {};
  }
}
