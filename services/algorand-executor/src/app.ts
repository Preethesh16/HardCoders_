import { timingSafeEqual } from "node:crypto";

import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { ZodError } from "zod";

import type { ExecutorConfig } from "./config.js";
import { ExecutorError, unauthorized } from "./errors.js";
import { ExecutorService } from "./service.js";
import {
  canonicalIdSchema,
  commandReconciliationSchema,
  escrowExpectationSchema,
  idempotencyKeySchema,
  releaseInputSchema,
  releaseEvidenceSchema,
  readinessSchema,
  type ExecutorAction,
} from "./types.js";

const success = <T>(data: T) => ({ success: true as const, data, error: null });

function header(request: FastifyRequest, name: string): string {
  const value = request.headers[name];
  if (typeof value !== "string" || value.length === 0) throw unauthorized();
  return value;
}

function bearer(request: FastifyRequest, expected: string): void {
  const provided = header(request, "authorization");
  const prefix = "Bearer ";
  if (!provided.startsWith(prefix)) throw unauthorized();
  const actual = Buffer.from(provided.slice(prefix.length));
  const wanted = Buffer.from(expected);
  if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) throw unauthorized();
}

function mutationHeaders(request: FastifyRequest): { idempotencyKey: string; permit: string } {
  const key = idempotencyKeySchema.parse(header(request, "idempotency-key"));
  const correlation = header(request, "x-correlation-id");
  if (!idempotencyKeySchema.safeParse(correlation).success) throw new ExecutorError("SCHEMA_INVALID", "The correlation ID is invalid.", 422);
  const permit = header(request, "x-optiwork-fabric-permit");
  return { idempotencyKey: key, permit };
}

function noBody(request: FastifyRequest): null {
  if (request.body !== undefined && request.body !== null && JSON.stringify(request.body) !== "{}") {
    throw new ExecutorError("SCHEMA_INVALID", "This command does not accept a request body.", 422);
  }
  return null;
}

export async function buildApp(config: ExecutorConfig, service: ExecutorService): Promise<FastifyInstance> {
  const app = Fastify({
    bodyLimit: 64 * 1024,
    trustProxy: false,
    logger: {
      level: config.LOG_LEVEL,
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.x-optiwork-fabric-permit",
          "request.headers.authorization",
          "request.headers.x-optiwork-fabric-permit",
        ],
        censor: "[REDACTED]",
      },
    },
    requestIdHeader: false,
  });
  await app.register(helmet, { global: true });
  await app.register(rateLimit, { global: true, max: 120, timeWindow: "1 minute" });
  app.addHook("onRequest", async (request) => {
    if (request.url === "/health/live" || request.url === "/health/ready") return;
    bearer(request, config.EXECUTOR_BEARER_TOKEN);
  });
  app.addHook("onClose", async () => service.close());

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ExecutorError) {
      return reply.status(error.statusCode).send({ success: false, data: null, error: { code: error.code, message: error.message } });
    }
    if (error instanceof ZodError) {
      return reply.status(422).send({ success: false, data: null, error: { code: "SCHEMA_INVALID", message: "Request validation failed." } });
    }
    const status = (error as { statusCode?: number }).statusCode;
    request.log.error({ err: error, code: "EXECUTOR_REQUEST_FAILED" }, "Executor request failed");
    return reply.status(status === 429 ? 429 : 500).send({
      success: false,
      data: null,
      error: { code: status === 429 ? "RATE_LIMITED" : "INTERNAL_ERROR", message: status === 429 ? "Rate limit exceeded." : "Internal service error." },
    });
  });

  app.get("/health/live", async () => success({ status: "live" }));
  app.get("/health/ready", async (_request, reply) => {
    const ready = await service.readiness();
    if (!ready) return reply.status(503).send({ success: false, data: null, error: { code: "NOT_READY", message: "Executor dependencies are not ready." } });
    return success(readinessSchema.parse({
      status: "ready",
      network: config.ALGORAND_NETWORK,
      genesisHash: config.ALGORAND_GENESIS_HASH,
      applicationId: Number(config.ALGORAND_APPLICATION_ID),
      assetId: Number(config.ALGORAND_ASSET_ID),
      signerAddress: config.ALGORAND_SIGNER_ADDRESS,
      originProviderTreasuryAddress: config.ALGORAND_ORIGIN_PROVIDER_TREASURY_ADDRESS,
      confirmationRounds: config.ALGORAND_CONFIRMATION_ROUNDS,
      capabilities: {
        create: true,
        fund: true,
        release: true,
        pause: true,
        resume: true,
        refund: true,
        complete: true,
        confirmedTransactions: true,
        durableIdempotency: true,
        signedFabricPermits: true,
        authoritativeFabricReread: true,
        approvedWorkEvidenceReread: true,
      },
    }));
  });

  app.post("/escrows", async (request, reply) => {
    const { idempotencyKey, permit } = mutationHeaders(request);
    const body = escrowExpectationSchema.parse(request.body);
    const result = await service.mutate({ action: "create", method: "POST", path: "/escrows", idempotencyKey, body }, permit);
    return reply.status(201).send(success(result));
  });

  app.get<{ Params: { dealId: string } }>("/escrows/:dealId", async (request) =>
    success(await service.getEscrow(canonicalIdSchema.parse(request.params.dealId))));

  app.get<{ Params: { dealId: string; milestoneId: string } }>(
    "/escrows/:dealId/releases/:milestoneId",
    async (request) => success(releaseEvidenceSchema.parse(await service.getReleaseEvidence(
      canonicalIdSchema.parse(request.params.dealId),
      canonicalIdSchema.parse(request.params.milestoneId),
    ))),
  );

  const noBodyMutation = (action: Exclude<ExecutorAction, "create" | "release">) =>
    async (request: FastifyRequest<{ Params: { dealId: string } }>) => {
      const dealId = canonicalIdSchema.parse(request.params.dealId);
      const { idempotencyKey, permit } = mutationHeaders(request);
      const body = noBody(request);
      const path = `/escrows/${encodeURIComponent(dealId)}/${action}`;
      return success(await service.mutate({ action, method: "POST", path, idempotencyKey, body }, permit));
    };

  app.post<{ Params: { dealId: string } }>("/escrows/:dealId/fund", noBodyMutation("fund"));
  app.post<{ Params: { dealId: string } }>("/escrows/:dealId/pause", noBodyMutation("pause"));
  app.post<{ Params: { dealId: string } }>("/escrows/:dealId/resume", noBodyMutation("resume"));
  app.post<{ Params: { dealId: string } }>("/escrows/:dealId/refund", noBodyMutation("refund"));
  app.post<{ Params: { dealId: string } }>("/escrows/:dealId/complete", noBodyMutation("complete"));

  app.post<{ Params: { dealId: string } }>("/escrows/:dealId/releases", async (request) => {
    const dealId = canonicalIdSchema.parse(request.params.dealId);
    const { idempotencyKey, permit } = mutationHeaders(request);
    const body = releaseInputSchema.parse(request.body);
    if (body.escrowBinding.dealId !== dealId) throw new ExecutorError("SCHEMA_INVALID", "Path and release deal IDs differ.", 422);
    const path = `/escrows/${encodeURIComponent(dealId)}/releases`;
    return success(await service.mutate({ action: "release", method: "POST", path, idempotencyKey, body }, permit));
  });

  app.get<{ Params: { idempotencyKey: string } }>("/commands/:idempotencyKey", async (request) =>
    success(await service.evidence(idempotencyKeySchema.parse(request.params.idempotencyKey))));

  // Reconciliation cannot authorize a new transaction: it operates only on
  // the exact command hash already persisted for this idempotency key. The
  // bearer-authenticated caller may materialize a confirmation or release an
  // expired unsigned/signed command fence, but no mutable Fabric permit is
  // accepted here.
  app.post<{ Params: { idempotencyKey: string } }>("/commands/:idempotencyKey/reconcile", async (request) => {
    const idempotencyKey = idempotencyKeySchema.parse(request.params.idempotencyKey);
    const body = releaseInputSchema.parse(request.body);
    const path = `/escrows/${encodeURIComponent(body.escrowBinding.dealId)}/releases`;
    return success(commandReconciliationSchema.parse(await service.reconcile({
      action: "release",
      method: "POST",
      path,
      idempotencyKey,
      body,
    })));
  });

  return app;
}
