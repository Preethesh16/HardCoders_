/**
 * Authoritative approved-work-evidence boundary.
 *
 * Hyperledger Fabric is owned by a separate workstream. The executor never
 * talks to a Fabric SDK directly: it re-reads the *approved* work evidence for
 * a milestone through this narrow port immediately before it signs a release.
 *
 * The port deliberately returns only commitments, an opaque subject reference,
 * a version and a buyer decision. It must never carry personal data, file
 * bytes, contract text, payment state or wallet addresses.
 */

import { readFile } from "node:fs/promises";

import { z } from "zod";

import { sha256, sha256Text } from "../canonical.js";
import type { ExecutorConfig } from "../config.js";
import { forbidden, unavailable } from "../errors.js";
import { canonicalIdSchema, hashSchema } from "../types.js";

export const buyerDecisionSchema = z.enum(["PENDING", "APPROVED", "REVISION_REQUIRED", "DISPUTED"]);

/**
 * The exact Fabric projection the executor is allowed to see. `strict()` means
 * an extra field from a future Gateway release fails closed rather than
 * silently widening what the release decision is based on.
 */
export const workEvidenceSchema = z.object({
  evidenceId: canonicalIdSchema,
  contractHash: hashSchema,
  milestoneHash: hashSchema,
  fileHash: hashSchema,
  subjectRef: canonicalIdSchema,
  version: z.number().int().positive().safe(),
  submittedAt: z.string().datetime({ offset: true }),
  buyerDecision: buyerDecisionSchema,
  buyerDecisionHash: hashSchema.optional(),
  decidedAt: z.string().datetime({ offset: true }).optional(),
  fabricTxId: canonicalIdSchema.optional(),
}).strict();

export type WorkEvidence = z.infer<typeof workEvidenceSchema>;

export type FabricEvidenceQuery = {
  readonly evidenceId: string;
  readonly dealId: string;
  readonly milestoneId: string;
  /** Canonical hash the signed release permit committed to. */
  readonly workEvidenceHash: string;
  /** `sha256Text(fabricTxId)` the signed release permit committed to. */
  readonly fabricTxHash: string;
};

export interface FabricEvidenceReader {
  readApprovedEvidence(query: FabricEvidenceQuery): Promise<WorkEvidence>;
  readiness?(): Promise<boolean>;
}

/** The canonical commitment both the API and the executor must agree on. */
export function workEvidenceHash(evidence: WorkEvidence): `sha256:${string}` {
  return sha256(workEvidenceSchema.parse(evidence));
}

/** The canonical Fabric transaction commitment recorded on Algorand. */
export function fabricTransactionHash(fabricTxId: string): `sha256:${string}` {
  return sha256Text(fabricTxId);
}

/**
 * Fails closed on anything other than the exact approved version the permit
 * was minted against: an unapproved decision, a missing Fabric transaction, a
 * different deal/milestone, or evidence whose bytes changed after signing.
 */
export function assertApprovedEvidence(evidence: WorkEvidence, query: FabricEvidenceQuery): void {
  if (evidence.buyerDecision !== "APPROVED" || !evidence.buyerDecisionHash || !evidence.fabricTxId) {
    throw forbidden("The Fabric work evidence does not carry a confirmed buyer approval.");
  }
  if (workEvidenceHash(evidence) !== query.workEvidenceHash) {
    throw forbidden("The Fabric work evidence changed after the release permit was signed.");
  }
  if (evidence.evidenceId !== query.evidenceId) {
    throw forbidden("The Fabric work evidence identifier does not match the signed release.");
  }
  if (fabricTransactionHash(evidence.fabricTxId) !== query.fabricTxHash) {
    throw forbidden("The Fabric approval transaction does not match the signed release permit.");
  }
}

/**
 * Deterministic in-process reader for the offline demo, contract tests and
 * LocalNet. The real Fabric Gateway replaces it without any other change.
 */
export class MockFabricEvidenceReader implements FabricEvidenceReader {
  readonly #records = new Map<string, WorkEvidence>();
  reads = 0;

  static key(dealId: string, milestoneId: string): string {
    return `${encodeURIComponent(dealId)}/${encodeURIComponent(milestoneId)}`;
  }

  set(dealId: string, milestoneId: string, evidence: WorkEvidence): WorkEvidence {
    const parsed = workEvidenceSchema.parse(evidence);
    this.#records.set(MockFabricEvidenceReader.key(dealId, milestoneId), parsed);
    return structuredClone(parsed);
  }

  /** Simulates Fabric moving to a new version after a permit was signed. */
  revise(dealId: string, milestoneId: string, patch: Partial<WorkEvidence>): void {
    const key = MockFabricEvidenceReader.key(dealId, milestoneId);
    const current = this.#records.get(key);
    if (!current) throw new Error(`No mock Fabric evidence for ${key}.`);
    this.#records.set(key, workEvidenceSchema.parse({ ...current, ...patch }));
  }

  async readApprovedEvidence(query: FabricEvidenceQuery): Promise<WorkEvidence> {
    this.reads += 1;
    const record = this.#records.get(MockFabricEvidenceReader.key(query.dealId, query.milestoneId));
    if (!record) throw forbidden("No Fabric work evidence exists for the milestone being released.");
    assertApprovedEvidence(record, query);
    return structuredClone(record);
  }

  async readiness(): Promise<boolean> {
    return true;
  }
}

/**
 * File-backed evidence for the offline demo profile.
 *
 * The API writes the Fabric mock's approved projections to a shared JSON file
 * and the executor re-reads that file on every release. The file is re-read
 * per call, never cached, so tampering between a permit and a release is
 * detected exactly as a real Fabric re-read would detect it.
 */
export const fabricEvidenceFixtureSchema = z.object({
  schemaVersion: z.literal("1.0"),
  evidence: z.record(z.string().min(1).max(512), workEvidenceSchema),
}).strict();

const MAX_FIXTURE_BYTES = 1_048_576;

export class FileFabricEvidenceReader implements FabricEvidenceReader {
  constructor(private readonly fixturePath: string) {}

  async readApprovedEvidence(query: FabricEvidenceQuery): Promise<WorkEvidence> {
    let raw: string;
    try {
      raw = await readFile(this.fixturePath, "utf8");
    } catch {
      throw unavailable("The Fabric work-evidence fixture is unavailable.");
    }
    if (raw.length === 0 || raw.length > MAX_FIXTURE_BYTES) {
      throw unavailable("The Fabric work-evidence fixture size is invalid.");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw unavailable("The Fabric work-evidence fixture is not valid JSON.");
    }
    const fixture = fabricEvidenceFixtureSchema.safeParse(parsed);
    if (!fixture.success) throw unavailable("The Fabric work-evidence fixture contract is invalid.");
    const record = fixture.data.evidence[MockFabricEvidenceReader.key(query.dealId, query.milestoneId)];
    if (!record) throw forbidden("No Fabric work evidence exists for the milestone being released.");
    assertApprovedEvidence(record, query);
    return record;
  }

  async readiness(): Promise<boolean> {
    try {
      await readFile(this.fixturePath, "utf8");
      return true;
    } catch {
      return false;
    }
  }
}

const envelopeSchema = z.object({
  success: z.literal(true),
  data: z.unknown(),
  error: z.null(),
}).strict();

/**
 * Reads the approved evidence projection published by the Fabric Gateway. The
 * Gateway owns Fabric; this client only performs an authenticated GET and
 * re-validates every commitment locally.
 */
export class HttpFabricEvidenceReader implements FabricEvidenceReader {
  constructor(
    private readonly config: ExecutorConfig,
    private readonly accessToken: () => Promise<string>,
  ) {}

  async readApprovedEvidence(query: FabricEvidenceQuery): Promise<WorkEvidence> {
    const path = `/v1/evidence/${encodeURIComponent(query.evidenceId)}/projection`;
    const target = new URL(this.config.FABRIC_GATEWAY_URL);
    target.pathname = `${target.pathname.replace(/\/$/u, "")}${path}`;
    let response: Response;
    try {
      response = await fetch(target, {
        method: "GET",
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(this.config.FABRIC_GATEWAY_TIMEOUT_MS),
        headers: { accept: "application/json", authorization: `Bearer ${await this.accessToken()}` },
      });
    } catch {
      throw unavailable("The approved Fabric work-evidence re-read failed.");
    }
    if (!response.ok || !/^application\/json(?:\s*;|$)/iu.test(response.headers.get("content-type") ?? "")) {
      throw unavailable("The approved Fabric work-evidence re-read was rejected.");
    }
    const text = await response.text();
    if (text.length === 0 || text.length > 262_144) throw unavailable("The Fabric evidence response size is invalid.");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw unavailable("The Fabric evidence response is not valid JSON.");
    }
    const envelope = envelopeSchema.safeParse(parsed);
    if (!envelope.success) throw unavailable("The Fabric evidence response contract is invalid.");
    const evidence = workEvidenceSchema.safeParse(envelope.data.data);
    if (!evidence.success) throw forbidden("The Fabric work evidence projection is malformed.");
    assertApprovedEvidence(evidence.data, query);
    return evidence.data;
  }
}
