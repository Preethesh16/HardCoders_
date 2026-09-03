import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { DemoActorResolver, OidcActorResolver, type ActorResolver } from './auth.js';
import { loadConfig, type GatewayConfig } from './config.js';
import { failure, sendSuccess } from './envelopes.js';
import { AppError } from './errors.js';
import {
  authenticatedActorScope,
  deriveLedgerIdempotencyKey,
  IdempotencyCoordinator,
  type IdempotencyExecutionOptions,
} from './idempotency.js';
import { PostgresIdempotencyStore } from './idempotency-postgres.js';
import { FabricConnectionManager } from './ledger/fabric-connection.js';
import { FabricEvidenceLedger } from './ledger/fabric-ledger.js';
import { MemoryEvidenceLedger } from './ledger/memory-ledger.js';
import { projectWorkEvidence, ReleasePermitIssuer } from './permit.js';
import {
  DecideEvidenceBodySchema,
  EvidenceParamsSchema,
  GenericPermitBodySchema,
  MutationHeadersSchema,
  QueryHeadersSchema,
  ReleasePermitBodySchema,
  SubmitEvidenceBodySchema,
  type DecideEvidenceBody,
  type EvidenceParams,
  type GenericPermitBody,
  type MutationHeaders,
  type QueryHeaders,
  type ReleasePermitBody,
  type SubmitEvidenceBody,
} from './schemas.js';
import type { AuthenticatedActor, EvidenceLedger, RequestMetadata } from './types.js';

export interface BuildAppOptions {
  readonly config?: GatewayConfig;
  readonly ledger?: EvidenceLedger;
  readonly actorResolver?: ActorResolver;
  readonly permitIssuer?: ReleasePermitIssuer;
  readonly idempotency?: IdempotencyCoordinator;
  readonly logger?: boolean;
}

function requestMetadata(request: FastifyRequest, actor: AuthenticatedActor): RequestMetadata {
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string') throw new AppError('SCHEMA_INVALID');
  const correlation = request.headers['x-correlation-id'];
  return {
    idempotencyKey: key,
    ledgerIdempotencyKey: deriveLedgerIdempotencyKey(actor, key),
    correlationId: typeof correlation === 'string' ? correlation : request.id,
  };
}

async function executeIdempotent<T>(
  coordinator: IdempotencyCoordinator,
  request: FastifyRequest,
  actor: AuthenticatedActor,
  operation: () => Promise<T>,
  options: IdempotencyExecutionOptions<T> = {},
): Promise<T> {
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string') throw new AppError('SCHEMA_INVALID');
  return coordinator.execute(authenticatedActorScope(actor), key, {
    method: request.method,
    route: request.routeOptions.url,
    params: request.params,
    body: request.body,
  }, operation, options);
}

function requirePayments(actor: AuthenticatedActor): void {
  if (actor.role !== 'payments_service') throw new AppError('FORBIDDEN');
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  const app = Fastify({
    logger: options.logger === false ? false : { level: config.logLevel },
    requestIdHeader: 'x-request-id',
    bodyLimit: 256 * 1024,
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false, allErrors: false } },
  }).withTypeProvider<TypeBoxTypeProvider>();
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(rateLimit, {
    global: true,
    max: 120,
    timeWindow: '1 minute',
    errorResponseBuilder: () => new AppError('RATE_LIMITED'),
  });

  let ledger = options.ledger;
  if (ledger === undefined) {
    if (config.fabricMode === 'memory') {
      ledger = new MemoryEvidenceLedger();
    } else {
      const provider = new FabricConnectionManager({
        channelName: config.channelName,
        chaincodeName: config.chaincodeName,
        identities: config.fabricIdentities,
      });
      ledger = new FabricEvidenceLedger({
        provider,
        channelName: config.channelName,
        chaincodeName: config.chaincodeName,
      });
    }
  }
  const actorResolver = options.actorResolver ?? (config.appMode === 'demo'
    ? new DemoActorResolver()
    : new OidcActorResolver(config.oidc!));
  const permitIssuer = options.permitIssuer ?? (config.permit.privateJwk === undefined
    ? await ReleasePermitIssuer.ephemeral(config.permit)
    : await ReleasePermitIssuer.fromPrivateJwk(config.permit.privateJwk, config.permit));
  const idempotency = options.idempotency ?? new IdempotencyCoordinator({
    ttlMs: config.idempotency.ttlMs,
    maxEntries: config.idempotency.maxEntries,
    ...(config.idempotency.store === 'postgres' ? {
      store: PostgresIdempotencyStore.connect({
        connectionString: config.idempotency.databaseUrl!,
        autoMigrate: config.idempotency.autoMigrate,
        maxConnections: 10,
        connectionTimeoutMs: 5_000,
        idleTimeoutMs: 30_000,
      }),
    } : {}),
  });
  await idempotency.initialize();

  app.addHook('onRequest', async (request) => {
    if (config.appMode === 'production'
      && (request.headers['x-demo-subject'] !== undefined
        || request.headers['x-demo-organization'] !== undefined
        || request.headers['x-demo-role'] !== undefined)) {
      throw new AppError('UNAUTHENTICATED');
    }
  });

  app.get('/health/live', async (_request, reply) => sendSuccess(reply, 200, {
    status: 'live',
    service: 'optiwork-fabric-gateway',
  }));

  app.get('/health/ready', async (_request, reply) => {
    const [ledgerState, idempotencyReady] = await Promise.all([ledger.readiness(), idempotency.readiness()]);
    if (!ledgerState.ready || !idempotencyReady) throw new AppError('LEDGER_UNAVAILABLE');
    return sendSuccess(reply, 200, { ...ledgerState, idempotency: { ready: true } });
  });

  app.get('/.well-known/jwks.json', async (_request, reply) => reply.send(permitIssuer.publicJwks()));

  app.post<{ Headers: MutationHeaders; Body: SubmitEvidenceBody }>('/v1/evidence', {
    schema: { headers: MutationHeadersSchema, body: SubmitEvidenceBodySchema },
  }, async (request, reply) => {
    const actor = await actorResolver.resolve(request);
    const metadata = requestMetadata(request, actor);
    const result = await executeIdempotent(idempotency, request, actor, async () =>
      ledger.submit(actor, metadata, request.body));
    return sendSuccess(reply, 201, result);
  });

  app.get<{ Headers: QueryHeaders; Params: EvidenceParams }>('/v1/evidence/:evidenceId', {
    schema: { headers: QueryHeadersSchema, params: EvidenceParamsSchema },
  }, async (request, reply) => {
    const actor = await actorResolver.resolve(request);
    return sendSuccess(reply, 200, { data: await ledger.get(actor, request.params.evidenceId) });
  });

  app.get<{ Headers: QueryHeaders; Params: EvidenceParams }>('/v1/evidence/:evidenceId/projection', {
    schema: { headers: QueryHeadersSchema, params: EvidenceParamsSchema },
  }, async (request, reply) => {
    const actor = await actorResolver.resolve(request);
    requirePayments(actor);
    return sendSuccess(reply, 200, projectWorkEvidence(await ledger.get(actor, request.params.evidenceId)));
  });

  app.get<{ Headers: QueryHeaders; Params: EvidenceParams }>('/v1/evidence/:evidenceId/history', {
    schema: { headers: QueryHeadersSchema, params: EvidenceParamsSchema },
  }, async (request, reply) => {
    const actor = await actorResolver.resolve(request);
    return sendSuccess(reply, 200, { data: await ledger.history(actor, request.params.evidenceId) });
  });

  app.post<{ Headers: MutationHeaders; Params: EvidenceParams; Body: DecideEvidenceBody }>(
    '/v1/evidence/:evidenceId/decisions',
    { schema: { headers: MutationHeadersSchema, params: EvidenceParamsSchema, body: DecideEvidenceBodySchema } },
    async (request, reply) => {
      const actor = await actorResolver.resolve(request);
      const metadata = requestMetadata(request, actor);
      const result = await executeIdempotent(idempotency, request, actor, async () => ledger.decide(actor, metadata, {
        evidenceId: request.params.evidenceId,
        ...request.body,
      }));
      return sendSuccess(reply, 200, result);
    },
  );

  app.post<{ Headers: MutationHeaders; Params: EvidenceParams; Body: ReleasePermitBody }>(
    '/v1/evidence/:evidenceId/release-permits',
    { schema: { headers: MutationHeadersSchema, params: EvidenceParamsSchema, body: ReleasePermitBodySchema } },
    async (request, reply) => {
      const actor = await actorResolver.resolve(request);
      requirePayments(actor);
      const result = await executeIdempotent(idempotency, request, actor, async () => {
        const current = await ledger.get(actor, request.params.evidenceId);
        return permitIssuer.issue(current, request.body);
      }, {
        resultTtlMs: (permit, completedAt) => Math.max(1, Date.parse(permit.expiresAt) - completedAt),
      });
      return sendSuccess(reply, 201, result);
    },
  );

  app.post<{ Headers: MutationHeaders; Body: GenericPermitBody }>('/v1/command-permits', {
    schema: { headers: MutationHeadersSchema, body: GenericPermitBodySchema },
  }, async (request, reply) => {
    const actor = await actorResolver.resolve(request);
    requirePayments(actor);
    const result = await executeIdempotent(idempotency, request, actor, async () =>
      permitIssuer.issueCommand(request.body), {
      resultTtlMs: (permit, completedAt) => Math.max(1, Date.parse(permit.expiresAt) - completedAt),
    });
    return sendSuccess(reply, 201, result);
  });

  app.setNotFoundHandler(async () => {
    throw new AppError('RESOURCE_NOT_FOUND');
  });
  app.setErrorHandler(async (error, request, reply) => {
    const record = typeof error === 'object' && error !== null ? error as Record<string, unknown> : {};
    const appError = error instanceof AppError
      ? error
      : record['validation'] !== undefined
        ? new AppError('SCHEMA_INVALID')
        : new AppError('INTERNAL_ERROR');
    if (appError.statusCode >= 500) {
      request.log.error({ requestId: request.id, code: appError.code }, 'request failed');
    }
    return reply.code(appError.statusCode).send(failure(appError, request.id));
  });
  app.addHook('onClose', async () => {
    await Promise.all([idempotency.close(), ledger.close()]);
  });
  await app.ready();
  return app;
}
