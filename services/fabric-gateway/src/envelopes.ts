import type { FastifyReply } from 'fastify';
import type { AppError } from './errors.js';

export function success<T>(data: T) {
  return { success: true as const, data, error: null };
}

export function failure(error: AppError, requestId: string) {
  return {
    success: false as const,
    data: null,
    error: { code: error.code, message: error.message, requestId },
  };
}

export function sendSuccess<T>(reply: FastifyReply, statusCode: number, data: T): FastifyReply {
  return reply.code(statusCode).send(success(data));
}
