import { z } from "zod";

import { sha256 } from "../canonical.js";
import type { ExecutorConfig } from "../config.js";
import { forbidden, unavailable } from "../errors.js";
import { workEvidenceSchema } from "./fabric-evidence-reader.js";
import { type CommandContext, type PermitClaims } from "../types.js";

const envelopeSchema = z.object({
  success: z.literal(true),
  data: z.unknown(),
  error: z.null(),
}).strict();

const tokenResponseSchema = z.object({
  access_token: z.string().min(16).max(16_384).regex(/^\S+$/u),
  token_type: z.string().refine((value) => value.toLowerCase() === "bearer"),
  expires_in: z.number().int().min(5).max(86_400),
}).passthrough();

const intentSchema = z.object({
  schemaVersion: z.literal("1.0"),
  intentId: z.string(),
  dealId: z.string(),
  milestoneId: z.string(),
  bindingHash: z.string(),
  status: z.enum(["READY", "CLAIMED", "CONSUMED", "CANCELLED", "SUPERSEDED"]),
  fenceGeneration: z.number().int().nonnegative(),
  leaseExpiresAt: z.string().datetime({ offset: true }).optional(),
  algorandTransactionId: z.string().optional(),
  supersededByIntentId: z.string().optional(),
  lastFabricTransactionId: z.string(),
  ledgerTimestamp: z.string().datetime({ offset: true }),
}).strict();

const privateBindingSchema = z.object({
  schemaVersion: z.literal("1.0"),
  binding: z.object({
    schemaVersion: z.literal("1.0"),
    intentId: z.string(),
    agreementId: z.string(),
    agreementHash: z.string(),
    dealId: z.string(),
    milestoneId: z.string(),
    escrowNetwork: z.enum(["localnet", "testnet"]),
    escrowGenesisHash: z.string(),
    escrowApplicationId: z.string(),
    originProviderAddress: z.string(),
    destinationProviderAddress: z.string(),
    assetId: z.string(),
    amount: z.object({ amountMinor: z.string(), currency: z.string(), scale: z.number() }).strict(),
  }).strict(),
  bindingHash: z.string(),
  status: z.enum(["READY", "CLAIMED", "CONSUMED", "CANCELLED", "SUPERSEDED"]),
  fenceGeneration: z.number().int().nonnegative(),
  leaseExpiresAt: z.string().datetime({ offset: true }).optional(),
  algorandTransactionId: z.string().optional(),
  supersededByIntentId: z.string().optional(),
}).strict();

const fenceCommitmentSchema = z.object({
  schemaVersion: z.literal("1.0"),
  fencingTokenHash: z.string(),
  dealId: z.string(),
  milestoneId: z.string(),
  intentId: z.string(),
  bindingHash: z.string(),
  fenceGeneration: z.number().int().positive(),
  leaseExpiresAt: z.string().datetime({ offset: true }),
  lastFabricTransactionId: z.string(),
}).strict();

export interface AuthoritativeFabricReader {
  readiness?(): Promise<boolean>;
  verifyCurrent(claims: PermitClaims, command: CommandContext): Promise<void>;
}

export class HttpAuthoritativeFabricReader implements AuthoritativeFabricReader {
  private cachedAccessToken?: { readonly value: string; readonly refreshAtMs: number };
  private accessTokenRequest?: Promise<{ readonly value: string; readonly refreshAtMs: number }>;

  constructor(private readonly config: ExecutorConfig) {}

  async readiness(): Promise<boolean> {
    try {
      await this.accessToken();
      return true;
    } catch {
      return false;
    }
  }

  /** Shares this reader's cached workload identity with sibling Gateway clients. */
  async bearerToken(): Promise<string> {
    return this.accessToken();
  }

  async verifyCurrent(claims: PermitClaims, command: CommandContext): Promise<void> {
    if (claims.action !== "release") {
      if (claims.authoritativeReads.length !== 0) {
        throw forbidden("A non-release permit cannot claim mutable Fabric payment state.");
      }
      return;
    }
    const values = new Map<string, unknown>();
    for (const read of claims.authoritativeReads) {
      if (read.path.includes("..") || read.path.includes("//")) {
        throw forbidden("The permit contains an unauthorized Fabric read path.");
      }
      const value = await this.read(read.path);
      if (sha256(value) !== read.dataHash) throw forbidden("Fabric state changed after the permit was issued.");
      values.set(read.path, value);
    }
    this.verifyRelease(claims, values);
  }

  private verifyRelease(claims: Extract<PermitClaims, { action: "release" }>, values: Map<string, unknown>): void {
    const release = claims.releaseAuthorization;
    const path = `/v1/evidence/${encodeURIComponent(release.evidenceId)}/projection`;
    if (values.size !== 1 || !values.has(path)) {
      throw forbidden("A release permit must authorize exactly one approved-evidence Fabric re-read.");
    }
    const evidence = workEvidenceSchema.safeParse(values.get(path));
    if (!evidence.success || evidence.data.buyerDecision !== "APPROVED"
      || evidence.data.evidenceId !== release.evidenceId
      || evidence.data.fabricTxId !== release.fabricClaimTransactionId
      || sha256(evidence.data) !== release.releaseBinding.workEvidenceHash) {
      throw forbidden("The approved Fabric evidence no longer matches the signed release.");
    }
  }

  private async read(path: string): Promise<unknown> {
    let accessToken = await this.accessToken();
    let response = await this.fabricRequest(path, accessToken);
    if (response.status === 401 && this.config.fabricGatewayAuth.mode === "oidc") {
      this.invalidateAccessToken(accessToken);
      accessToken = await this.accessToken();
      response = await this.fabricRequest(path, accessToken);
    }
    if (!response.ok || !/^application\/json(?:\s*;|$)/iu.test(response.headers.get("content-type") ?? "")) {
      throw unavailable("The authoritative Fabric re-read was rejected.");
    }
    const text = await response.text();
    if (text.length === 0 || text.length > 1_048_576) throw unavailable("The Fabric response size is invalid.");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw unavailable("The Fabric response is not valid JSON.");
    }
    const envelope = envelopeSchema.safeParse(parsed);
    if (!envelope.success) throw unavailable("The Fabric response contract is invalid.");
    return envelope.data.data;
  }

  private async fabricRequest(path: string, accessToken: string): Promise<Response> {
    const target = new URL(this.config.FABRIC_GATEWAY_URL);
    target.pathname = `${target.pathname.replace(/\/$/u, "")}${path}`;
    try {
      return await fetch(target, {
        method: "GET",
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(this.config.FABRIC_GATEWAY_TIMEOUT_MS),
        headers: {
          accept: "application/json",
          authorization: `Bearer ${accessToken}`,
        },
      });
    } catch {
      throw unavailable("The authoritative Fabric re-read failed.");
    }
  }

  private async accessToken(): Promise<string> {
    const auth = this.config.fabricGatewayAuth;
    if (auth.mode === "static") return auth.bearerToken;
    const cached = this.cachedAccessToken;
    if (cached !== undefined && cached.refreshAtMs > Date.now()) return cached.value;
    if (this.accessTokenRequest !== undefined) return (await this.accessTokenRequest).value;

    const request = this.requestAccessToken();
    this.accessTokenRequest = request;
    try {
      const token = await request;
      this.cachedAccessToken = token;
      return token.value;
    } finally {
      if (this.accessTokenRequest === request) delete this.accessTokenRequest;
    }
  }

  private invalidateAccessToken(rejectedToken: string): void {
    if (this.cachedAccessToken?.value === rejectedToken) delete this.cachedAccessToken;
  }

  private async requestAccessToken(): Promise<{ readonly value: string; readonly refreshAtMs: number }> {
    const auth = this.config.fabricGatewayAuth;
    if (auth.mode !== "oidc") throw unavailable("Gateway OIDC is not configured.");
    const body = new URLSearchParams({ grant_type: "client_credentials" });
    if (auth.scope !== undefined) body.set("scope", auth.scope);
    const formEncode = (value: string) => new URLSearchParams({ value }).toString().slice("value=".length);
    const encodedClient = formEncode(auth.clientId);
    const encodedSecret = formEncode(auth.clientSecret);
    let response: Response;
    try {
      response = await fetch(auth.tokenUrl, {
        method: "POST",
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(this.config.FABRIC_GATEWAY_TIMEOUT_MS),
        headers: {
          accept: "application/json",
          authorization: `Basic ${Buffer.from(`${encodedClient}:${encodedSecret}`, "utf8").toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      });
    } catch {
      throw unavailable("The Gateway OIDC token request failed.");
    }
    if (!response.ok || !/^application\/json(?:\s*;|$)/iu.test(response.headers.get("content-type") ?? "")) {
      throw unavailable("The Gateway OIDC token request was rejected.");
    }
    const text = await response.text();
    if (text.length === 0 || text.length > 65_536) throw unavailable("The Gateway OIDC token response size is invalid.");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw unavailable("The Gateway OIDC token response is not valid JSON.");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
      || Object.keys(parsed).length > 64) {
      throw unavailable("The Gateway OIDC token response contract is invalid.");
    }
    const token = tokenResponseSchema.safeParse(parsed);
    if (!token.success) throw unavailable("The Gateway OIDC token response contract is invalid.");
    const lifetimeMs = token.data.expires_in * 1_000;
    const refreshSkewMs = Math.min(auth.refreshSkewSeconds * 1_000, Math.floor(lifetimeMs / 2));
    return {
      value: token.data.access_token,
      refreshAtMs: Date.now() + lifetimeMs - refreshSkewMs,
    };
  }
}
