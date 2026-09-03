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
import { conflict, notFound, unavailable } from '../errors.js';
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

export interface DecisionCommitment {
  readonly dealId: string;
  readonly milestoneId: string;
  readonly decision: Exclude<BuyerDecision, 'PENDING'>;
  readonly buyerRef: string;
  readonly decidedAt: string;
}

export interface FabricRecord {
  readonly evidence: WorkEvidence;
  readonly fabricTxId: string;
}

export interface FabricEvidenceReader {
  readonly mode: 'gateway' | 'mock';
  recordSubmission(commitment: SubmissionCommitment): Promise<FabricRecord>;
  recordDecision(commitment: DecisionCommitment): Promise<FabricRecord>;
  read(dealId: string, milestoneId: string): Promise<WorkEvidence | null>;
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

function key(dealId: string, milestoneId: string): string {
  return `${encodeURIComponent(dealId)}/${encodeURIComponent(milestoneId)}`;
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
  #sequence = 0;

  constructor(private readonly fixturePath?: string) {}

  async recordSubmission(commitment: SubmissionCommitment): Promise<FabricRecord> {
    const existing = this.#records.get(key(commitment.dealId, commitment.milestoneId));
    if (existing && existing.version >= commitment.version) {
      throw conflict(`Fabric already holds version ${existing.version} for this milestone.`);
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
    return this.#write(commitment.dealId, commitment.milestoneId, evidence, 'SUBMIT');
  }

  async recordDecision(commitment: DecisionCommitment): Promise<FabricRecord> {
    const current = this.#records.get(key(commitment.dealId, commitment.milestoneId));
    if (!current) throw notFound('Fabric holds no submission for this milestone.');
    if (current.buyerDecision !== 'PENDING') {
      throw conflict(`Fabric already recorded decision ${current.buyerDecision} for this version.`);
    }
    const buyerDecisionHash = canonicalHash({
      evidenceId: current.evidenceId,
      fileHash: current.fileHash,
      version: current.version,
      decision: commitment.decision,
      buyerRef: commitment.buyerRef,
      decidedAt: commitment.decidedAt,
    });
    const evidence: WorkEvidence = {
      ...current,
      buyerDecision: commitment.decision,
      buyerDecisionHash,
      decidedAt: commitment.decidedAt,
    };
    return this.#write(commitment.dealId, commitment.milestoneId, evidence, 'DECIDE');
  }

  async read(dealId: string, milestoneId: string): Promise<WorkEvidence | null> {
    const found = this.#records.get(key(dealId, milestoneId));
    return found ? structuredClone(found) : null;
  }

  async #write(
    dealId: string,
    milestoneId: string,
    evidence: WorkEvidence,
    action: 'SUBMIT' | 'DECIDE',
  ): Promise<FabricRecord> {
    this.#sequence += 1;
    // A deterministic, opaque transaction reference. It commits to the exact
    // evidence bytes, so a changed version cannot reuse an older reference.
    const fabricTxId = `FABRIC-${action}-${String(this.#sequence).padStart(6, '0')}-`
      + `${workEvidenceHash(evidence).slice(7, 19)}`;
    const stored: WorkEvidence = { ...evidence, fabricTxId };
    this.#records.set(key(dealId, milestoneId), stored);
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
    for (const [path, record] of this.#records) {
      if (record.buyerDecision === 'APPROVED') evidence[path] = record;
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

/**
 * Gateway-backed reader. Writes are the Fabric workstream's responsibility, so
 * this implementation reads the same projection the executor reads and refuses
 * to fabricate a write.
 */
export class GatewayFabricEvidenceReader implements FabricEvidenceReader {
  readonly mode = 'gateway' as const;

  constructor(
    private readonly gatewayUrl: string,
    private readonly authorization: () => Promise<string>,
    private readonly timeoutMs = 4_000,
  ) {}

  async recordSubmission(): Promise<FabricRecord> {
    throw unavailable('Writing work evidence is owned by the Fabric Gateway workstream.');
  }

  async recordDecision(): Promise<FabricRecord> {
    throw unavailable('Writing buyer decisions is owned by the Fabric Gateway workstream.');
  }

  async read(dealId: string, milestoneId: string): Promise<WorkEvidence | null> {
    const target = new URL(this.gatewayUrl);
    target.pathname = `${target.pathname.replace(/\/$/u, '')}`
      + `/ledger/deals/${encodeURIComponent(dealId)}`
      + `/milestones/${encodeURIComponent(milestoneId)}/work-evidence`;
    let response: Response;
    try {
      response = await fetch(target, {
        method: 'GET',
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { accept: 'application/json', authorization: await this.authorization() },
      });
    } catch {
      throw unavailable('The Fabric Gateway is unreachable.');
    }
    if (response.status === 404) return null;
    if (!response.ok) throw unavailable('The Fabric Gateway rejected the read.');
    const envelope = await response.json() as Envelope;
    return envelope.data as WorkEvidence;
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
