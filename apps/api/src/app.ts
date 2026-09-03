/**
 * The Fastify application.
 *
 * Authentication runs before every route except the health probe, errors are
 * normalised into one stable envelope, and logs are redacted so no bearer
 * token, signed URL or personal field can reach a log sink.
 */

import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify, { type FastifyInstance } from 'fastify';
import { loadConfig, type ApiConfig } from './config.js';
import { createContext, type AppContext, type ContextOverrides } from './context.js';
import { ApiError, unauthorized } from './errors.js';
import { registerRoutes } from './routes/index.js';

export interface BuildAppOptions {
  readonly logger?: boolean;
  readonly config?: ApiConfig;
  readonly context?: AppContext;
  readonly overrides?: ContextOverrides;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance & { context: AppContext }> {
  const config = options.config ?? options.context?.config ?? loadConfig();
  const context = options.context ?? createContext(config, options.overrides ?? {});

  const app = Fastify({
    // Deliberately generous: work submissions and compliance documents arrive
    // base64-encoded inside a JSON command envelope.
    bodyLimit: 32 * 1024 * 1024,
    trustProxy: false,
    requestIdHeader: 'x-request-id',
    logger: options.logger === false || options.logger === undefined
      ? false
      : {
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              'res.headers["set-cookie"]',
              'body.contentBase64',
              'body.documents',
            ],
            censor: '[REDACTED]',
          },
        },
  }).withTypeProvider<TypeBoxTypeProvider>();

  await app.register(helmet, { global: true, contentSecurityPolicy: false });
  await app.register(rateLimit, { global: true, max: 600, timeWindow: '1 minute' });

  app.addHook('onRequest', async (request) => {
    if (request.url.startsWith('/health/')) return;
    const header = request.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) throw unauthorized();
    request.principal = await context.auth.verify(header.slice('Bearer '.length));
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.detail === undefined ? {} : { detail: error.detail }),
          requestId: request.id,
        },
      });
    }
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    if (statusCode === 400 || statusCode === 429) {
      return reply.status(statusCode).send({
        error: {
          code: statusCode === 429 ? 'RATE_LIMITED' : 'BAD_REQUEST',
          message: statusCode === 429 ? 'Rate limit exceeded.' : String((error as Error).message),
          requestId: request.id,
        },
      });
    }
    request.log.error({ err: error }, 'Unhandled API error');
    if (process.env['OPTIWORK_DEBUG_ERRORS'] === 'true') {
      // Surfaces the underlying failure while developing; never enabled in a
      // hosted profile, where the stable envelope is all a client may see.
      process.stderr.write(`${String((error as Error).stack ?? error)}\n`);
    }
    return reply.status(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'Internal service error.', requestId: request.id },
    });
  });

  app.addHook('onClose', async () => {
    if (!options.context) await context.close();
  });

  await registerRoutes(app, context);
  return Object.assign(app, { context });
}
