import helmet from '@fastify/helmet';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { HealthResponseSchema, type HealthResponse } from '@optiwork/contracts';
import Fastify, { type FastifyInstance } from 'fastify';

export interface BuildAppOptions {
  readonly logger?: boolean;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    requestIdHeader: 'x-request-id',
  }).withTypeProvider<TypeBoxTypeProvider>();

  await app.register(helmet);

  app.get(
    '/health/live',
    {
      schema: {
        response: { 200: HealthResponseSchema },
      },
    },
    async (): Promise<HealthResponse> => ({
      name: 'optiwork-api',
      status: 'ok',
      version: '0.1.0',
      profile: 'demo',
    }),
  );

  return app;
}
